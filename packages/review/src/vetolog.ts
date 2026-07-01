import { bytesToHex } from '@noble/hashes/utils';
import type { Identity } from '@thaddeus.run/identity';
import type { Op } from '@thaddeus.run/log';

import { signVeto, verifyVeto, type Veto } from './veto';

// The render-time trust label. `unverified` covers both unsigned and
// signature-invalid vetoes (a forged veto must not silently deny service).
export type VetoStatus = 'verified' | 'unverified';

// In-memory registry of vetoes keyed by Op.id. Spike — not durable, not
// concurrency-safe, single process. Store-free (like ReputationLog): a veto
// carries no capability-gated payload. Unlike OpLog, an invalid veto is KEPT and
// labelled `unverified` rather than rejected — the land policy simply never
// counts it, and a reader still sees the disputed claim.
export class VetoLog {
  readonly #byOp: Map<string, Veto[]> = new Map();

  // Build + sign a veto for `op` and record it. `at` is the caller's timestamp
  // (ISO 8601); the log takes no clock so it stays deterministic and testable.
  record(
    op: Op,
    fields: { reason: string; at: string },
    reviewer: Identity
  ): Veto {
    const v = signVeto(
      { op: op.id, reason: fields.reason, at: fields.at },
      reviewer
    );
    this.#insert(v);
    return v;
  }

  // Ingest a veto from a peer. KEEPS it regardless of validity so it can be
  // rendered `unverified`. Idempotent on the full record content.
  append(v: Veto): void {
    this.#insert(v);
  }

  // A total identity key over EVERY field of a veto. Dedup keys on this, not on
  // (reviewer, sig): a forged veto reusing a genuine veto's signature differs in
  // body, so it gets a distinct key and is kept alongside the genuine one — each
  // rendered on its own merits. Keying on (reviewer, sig) would let whichever
  // arrived first win and silently drop the other (never throws — append must
  // not).
  #contentKey(v: Veto): string {
    return JSON.stringify([
      v.op,
      v.reviewer,
      v.reason,
      v.at,
      bytesToHex(v.sig),
    ]);
  }

  // Store a veto under its op id, deduped on full content so re-appending the
  // identical record is a no-op while any distinct record is kept.
  #insert(v: Veto): void {
    const list = this.#byOp.get(v.op) ?? [];
    const key = this.#contentKey(v);
    const dup = list.some((e) => this.#contentKey(e) === key);
    if (!dup) {
      list.push(v);
      this.#byOp.set(v.op, list);
    }
  }

  // All vetoes known for an op id, in a deterministic order (by reviewer, then
  // signature bytes, then full content) independent of insertion order. The
  // content tiebreak keeps the order total even for two records that share a
  // (reviewer, sig) but differ in body (a genuine veto and a same-sig forgery).
  forOp(opId: string): readonly Veto[] {
    return [...(this.#byOp.get(opId) ?? [])].sort((a, b) => {
      if (a.reviewer !== b.reviewer) {
        return a.reviewer < b.reviewer ? -1 : 1;
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
  verify(v: Veto): boolean {
    return verifyVeto(v);
  }

  // The render-time trust label: verified iff the signature checks out.
  status(v: Veto): VetoStatus {
    return verifyVeto(v) ? 'verified' : 'unverified';
  }
}
