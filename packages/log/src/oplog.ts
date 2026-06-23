import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import type { Identity } from '@thaddeus.run/identity';
import type { Ref, Store } from '@thaddeus.run/store';

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
// snapshots are derived by materialize(). Spike — not durable, not concurrency
// safe, single process.
export class OpLog {
  readonly #store: Store;
  readonly #ops: Map<string, Op> = new Map();
  readonly #views: Map<string, string[]> = new Map();
  readonly #embargo: Map<
    string,
    { metaRef: Ref; token: string; revealed: boolean }
  > = new Map();

  constructor(store: Store) {
    this.#store = store;
  }

  // Record an edit: store the bytes as a capability-gated object, then append a
  // signed op extending `view`'s heads and advance the view to the new op.
  async write(
    view: string,
    path: string,
    bytes: Uint8Array,
    author: Identity,
    opts?: { embargoUntil?: string }
  ): Promise<Op> {
    const ref = await this.#store.put(bytes, author);
    const op = this.#appendLocal(view, path, ref, author);
    if (opts?.embargoUntil !== undefined) {
      await this.#embargoOp(op, opts.embargoUntil, author);
    }
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
  }

  // Ingest a signed op from a peer — the convergence entry point. Verifies the
  // signature/id, links it into the DAG, idempotent on op id. Views are NOT
  // moved: peer ops land in the graph; a view advances only on write/re-point.
  append(op: Op): void {
    if (!verifyOp(op)) {
      throw new Error(`refusing unverifiable op ${op.id}`);
    }
    if (!this.#ops.has(op.id)) {
      this.#ops.set(op.id, op);
    }
  }

  // The shared builder for write/remove: compute lamport from the view's heads,
  // sign, store, advance the view.
  #appendLocal(
    view: string,
    path: string,
    payload: Ref | null,
    author: Identity
  ): Op {
    const parents = this.heads(view);
    const lamport = this.#nextLamport(parents);
    const op = signOp({ path, parents, lamport, payload }, author);
    this.#ops.set(op.id, op);
    this.#views.set(view, [op.id]);
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
  async remove(view: string, path: string, author: Identity): Promise<Op> {
    return this.#appendLocal(view, path, null, author);
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
      const concurrent = ops.filter((a) =>
        ops.some(
          (b) =>
            a.id !== b.id &&
            !this.#isAncestor(a.id, b.id) &&
            !this.#isAncestor(b.id, a.id)
        )
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
