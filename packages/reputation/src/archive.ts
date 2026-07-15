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

export interface ReputationArchiveDecodeLimits {
  readonly maxBytes?: number;
  readonly maxContributions?: number;
  readonly maxFieldBytes?: number;
}

export type ReputationArchiveLimitCode =
  | 'archive_too_large'
  | 'contribution_limit_exceeded'
  | 'field_too_large';

/** Structured pre-verification failure for server-enforced archive limits. */
export class ReputationArchiveLimitError extends RangeError {
  readonly code: ReputationArchiveLimitCode;
  readonly limit: number;

  constructor(code: ReputationArchiveLimitCode, limit: number) {
    super(code);
    this.name = 'ReputationArchiveLimitError';
    this.code = code;
    this.limit = limit;
  }
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

export function decodeReputationArchive(
  json: string,
  limits: ReputationArchiveDecodeLimits = {}
): ReputationArchive {
  validateDecodeLimit('maxBytes', limits.maxBytes);
  validateDecodeLimit('maxContributions', limits.maxContributions);
  validateDecodeLimit('maxFieldBytes', limits.maxFieldBytes);
  if (
    limits.maxBytes !== undefined &&
    new TextEncoder().encode(json).length > limits.maxBytes
  ) {
    throw new ReputationArchiveLimitError('archive_too_large', limits.maxBytes);
  }
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
  if (
    limits.maxContributions !== undefined &&
    parsed.contributions.length > limits.maxContributions
  ) {
    throw new ReputationArchiveLimitError(
      'contribution_limit_exceeded',
      limits.maxContributions
    );
  }
  if (limits.maxFieldBytes !== undefined) {
    assertFieldBytes(subject, limits.maxFieldBytes);
    for (const value of parsed.contributions) {
      if (!isRecord(value)) continue;
      for (const name of ['subject', 'host', 'repo', 'ref', 'kind', 'at']) {
        const field = value[name];
        if (typeof field === 'string') {
          assertFieldBytes(field, limits.maxFieldBytes);
        }
      }
    }
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

function validateDecodeLimit(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== 'number')
    throw new TypeError(`${name} must be a number`);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function assertFieldBytes(value: string, maxBytes: number): void {
  if (new TextEncoder().encode(value).length > maxBytes) {
    throw new ReputationArchiveLimitError('field_too_large', maxBytes);
  }
}
