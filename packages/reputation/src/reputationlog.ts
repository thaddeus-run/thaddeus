import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { type Backend, decodeRecord, encodeRecord } from '@thaddeus.run/store';

import {
  type Contribution,
  type ContributionKind,
  type Verification,
  verifyContribution,
} from './contribution';

// A gathered, verified profile. Reputation IS this record set, not a number:
// `attested` is the trustworthy set (a host vouched for it), `claimed` is
// self-asserted but unattested, and byKind counts only the attested records.
export interface Profile {
  readonly subject: string;
  readonly attested: readonly Contribution[];
  readonly claimed: readonly Contribution[];
  readonly byKind: Readonly<Record<ContributionKind, number>>;
}

// A total key over every field, so dedup is on full content (not on a sig that a
// forged record could reuse). Uint8Arrays encode as plain number arrays so the
// key is stable and JSON-encodable.
function contentKey(c: Contribution): string {
  return JSON.stringify([
    c.subject,
    c.host,
    c.repo,
    c.ref,
    c.kind,
    c.at,
    Array.from(c.subj_sig),
    Array.from(c.host_sig),
  ]);
}

// Deterministic order: (at, ref, kind), then the full content key as a tiebreak.
function byOrder(a: Contribution, b: Contribution): number {
  const ka = `${a.at}|${a.ref}|${a.kind}`;
  const kb = `${b.at}|${b.ref}|${b.kind}`;
  if (ka !== kb) {
    return ka < kb ? -1 : 1;
  }
  const ca = contentKey(a);
  const cb = contentKey(b);
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

// The untrusted aggregator: an indexer over signed records gathered from
// anywhere. Keep-and-label — every record is kept regardless of validity, and
// the verifier checks signatures itself. Durable when constructed with a
// `Backend` (write-through + static `load`); in-memory otherwise. Held once
// server-wide (reputation spans repos), so its records live under a top-level
// `rep/` prefix, not a per-repo scope. Spike — single process, not
// concurrency-safe.
export class ReputationLog {
  readonly #backend: Backend | undefined;
  readonly #records: Map<string, Contribution> = new Map();

  constructor(backend?: Backend) {
    this.#backend = backend;
  }

  // Rebuild a durable log from a backend. Records are content-addressed and
  // keep-and-label, so a torn/old-version record that fails to decode is skipped
  // (never surfaced), mirroring ProvenanceLog.load / VetoLog.load.
  static async load(backend: Backend): Promise<ReputationLog> {
    const log = new ReputationLog(backend);
    for (const key of await backend.list('rep/')) {
      const bytes = await backend.get(key);
      if (bytes === undefined) {
        continue;
      }
      try {
        const c = decodeRecord(bytes) as Contribution;
        log.#records.set(contentKey(c), c);
      } catch {
        continue; // torn/old-version/corrupt record — skip, never surface
      }
    }
    return log;
  }

  // Ingest a record, keep it regardless of validity, idempotent on full content.
  append(c: Contribution): void {
    this.#records.set(contentKey(c), c);
  }

  // Durably ingest a record (keep-and-label). Write-through first so a failed
  // backend write leaves no visible-but-non-durable record; then keep in memory.
  // Idempotent (content-addressed key).
  async ingest(c: Contribution): Promise<void> {
    await this.#persist(c);
    this.#records.set(contentKey(c), c);
  }

  // Write-through for a record (no-op without a backend). Content-addressed key
  // `rep/<blake3(contentKey)>`: write-once, so re-persisting an identical record
  // is idempotent and dedup stays consistent with the in-memory map.
  async #persist(c: Contribution): Promise<void> {
    if (this.#backend !== undefined) {
      const key = `rep/${bytesToHex(
        blake3(new TextEncoder().encode(contentKey(c)))
      )}`;
      await this.#backend.put(key, encodeRecord(c));
    }
  }

  // Every known record bearing `subject` (any validity), deterministic order.
  forSubject(subject: string): readonly Contribution[] {
    return [...this.#records.values()]
      .filter((c) => c.subject === subject)
      .sort(byOrder);
  }

  // Check a record's two signatures against the dids it carries. This is
  // membership-agnostic BY DESIGN — it does NOT require `c` to have been
  // appended to this log. That is the whole federation property: any holder
  // verifies a record from the dids alone, with no trust in (or membership of)
  // any aggregator. A convenience delegate to the exported `verifyContribution`.
  verify(c: Contribution): Verification {
    return verifyContribution(c);
  }

  // Partition `subject`'s records: attested (authentic ∧ attested), claimed
  // (authentic ∧ ¬attested); non-authentic records are dropped (not the
  // subject's claim). byKind counts the attested set.
  profile(subject: string): Profile {
    const attested: Contribution[] = [];
    const claimed: Contribution[] = [];
    const byKind: Record<ContributionKind, number> = {
      merge: 0,
      review: 0,
      release: 0,
    };
    for (const c of this.forSubject(subject)) {
      const v = verifyContribution(c);
      if (!v.authentic) {
        continue;
      }
      if (v.attested) {
        attested.push(c);
        byKind[c.kind] += 1;
      } else {
        claimed.push(c);
      }
    }
    return { subject, attested, claimed, byKind };
  }
}
