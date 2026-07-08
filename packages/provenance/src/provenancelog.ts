import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import type { Identity } from '@thaddeus.run/identity';
import type { Op } from '@thaddeus.run/log';
import {
  type Backend,
  decodeRecord,
  encodeRecord,
  type Ref,
  type Store,
} from '@thaddeus.run/store';

import {
  type Provenance,
  signProvenance,
  verifyProvenance,
} from './provenance';

// The render-time trust label. `unverified` covers both unsigned and
// signature-invalid records (the brief's trust rule).
export type ProvenanceStatus = 'verified' | 'unverified';

// Registry of provenance keyed by Op.id. Durable when constructed with a
// `Backend` (write-through + static `load`); in-memory otherwise. Unlike OpLog,
// an invalid record is KEPT and labelled `unverified` rather than rejected: an
// unverifiable "why" poisons nothing — it is just a claim to disbelieve. Spike —
// not concurrency-safe, single process.
export class ProvenanceLog {
  readonly #store: Store;
  readonly #backend: Backend | undefined;
  readonly #byOp: Map<string, Provenance[]> = new Map();

  constructor(store: Store, backend?: Backend) {
    this.#store = store;
    this.#backend = backend;
  }

  // Rebuild a durable log from a backend. Records are content-addressed and
  // keep-and-label, so a torn/old-version record that fails to decode is skipped
  // (never surfaced as truth), mirroring OpLog.load / MemoryStore.open.
  static async load(store: Store, backend: Backend): Promise<ProvenanceLog> {
    const log = new ProvenanceLog(store, backend);
    for (const key of await backend.list('prov/')) {
      const bytes = await backend.get(key);
      if (bytes === undefined) {
        continue;
      }
      try {
        log.#insert(decodeRecord(bytes) as Provenance);
      } catch {
        continue; // torn/old-version/corrupt record — skip, never surface
      }
    }
    return log;
  }

  // Build + sign provenance for `op`. If `prompt` bytes are given, store them as
  // a capability-gated object (granted to `actor`) and bind them by hash; the
  // record carries prompt_ref = blake3(prompt) and the store Ref. Records the
  // result and returns it.
  async record(
    op: Op,
    fields: {
      intent: string;
      reasoning: string;
      actorKind: string;
      task?: string;
      prompt?: Uint8Array;
    },
    actor: Identity
  ): Promise<Provenance> {
    let prompt: Ref | null = null;
    let promptRef: string | null = null;
    if (fields.prompt !== undefined) {
      // Snapshot the caller-owned bytes once: both the stored object and the
      // signed hash must derive from the SAME immutable data. Hashing
      // `fields.prompt` separately after the await would let a caller mutate the
      // buffer between store.put and blake3, diverging prompt_ref from what was
      // actually stored and silently breaking the hash binding.
      const bytes = fields.prompt.slice();
      promptRef = bytesToHex(blake3(bytes));
      prompt = await this.#store.put(bytes, actor);
    }
    const p = signProvenance(
      {
        op: op.id,
        actor_kind: fields.actorKind,
        intent: fields.intent,
        reasoning: fields.reasoning,
        task: fields.task ?? null,
        prompt_ref: promptRef,
        prompt,
      },
      actor
    );
    this.#insert(p);
    await this.#persist(p);
    return p;
  }

  // Durably ingest a provenance record from a peer/the wire (the server's
  // verify-nothing keep-and-label path). Write-through first so a failed backend
  // write leaves no visible-but-non-durable record; then keep-and-label in
  // memory. Idempotent (content-addressed key).
  async ingest(p: Provenance): Promise<void> {
    await this.#persist(p);
    this.#insert(p);
  }

  // Ingest a provenance record from a peer, IN-MEMORY only (no persistence).
  // KEEPS it regardless of validity so it can be rendered `unverified`.
  append(p: Provenance): void {
    this.#insert(p);
  }

  // Write-through for a record (no-op without a backend). Content-addressed key
  // `prov/<blake3(contentKey)>`: write-once, so re-persisting an identical record
  // is idempotent and dedup stays consistent with the in-memory #insert.
  async #persist(p: Provenance): Promise<void> {
    if (this.#backend !== undefined) {
      const key = `prov/${bytesToHex(
        blake3(new TextEncoder().encode(this.#contentKey(p)))
      )}`;
      await this.#backend.put(key, encodeRecord(p));
    }
  }

  // A total identity key over EVERY field of a record. Dedup keys on this, not
  // on (actor, sig): a forged record reusing a genuine record's signature
  // (`{ ...valid, reasoning: 'forged' }` keeps valid.sig) differs in body, so it
  // gets a distinct key and is kept alongside the genuine one — each rendered on
  // its own merits. Keying on (actor, sig) would let whichever arrived first win
  // and silently drop the other, so a peer could suppress a genuine record by
  // pre-empting it with a same-sig forgery (never throws — append must not).
  #contentKey(p: Provenance): string {
    return JSON.stringify([
      p.op,
      p.actor,
      p.actor_kind,
      p.intent,
      p.reasoning,
      p.task,
      p.prompt_ref,
      p.prompt === null ? null : [p.prompt.id, p.prompt.plaintext_id],
      bytesToHex(p.sig),
    ]);
  }

  // Store a record under its op id, deduped on full content so re-appending the
  // identical record is a no-op while any distinct record is kept.
  #insert(p: Provenance): void {
    const list = this.#byOp.get(p.op) ?? [];
    const key = this.#contentKey(p);
    const dup = list.some((e) => this.#contentKey(e) === key);
    if (!dup) {
      list.push(p);
      this.#byOp.set(p.op, list);
    }
  }

  // All provenance records known for an op id, in a deterministic order (by
  // actor, then signature bytes, then full content) independent of insertion
  // order. The content tiebreak keeps the order total even for two records that
  // share an (actor, sig) but differ in body (a genuine record and a same-sig
  // forgery).
  forOp(opId: string): readonly Provenance[] {
    return [...(this.#byOp.get(opId) ?? [])].sort((a, b) => {
      if (a.actor !== b.actor) {
        return a.actor < b.actor ? -1 : 1;
      }
      const sa = bytesToHex(a.sig);
      const sb = bytesToHex(b.sig);
      if (sa !== sb) {
        return sa < sb ? -1 : 1;
      }
      const ka = this.#contentKey(a);
      const kb = this.#contentKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  // Signature integrity over the bound op id. Whether that op actually exists is
  // the log's concern, not this check.
  verify(p: Provenance): boolean {
    return verifyProvenance(p);
  }

  // The render-time trust label: verified iff the signature checks out.
  status(p: Provenance): ProvenanceStatus {
    return verifyProvenance(p) ? 'verified' : 'unverified';
  }
}
