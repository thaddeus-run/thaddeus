import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import type { Identity } from '@thaddeus.run/identity';
import type { Op } from '@thaddeus.run/log';
import type { Ref, Store } from '@thaddeus.run/store';

import {
  type Provenance,
  signProvenance,
  verifyProvenance,
} from './provenance';

// The render-time trust label. `unverified` covers both unsigned and
// signature-invalid records (the brief's trust rule).
export type ProvenanceStatus = 'verified' | 'unverified';

// In-memory registry of provenance keyed by Op.id. Spike — not durable, not
// concurrency-safe, single process. Unlike OpLog, an invalid record is KEPT and
// labelled `unverified` rather than rejected: an unverifiable "why" poisons
// nothing — it is just a claim to disbelieve.
export class ProvenanceLog {
  readonly #store: Store;
  readonly #byOp: Map<string, Provenance[]> = new Map();

  constructor(store: Store) {
    this.#store = store;
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
      prompt = await this.#store.put(fields.prompt, actor);
      promptRef = bytesToHex(blake3(fields.prompt));
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
    return p;
  }

  // Ingest a provenance record from a peer. KEEPS it regardless of validity so
  // it can be rendered `unverified`. Idempotent on (op, actor, sig).
  append(p: Provenance): void {
    this.#insert(p);
  }

  // Store a record under its op id, deduped by (actor, sig).
  #insert(p: Provenance): void {
    const list = this.#byOp.get(p.op) ?? [];
    const sigHex = bytesToHex(p.sig);
    const dup = list.some(
      (e) => e.actor === p.actor && bytesToHex(e.sig) === sigHex
    );
    if (!dup) {
      list.push(p);
      this.#byOp.set(p.op, list);
    }
  }

  // All provenance records known for an op id, in a deterministic order
  // (by actor, then signature bytes) independent of insertion order.
  forOp(opId: string): readonly Provenance[] {
    return [...(this.#byOp.get(opId) ?? [])].sort((a, b) => {
      if (a.actor !== b.actor) {
        return a.actor < b.actor ? -1 : 1;
      }
      const sa = bytesToHex(a.sig);
      const sb = bytesToHex(b.sig);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
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
