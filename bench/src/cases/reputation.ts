import { Identity, ready } from '@thaddeus.run/identity';
import {
  type Contribution,
  decodeReputationArchive,
  encodeReputationArchive,
  REPUTATION_ARCHIVE_FORMAT,
  ReputationLog,
  signContribution,
} from '@thaddeus.run/reputation';

import type { BenchCase, RunExtra } from '../case';

// Reputation archive cases: export (collect a subject's proofs and encode
// them) and import (decode, verify and ingest them). The archive format is
// independent of any repository, so these ignore the fixture's ops; the
// fixture names are `tiny` and `small` only so the smoke tests can run them
// cheaply. The size is part of the case id, not the fixture.

// Archive sizes in contributions. `decodeReputationArchive` itself has no
// count limit unless one is passed; the server passes its
// DEFAULT_MAX_REPUTATION_CONTRIBUTIONS (4,096), which the last size is above.
// Import passes `maxContributions` explicitly, as a server that accepts big
// archives would, so the limit check is part of the timed decode.
const ARCHIVE_SIZES = [100, 1_000, 10_000] as const;

const FIXTURES = ['tiny', 'small'] as const;

const EPOCH_MS = Date.UTC(2026, 0, 1);

// Fixed identities, so every run signs the same claims with the same keys.
const SUBJECT_SEED = new Uint8Array(32).fill(1);
const HOST_SEED = new Uint8Array(32).fill(2);

// `count` dual-signed merge contributions for one subject, attested by one
// host. Each has its own ref and timestamp, so none is a duplicate of another
// and the archive really holds `count` entries.
function buildContributions(count: number): Contribution[] {
  const subject = Identity.fromSeed(SUBJECT_SEED);
  const host = Identity.fromSeed(HOST_SEED);
  const out: Contribution[] = [];
  for (let i = 0; i < count; i++) {
    const at = new Date(EPOCH_MS + i * 1_000)
      .toISOString()
      .replace('.000Z', 'Z');
    out.push(
      signContribution(
        { repo: 'bench', ref: `op-${i}`, kind: 'merge', at },
        subject,
        host
      )
    );
  }
  return out;
}

interface ExportState {
  log: ReputationLog;
  subject: string;
  count: number;
}

// Times `ReputationLog.archive` (verify every proof the subject holds) plus
// `encodeReputationArchive` (normalize, sort and render JSON). The log is
// filled in setup.
function exportCase(count: number): BenchCase<ExportState> {
  return {
    id: `reputation.export.${count}`,
    version: 1,
    suite: 'library',
    fixtures: FIXTURES,
    isolation: 'per-case',
    setup: async () => {
      await ready();
      const log = new ReputationLog();
      const contributions = buildContributions(count);
      for (const c of contributions) log.append(c);
      return { log, subject: contributions[0].subject, count };
    },
    run: (s): Promise<RunExtra> => {
      const archive = s.log.archive(s.subject);
      const json = encodeReputationArchive(archive);
      if (archive.contributions.length !== s.count) {
        throw new Error(
          `exported ${archive.contributions.length} of ${s.count} contributions`
        );
      }
      return Promise.resolve({ ops: s.count, bytes: json.length });
    },
  };
}

interface ImportState {
  json: string;
  count: number;
}

// Times `decodeReputationArchive` (with the limit raised to the archive's
// size) plus `ReputationLog.ingestArchive` into an empty log. The archive is
// encoded in setup. Each repeat makes its own empty log, so no repeat finds
// the contributions already imported; building one is a few empty maps.
function importCase(count: number): BenchCase<ImportState> {
  return {
    id: `reputation.import.${count}`,
    version: 1,
    suite: 'library',
    fixtures: FIXTURES,
    isolation: 'per-case',
    setup: async () => {
      await ready();
      const contributions = buildContributions(count);
      const json = encodeReputationArchive({
        format: REPUTATION_ARCHIVE_FORMAT,
        subject: contributions[0].subject,
        contributions,
      });
      return { json, count };
    },
    run: async (s): Promise<RunExtra> => {
      const archive = decodeReputationArchive(s.json, {
        maxContributions: s.count,
      });
      const result = await new ReputationLog().ingestArchive(archive);
      if (result.imported !== s.count) {
        throw new Error(`imported ${result.imported} of ${s.count}`);
      }
      return { ops: s.count, bytes: s.json.length };
    },
  };
}

const reputationCases: readonly BenchCase[] = [
  ...ARCHIVE_SIZES.map(exportCase),
  ...ARCHIVE_SIZES.map(importCase),
] as BenchCase[];

export default reputationCases;
