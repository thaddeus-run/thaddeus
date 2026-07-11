import { PublicIdentity } from '@thaddeus.run/identity';

import {
  type Contribution,
  type ContributionKind,
  verifyContribution,
} from './contribution';

export const REPUTATION_ARCHIVE_FORMAT = 'thaddeus.reputation.v1' as const;

// A user-held, versioned set of portable contribution proofs. Signatures stay
// Uint8Arrays in the package API; the JSON codec below renders them as base64.
export interface ReputationArchive {
  readonly format: typeof REPUTATION_ARCHIVE_FORMAT;
  readonly subject: string;
  readonly contributions: readonly Contribution[];
}

export interface ReputationImportResult {
  readonly imported: number;
  readonly duplicates: number;
}

interface WireContribution {
  readonly subject: string;
  readonly host: string;
  readonly repo: string;
  readonly ref: string;
  readonly kind: ContributionKind;
  readonly at: string;
  readonly subj_sig: string;
  readonly host_sig: string;
}

interface WireArchive {
  readonly format: typeof REPUTATION_ARCHIVE_FORMAT;
  readonly subject: string;
  readonly contributions: readonly WireContribution[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== 'string' || field.length === 0) {
    throw new TypeError(
      `reputation archive ${name} must be a non-empty string`
    );
  }
  return field;
}

// Buffer's base64 decoder is intentionally forgiving. Archives are not: the
// canonical re-encoding must equal the input so malformed spellings cannot
// produce several archive hashes for the same signature bytes.
function decodeCanonicalBase64(value: unknown, name: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`reputation archive ${name} must be base64`);
  }
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (Buffer.from(bytes).toString('base64') !== value) {
    throw new TypeError(`reputation archive ${name} must be canonical base64`);
  }
  return bytes;
}

// Stable full-content identity shared by archive normalization and the log.
export function contributionContentKey(c: Contribution): string {
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

// Deterministic order: (at, ref, kind), then all content as a tiebreak.
export function compareContributions(a: Contribution, b: Contribution): number {
  const ka = `${a.at}|${a.ref}|${a.kind}`;
  const kb = `${b.at}|${b.ref}|${b.kind}`;
  if (ka !== kb) return ka < kb ? -1 : 1;
  const ca = contributionContentKey(a);
  const cb = contributionContentKey(b);
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

function assertSubject(subject: string): void {
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new TypeError(
      'reputation archive subject must be a non-empty string'
    );
  }
  try {
    PublicIdentity.fromDid(subject);
  } catch {
    throw new TypeError('reputation archive subject must be a valid did:key');
  }
}

// Validate the entire archive before normalizing duplicates/order. This is the
// strict import boundary: only genuine two-party contribution proofs travel.
export function normalizeReputationArchive(
  archive: ReputationArchive
): ReputationArchive {
  if (archive.format !== REPUTATION_ARCHIVE_FORMAT) {
    throw new TypeError('unsupported reputation archive format');
  }
  assertSubject(archive.subject);
  if (!Array.isArray(archive.contributions)) {
    throw new TypeError('reputation archive contributions must be an array');
  }

  const unique = new Map<string, Contribution>();
  for (const contribution of archive.contributions) {
    if (!isRecord(contribution)) {
      throw new TypeError('reputation archive contribution must be an object');
    }
    if (!(contribution.subj_sig instanceof Uint8Array)) {
      throw new TypeError('reputation archive subj_sig must be bytes');
    }
    if (!(contribution.host_sig instanceof Uint8Array)) {
      throw new TypeError('reputation archive host_sig must be bytes');
    }
    const record = contribution as unknown as Contribution;
    if (record.subject !== archive.subject) {
      throw new TypeError('reputation archive contains a different subject');
    }
    const verification = verifyContribution(record);
    if (!verification.authentic || !verification.attested) {
      throw new TypeError(
        'reputation archive contributions must be authentic and host-attested'
      );
    }
    unique.set(contributionContentKey(record), record);
  }

  return {
    format: REPUTATION_ARCHIVE_FORMAT,
    subject: archive.subject,
    contributions: [...unique.values()].sort(compareContributions),
  };
}

function wireContribution(c: Contribution): WireContribution {
  return {
    subject: c.subject,
    host: c.host,
    repo: c.repo,
    ref: c.ref,
    kind: c.kind,
    at: c.at,
    subj_sig: Buffer.from(c.subj_sig).toString('base64'),
    host_sig: Buffer.from(c.host_sig).toString('base64'),
  };
}

export function encodeReputationArchive(archive: ReputationArchive): string {
  const normalized = normalizeReputationArchive(archive);
  const wire: WireArchive = {
    format: REPUTATION_ARCHIVE_FORMAT,
    subject: normalized.subject,
    contributions: normalized.contributions.map(wireContribution),
  };
  return `${JSON.stringify(wire, null, 2)}\n`;
}

export function decodeReputationArchive(json: string): ReputationArchive {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new TypeError('malformed reputation archive JSON');
  }
  if (!isRecord(parsed)) {
    throw new TypeError('reputation archive must be an object');
  }
  if (parsed.format !== REPUTATION_ARCHIVE_FORMAT) {
    throw new TypeError(
      `unsupported reputation archive: ${String(parsed.format)}`
    );
  }
  const subject = requiredString(parsed, 'subject');
  if (!Array.isArray(parsed.contributions)) {
    throw new TypeError('reputation archive contributions must be an array');
  }
  const contributions = parsed.contributions.map((value) => {
    if (!isRecord(value)) {
      throw new TypeError('reputation archive contribution must be an object');
    }
    return {
      subject: requiredString(value, 'subject'),
      host: requiredString(value, 'host'),
      repo: requiredString(value, 'repo'),
      ref: requiredString(value, 'ref'),
      kind: requiredString(value, 'kind') as ContributionKind,
      at: requiredString(value, 'at'),
      subj_sig: decodeCanonicalBase64(value.subj_sig, 'subj_sig'),
      host_sig: decodeCanonicalBase64(value.host_sig, 'host_sig'),
    } satisfies Contribution;
  });
  return normalizeReputationArchive({
    format: REPUTATION_ARCHIVE_FORMAT,
    subject,
    contributions,
  });
}
