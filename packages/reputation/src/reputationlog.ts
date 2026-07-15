import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { type Backend, decodeRecord, encodeRecord } from '@thaddeus.run/store';

import {
  compareContributions,
  contributionContentKey,
  encodeReputationArchive,
  normalizeReputationArchive,
  REPUTATION_ARCHIVE_FORMAT,
  type ReputationArchive,
  type ReputationImportResult,
} from './archive';
import {
  type Contribution,
  type ContributionKind,
  type Verification,
  verifyContribution,
} from './contribution';

// A gathered, verified profile. Reputation IS this record set, not a number:
// `attested` retains every proof from an allowed host, while `counted` selects
// one proof per semantic event. Gates and byKind use only the counted events.
export interface Profile {
  readonly subject: string;
  readonly attested: readonly Contribution[];
  readonly counted: readonly Contribution[];
  readonly untrusted: readonly Contribution[];
  readonly claimed: readonly Contribution[];
  readonly byKind: Readonly<Record<ContributionKind, number>>;
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
        log.#records.set(contributionContentKey(c), c);
      } catch {
        continue; // torn/old-version/corrupt record — skip, never surface
      }
    }
    for (const key of await backend.list('rep-import/')) {
      const bytes = await backend.get(key);
      if (bytes === undefined) continue;
      try {
        const archive = normalizeReputationArchive(
          decodeRecord(bytes) as ReputationArchive
        );
        for (const c of archive.contributions) {
          log.#records.set(contributionContentKey(c), c);
        }
      } catch {
        continue; // corrupt or old import archive — skip the whole batch
      }
    }
    return log;
  }

  // Ingest a record, keep it regardless of validity, idempotent on full content.
  append(c: Contribution): void {
    this.#records.set(contributionContentKey(c), c);
  }

  // Durably ingest a record (keep-and-label). Write-through first so a failed
  // backend write leaves no visible-but-non-durable record; then keep in memory.
  // Idempotent (content-addressed key).
  async ingest(c: Contribution): Promise<void> {
    await this.#persist(c);
    this.#records.set(contributionContentKey(c), c);
  }

  // Write-through for a record (no-op without a backend). Content-addressed key
  // `rep/<blake3(contentKey)>`: write-once, so re-persisting an identical record
  // is idempotent and dedup stays consistent with the in-memory map.
  async #persist(c: Contribution): Promise<void> {
    if (this.#backend !== undefined) {
      const key = `rep/${bytesToHex(
        blake3(new TextEncoder().encode(contributionContentKey(c)))
      )}`;
      await this.#backend.put(key, encodeRecord(c));
    }
  }

  // Every known record bearing `subject` (any validity), deterministic order.
  forSubject(subject: string): readonly Contribution[] {
    return [...this.#records.values()]
      .filter((c) => c.subject === subject)
      .sort(compareContributions);
  }

  // Export every genuine dual-signed proof for the subject. Host trust is a
  // destination policy, so it deliberately does not filter this portable set.
  archive(subject: string): ReputationArchive {
    return normalizeReputationArchive({
      format: REPUTATION_ARCHIVE_FORMAT,
      subject,
      contributions: this.forSubject(subject).filter((c) => {
        const v = verifyContribution(c);
        return v.authentic && v.attested;
      }),
    });
  }

  /** Streams genuine dual-signed proofs without building a subject-wide array. */
  *iterateArchiveContributions(
    subject: string
  ): IterableIterator<Contribution> {
    for (const contribution of this.#records.values()) {
      if (contribution.subject !== subject) continue;
      const verification = verifyContribution(contribution);
      if (verification.authentic && verification.attested) {
        yield contribution;
      }
    }
  }

  // Strictly validate first, then persist only the missing delta in one backend
  // write. Memory changes happen last, so a failed write exposes no partial set.
  async ingestArchive(
    archive: ReputationArchive
  ): Promise<ReputationImportResult> {
    const normalized = normalizeReputationArchive(archive);
    const missing = normalized.contributions.filter(
      (c) => !this.#records.has(contributionContentKey(c))
    );
    const duplicates = normalized.contributions.length - missing.length;
    if (missing.length === 0) return { imported: 0, duplicates };

    const delta: ReputationArchive = { ...normalized, contributions: missing };
    if (this.#backend !== undefined) {
      const encoded = encodeReputationArchive(delta);
      const key = `rep-import/${bytesToHex(
        blake3(new TextEncoder().encode(encoded))
      )}`;
      await this.#backend.put(key, encodeRecord(delta));
    }
    for (const c of missing) {
      this.#records.set(contributionContentKey(c), c);
    }
    return { imported: missing.length, duplicates };
  }

  // Check a record's two signatures against the dids it carries. This is
  // membership-agnostic BY DESIGN — it does NOT require `c` to have been
  // appended to this log. That is the whole federation property: any holder
  // verifies a record from the dids alone, with no trust in (or membership of)
  // any aggregator. A convenience delegate to the exported `verifyContribution`.
  verify(c: Contribution): Verification {
    return verifyContribution(c);
  }

  // Partition `subject`'s records: attested (authentic ∧ trusted host),
  // untrusted (authentic ∧ unlisted host), and claimed (authentic without a
  // host). Invalid subject proofs are dropped. byKind counts unique events.
  profile(subject: string, trustedHosts: ReadonlySet<string>): Profile {
    const attested: Contribution[] = [];
    const counted: Contribution[] = [];
    const untrusted: Contribution[] = [];
    const claimed: Contribution[] = [];
    const byKind: Record<ContributionKind, number> = {
      merge: 0,
      review: 0,
      release: 0,
    };
    const countedEvents = new Set<string>();
    for (const c of this.forSubject(subject)) {
      const v = verifyContribution(c);
      if (!v.authentic) {
        continue;
      }
      if (v.attested) {
        if (trustedHosts.has(c.host)) {
          attested.push(c);
          const event = JSON.stringify([c.subject, c.repo, c.kind, c.ref]);
          if (!countedEvents.has(event)) {
            countedEvents.add(event);
            counted.push(c);
            byKind[c.kind] += 1;
          }
        } else {
          untrusted.push(c);
        }
      } else {
        claimed.push(c);
      }
    }
    return { subject, attested, counted, untrusted, claimed, byKind };
  }
}
