import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import type { Identity } from '@thaddeus.run/identity';
import {
  type Backend,
  decodeRecord,
  encodeRecord,
  type Ref,
  type Store,
} from '@thaddeus.run/store';

import { type Op, signOp, verifyOp } from './op';

// Two concurrent ops on the same path — neither is the other's ancestor. LWW
// still yields a deterministic winner; content merge is deferred (spec §11).
export interface Conflict {
  readonly path: string;
  readonly ops: readonly string[];
  readonly winner: string;
}

// What a public mirror sees for an op. An embargoed op exposes only an opaque
// ordering token (enough to place it in sequence, naming nothing) plus a pointer
// to its capability-gated metadata, released at T via the membrane.
export type PublicOp =
  | { readonly kind: 'open'; readonly op: Op }
  | {
      readonly kind: 'embargoed';
      readonly id: string;
      readonly ordering_token: string;
      readonly sealed_meta: Ref;
    };

// In-memory operation log. The source of truth is the signed-op DAG; file
// snapshots are derived by materialize(). Durable when constructed with a
// Backend (write-through + static load). Spike — not concurrency-safe,
// single process.
export class OpLog {
  readonly #store: Store;
  readonly #ops: Map<string, Op> = new Map();
  readonly #views: Map<string, string[]> = new Map();
  readonly #embargo: Map<
    string,
    { metaRef: Ref; token: string; revealed: boolean }
  > = new Map();
  readonly #backend: Backend | undefined;

  constructor(store: Store, backend?: Backend) {
    this.#store = store;
    this.#backend = backend;
  }

