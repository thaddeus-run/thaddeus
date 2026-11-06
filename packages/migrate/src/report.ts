import { digest } from './codec';
import type { Consent, ConsentSource } from './consent';
import type { EvidenceRecord, VerifiedEvidence } from './evidence';

export const REPORT_FORMAT = 'thaddeus.migration-report.v1';

export interface ReportVersion {
  readonly version: number;
  // The source head record this version reproduces.
  readonly head: string;
  readonly revision: string;
  readonly files: number;
}

/**
 * What a verification established, with no timestamps or other run-specific
 * fields, so two checks of the same migration produce the same report.
 */
export interface Report {
  readonly format: typeof REPORT_FORMAT;
  readonly consent: string;
  readonly source: ConsentSource;
  readonly target: {
    readonly service: string;
    readonly tenant: string;
    readonly repo: string;
  };
  readonly views: readonly {
    readonly view: string;
    readonly versions: readonly ReportVersion[];
  }[];
  // Distinct (path, content) pairs across every migrated version.
  readonly files: number;
  readonly bytes: number;
  // Digest of every (path, content id, size), sorted.
  readonly inventory: string;
  // Digest of every stored evidence record's kind and content key, sorted.
  readonly evidence: string;
}

/** The digest of an evidence set: every record's kind and content key, sorted. */
export function evidenceDigest(records: readonly EvidenceRecord[]): string {
  return digest(
    'thaddeus.migrate.evidence-index.v1',
    JSON.stringify(records.map((r) => `${r.kind}/${r.key}`))
  );
}

/** Builds the deterministic report from checked evidence and file sizes. */
export function buildReport(
  consent: Consent,
  verified: VerifiedEvidence,
  sizes: ReadonlyMap<string, number>,
  evidence: string
): Report {
  const inventory: [string, string, number][] = [];
  let bytes = 0;
  for (const file of verified.files) {
    const size = sizes.get(`${file.path}\0${file.contentId}`) ?? -1;
    inventory.push([file.path, file.contentId, size]);
    bytes += size;
  }
  return {
    format: REPORT_FORMAT,
    consent: consent.id,
    source: consent.source,
    target: {
      service: consent.service,
      tenant: consent.tenant,
      repo: consent.repo,
    },
    views: verified.views.map((view) => ({
      view: view.view,
      versions: view.history.map((v) => ({
        version: v.version,
        head: v.head,
        revision: v.revision,
        files: v.entries.length,
      })),
    })),
    files: verified.files.length,
    bytes,
    inventory: digest(
      'thaddeus.migrate.inventory.v1',
      JSON.stringify(inventory)
    ),
    evidence,
  };
}