  // Rebuild the op-DAG + views + embargo from a backend. Call AFTER
  // MemoryStore.open over the same scope (ops reference content the store holds).
  // A torn/old-version/corrupt record that fails to decode is skipped, never
  // surfaced as truth.
  static async load(store: Store, backend: Backend): Promise<OpLog> {
    const log = new OpLog(store, backend);
    for (const key of await backend.list('op/')) {
      const bytes = await backend.get(key);
      if (bytes === undefined) {
        continue;
      }
      let op: Op;
      try {
        op = decodeRecord(bytes) as Op;
      } catch {
        continue; // torn/old-version/corrupt record — skip, never surface as truth
      }
      if (!verifyOp(op)) {
        continue; // torn or tampered — never surface as truth
      }
      log.#ops.set(op.id, Object.freeze(op));
    }
    for (const key of await backend.list('view/')) {
      const bytes = await backend.get(key);
      if (bytes === undefined) {
        continue;
      }
      try {
        log.#views.set(
          key.slice('view/'.length),
          decodeRecord(bytes) as string[]
        );
      } catch {
        continue; // torn/old-version/corrupt record — skip, never surface as truth
      }
    }
    for (const key of await backend.list('embargo/')) {
      const bytes = await backend.get(key);
      if (bytes === undefined) {
        continue;
      }
      try {
        log.#embargo.set(
          key.slice('embargo/'.length),
          decodeRecord(bytes) as {
            metaRef: Ref;
            token: string;
            revealed: boolean;
          }
        );
      } catch {
        continue; // torn/old-version/corrupt record — skip, never surface as truth
      }
    }
    return log;
  }

  // Durable view re-point: in-memory set + write-through. Use this (not view())
  // for re-points that must survive a restart (e.g. landing onto `main`).
  // Without a backend it is exactly view().
  async repoint(name: string, heads: readonly string[]): Promise<void> {
    this.#views.set(name, [...heads]);
    if (this.#backend !== undefined) {
      await this.#backend.put(`view/${name}`, encodeRecord([...heads]));
    }
  }

  // Remove a named view from memory and durable storage. Ops and objects remain;
  // this only drops the branch/inspect name over a head-set.
  async dropView(name: string): Promise<void> {
    this.#views.delete(name);
    if (this.#backend !== undefined) {
      await this.#backend.delete(`view/${name}`);
    }
  }

  // Write-through for an op + its view (no-op without a backend).
  // NOTE: the two writes (op then view) are NOT atomic — a crash between them
  // leaves the op present in the backend but the view not yet advanced, which
  // load() surfaces as a recoverable trailing view (non-corrupting), per the
  // persistence spec's best-effort crash-consistency guarantee.
  async #persistCommit(view: string, op: Op): Promise<void> {
    if (this.#backend !== undefined) {
      await this.#backend.put(`op/${op.id}`, encodeRecord(op));
      await this.#backend.put(
        `view/${view}`,
        encodeRecord(this.#views.get(view) ?? [])
      );
    }
  }

  // Record an edit. Build → seal → commit: the op is signed but NOT placed in
  // the log until any embargo registration succeeds. So if #embargoOp throws —
  // a bad timestamp, or any future fallible store op — the op never enters the
  // log and can never be served as an open, public op. Fail-closed by
  // construction (no rollback to get wrong).
  async write(
    view: string,
    path: string,
    bytes: Uint8Array,
    author: Identity,
    opts?: { embargoUntil?: string; at?: string }
  ): Promise<Op> {
    const ref = await this.#store.put(bytes, author);
    const op = this.#sign(view, path, ref, author, opts?.at);
    if (opts?.embargoUntil !== undefined) {
      await this.#embargoOp(op, opts.embargoUntil, author);
    }
    this.#commit(view, op);
    await this.#persistCommit(view, op);
    return op;
  }

  // Seal an op's metadata as a second capability-gated object and schedule its
  // reveal at T. Only an opaque token + the sealed-meta pointer go public.
  async #embargoOp(op: Op, at: string, by: Identity): Promise<void> {
    const meta = new TextEncoder().encode(
      JSON.stringify({ ...op, sig: bytesToHex(op.sig) })
    );
    const metaRef = await this.#store.put(meta, by);
    await this.#store.scheduleReveal(metaRef, at, by);
    const token = bytesToHex(
      blake3(new TextEncoder().encode(`token:${op.id}`))
    );
    this.#embargo.set(op.id, { metaRef, token, revealed: false });
    if (this.#backend !== undefined) {
      await this.#backend.put(
        `embargo/${op.id}`,
        encodeRecord({ metaRef, token, revealed: false })
      );
    }
  }

  // Durably ingest a peer/pushed op (the server's verify-don't-trust path):
  // verifyOp (reject on failure), write through op/<id>, then append frozen.
  // Persist-first so a failed backend write leaves the op absent from the hot
  // map — no visible-but-non-durable state. Touches no view — views move only
  // via repoint/land.
  async ingest(op: Op): Promise<void> {
    if (!verifyOp(op)) {
      throw new TypeError(`refusing to ingest an unverifiable op: ${op.id}`);
    }
    if (this.#backend !== undefined) {
      await this.#backend.put(`op/${op.id}`, encodeRecord(op));
    }
    this.#ops.set(op.id, Object.freeze(op));
  }

  // Ingest a signed op from a peer — the convergence entry point. Verifies the
  // signature/id, links it into the DAG, idempotent on op id. Views are NOT
  // moved: peer ops land in the graph; a view advances only on write/re-point.
  // NOTE: append (peer ingest) is in-memory only; durably persisting
  // peer-delivered ops lands with the federation wire (deferred). Local writes
  // (write/remove) and re-points (repoint) are the persisted paths.
  append(op: Op): void {
    if (!verifyOp(op)) {
      throw new Error(`refusing unverifiable op ${op.id}`);
    }
    if (!this.#ops.has(op.id)) {
      this.#ops.set(op.id, op);
    }
  }

  // Build + sign an op extending `view`'s heads — no mutation, not yet placed.
  // `at` defaults to the current wall-clock; callers pin it for deterministic
  // tests. It is descriptive only — `lamport` + the DAG remain the ordering key.
  #sign(
    view: string,
    path: string,
    payload: Ref | null,
    author: Identity,
    at?: string
  ): Op {
    const parents = this.heads(view);
    const lamport = this.#nextLamport(parents);
    return signOp(
      { path, parents, lamport, at: at ?? new Date().toISOString(), payload },
      author
    );
  }

  // Place a built op into the DAG and advance its view. The commit step that
  // write() defers until after a successful embargo registration.
  #commit(view: string, op: Op): void {
    this.#ops.set(op.id, Object.freeze(op));
    this.#views.set(view, [op.id]);
  }

  // The shared builder for write/remove: build then immediately place.
  #appendLocal(
    view: string,
    path: string,
    payload: Ref | null,
    author: Identity,
    at?: string
  ): Op {
    const op = this.#sign(view, path, payload, author, at);
    this.#commit(view, op);
    return op;
  }

  // Root op (no parents) is lamport 0; otherwise 1 + max(parents.lamport).
  #nextLamport(parents: readonly string[]): number {
    if (parents.length === 0) {
      return 0;
    }
    return (
      1 + Math.max(...parents.map((id) => this.#ops.get(id)?.lamport ?? 0))
    );
  }

  // Create or re-point a named view. A view is just a name over a head-set —
  // not a copy of the tree.
  view(name: string, heads: readonly string[] = []): void {
    this.#views.set(name, [...heads]);
  }

  // Zero-copy branch: a new view whose heads start equal to fromView's heads.
  // Copies a handful of ids, never ops — so every agent can have its own view
  // for free (P6).
  fork(name: string, fromView: string): void {
    this.#views.set(name, [...this.heads(fromView)]);
  }

  // Every named view, sorted. A view is a name over a head-set, so this is the
  // branch list — callers filter any names they treat as internal.
  views(): readonly string[] {
    return [...this.#views.keys()].sort();
  }

  // Whether a view name is known (distinguishes "no such view" from a view that
  // exists but is empty — `heads()` returns [] for both).
  hasView(name: string): boolean {
    return this.#views.has(name);
  }

  // A view's heads, or — with no view — the global frontier: every op that is
  // no other known op's parent (the DAG's sink nodes), deterministic given the
  // op set.
  heads(view?: string): readonly string[] {
    if (view !== undefined) {
      return this.#views.get(view) ?? [];
    }
    const parented = new Set<string>();
    for (const op of this.#ops.values()) {
      for (const p of op.parents) {
        parented.add(p);
      }
    }
    return [...this.#ops.keys()].filter((id) => !parented.has(id));
  }

  // All ops in a deterministic total order: by lamport, then id as a tiebreak.
  ops(): readonly Op[] {
    return [...this.#ops.values()].sort((x, y) => {
      const byLamport = x.lamport - y.lamport;
      if (byLamport !== 0) {
        return byLamport;
      }
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });
  }

  // Project the log to a path → { ref, op } tree by LWW over the ancestor-
  // closure of the view's heads. Cleartext metadata only — the map holds Refs,
  // never plaintext, so it cannot leak a payload; read content via store.get.
  materialize(
    view?: string,
    as?: Identity
  ): Map<string, { ref: Ref | null; op: Op }> {
    const reachable = this.#ancestorClosure(this.heads(view));
    const ordered = this.ops().filter(
      (o) => reachable.has(o.id) && this.#placeable(o, as)
    );
    const tree = new Map<string, { ref: Ref | null; op: Op }>();
    for (const op of ordered) {
      if (op.payload === null) {
        tree.delete(op.path); // tombstone
      } else {
        tree.set(op.path, { ref: op.payload, op });
      }
    }
    return tree;
  }

  // An op is placeable if it is not embargoed/unrevealed, or if `as` holds a
  // served capability for its sealed metadata (checked synchronously via caps).
  #placeable(op: Op, as?: Identity): boolean {
    const e = this.#embargo.get(op.id);
    if (e === undefined || e.revealed) {
      return true;
    }
    if (as === undefined) {
      return false;
    }
    return this.#store
      .caps(e.metaRef.plaintext_id)
      .some((c) => c.grantee === as.did);
  }

  // Record a delete: a payload:null tombstone op extending the view's heads.
  async remove(
    view: string,
    path: string,
    author: Identity,
    opts?: { at?: string }
  ): Promise<Op> {
    const op = this.#appendLocal(view, path, null, author, opts?.at);
    await this.#persistCommit(view, op);
    return op;
  }

  // Surface same-path collisions among concurrent ops in a view's reachable set.
  // Two ops conflict when they share a path and neither is the other's ancestor.
  conflicts(view?: string): readonly Conflict[] {
    const reachable = this.#ancestorClosure(this.heads(view));
    const ordered = this.ops().filter((o) => reachable.has(o.id));
    const byPath = new Map<string, Op[]>();
    for (const op of ordered) {
      byPath.set(op.path, [...(byPath.get(op.path) ?? []), op]);
    }
    const out: Conflict[] = [];
    for (const [path, ops] of byPath) {
      const concurrent = ops
        .filter((a) =>
          ops.some(
            (b) =>
              a.id !== b.id &&
              !this.#isAncestor(a.id, b.id) &&
              !this.#isAncestor(b.id, a.id)
          )
        )
        // Drop ops superseded by a concurrent descendant on the same path, so
        // the reported set is the minimal concurrent frontier — not the
        // ancestors a later op already won over. (A chain a1→a2 plus a
        // concurrent d must report {a2, d}, never {a1, a2, d}.)
        .filter(
          (a, _i, kept) =>
            !kept.some((b) => a.id !== b.id && this.#isAncestor(a.id, b.id))
        );
      if (concurrent.length > 1) {
        // The LWW winner is the last in (lamport, id) order — `ordered` already
        // sorts that way, so the max-index concurrent op wins.
        const winner = concurrent.at(-1);
        if (winner !== undefined) {
          out.push({
            path,
            ops: concurrent.map((o) => o.id),
            winner: winner.id,
          });
        }
      }
    }
    return out;
  }

  // Verify a stored op's signature + id integrity. False if the id is unknown.
  verify(opId: string): boolean {
    const op = this.#ops.get(opId);
    return op !== undefined && verifyOp(op);
  }

  // The mirror's view of an op: the full op once open, else an opaque token.
  publicView(opId: string): PublicOp {
    const op = this.#ops.get(opId);
    if (op === undefined) {
      throw new Error(`unknown op ${opId}`);
    }
    const e = this.#embargo.get(opId);
    if (e === undefined || e.revealed) {
      return { kind: 'open', op };
    }
    return {
      kind: 'embargoed',
      id: op.id,
      ordering_token: e.token,
      sealed_meta: e.metaRef,
    };
  }

  // Fire the membrane key-release for an embargoed op at/after T. Returns true
  // if the metadata was released — after which public materialize places the op.
  async reveal(opId: string, now?: string): Promise<boolean> {
    const e = this.#embargo.get(opId);
    if (e === undefined) {
      return false;
    }
    const released = await this.#store.reveal(e.metaRef, now);
    if (released) {
      e.revealed = true;
      if (this.#backend !== undefined) {
        await this.#backend.put(`embargo/${opId}`, encodeRecord(e));
      }
    }
    return released;
  }

  // True if `ancestor` is in the ancestor-closure of `of` (or equal).
  #isAncestor(ancestor: string, of: string): boolean {
    return this.#ancestorClosure([of]).has(ancestor);
  }

  // Every op reachable from `heads` by walking parents (inclusive of heads).
  #ancestorClosure(heads: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...heads];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const op = this.#ops.get(id);
      if (op !== undefined) {
        stack.push(...op.parents);
      }
    }
    return seen;
  }
}
