import { type Identity, PublicIdentity } from '@thaddeus.run/identity';

// The kinds of contribution a profile aggregates.
export type ContributionKind = 'merge' | 'review' | 'release';

// The signable, non-derived fields of a contribution.
export interface ContributionFields {
  readonly repo: string; // where it lived, e.g. "forgejo.example/acme/web"
  readonly ref: string; // the op/snapshot id it refers to
  readonly kind: ContributionKind;
  readonly at: string; // ISO 8601 timestamp
}

// A dual-signed contribution. subject/host dids are derived from the two signing
// identities; subj_sig is the subject's self-claim, host_sig is the instance's
// attestation that it happened there.
export interface Contribution extends ContributionFields {
  readonly subject: string; // = subject.did
  readonly host: string; // = host.did
  readonly subj_sig: Uint8Array;
  readonly host_sig: Uint8Array;
}

// Two independent truths a verifier checks for itself — no trust in any server.
export interface Verification {
  readonly authentic: boolean; // subj_sig valid for `subject`
  readonly attested: boolean; // host_sig valid for `host`
}

// Domain tag prefixed into the signed tuple so a contribution signature can
// never be confused with an op (thaddeus.log.op.v1) or provenance
// (thaddeus.provenance.v1) signature.
const CONTRIBUTION_DOMAIN = 'thaddeus.contribution.v1';

// The full signable core, with the derived dids included.
type ContributionCore = ContributionFields & {
  readonly subject: string;
  readonly host: string;
};

// Reject non-canonical field values before they are signed. Mirrors op.ts /
// provenance.ts: a required field that is empty or the wrong type throws, so
// verifyContribution (try/catch) rejects such records and signContribution
// fails fast on bad input.
function assertCanonical(core: ContributionCore): void {
  const required: [string, unknown][] = [
    ['subject', core.subject],
    ['host', core.host],
    ['repo', core.repo],
    ['ref', core.ref],
    ['at', core.at],
  ];
  for (const [name, value] of required) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`contribution.${name} must be a non-empty string`);
    }
  }
  if (
    core.kind !== 'merge' &&
    core.kind !== 'review' &&
    core.kind !== 'release'
  ) {
    throw new TypeError(
      "contribution.kind must be 'merge', 'review', or 'release'"
    );
  }
}

// Deterministic bytes the host's signature covers: the domain tag followed by
// all six core fields (subject, host, repo, ref, kind, at) in a fixed order.
// The host attests to all six fields, including who the subject claims to be.
// Throws on non-canonical input.
export function canonicalContribution(core: ContributionCore): Uint8Array {
  assertCanonical(core);
  return new TextEncoder().encode(
    JSON.stringify([
      CONTRIBUTION_DOMAIN,
      core.subject,
      core.host,
      core.repo,
      core.ref,
      core.kind,
      core.at,
    ])
  );
}

// Deterministic bytes the subject's signature covers: the domain tag followed
// by the five fields that belong to the subject's self-claim (subject, repo,
// ref, kind, at). `host` is deliberately excluded so that verifyContribution
// can check authentic independently of the host field — a malformed or swapped
// host did must not zero the subject's claim.
function canonicalSubjContribution(core: ContributionCore): Uint8Array {
  assertCanonical(core);
  return new TextEncoder().encode(
    JSON.stringify([
      CONTRIBUTION_DOMAIN,
      core.subject,
      core.repo,
      core.ref,
      core.kind,
      core.at,
    ])
  );
}

// Build a dual-signed contribution: the subject signs the five-field core
// (without host) and the host signs the full six-field core, their dids derived
// from the identities they signed with.
export function signContribution(
  fields: ContributionFields,
  subject: Identity,
  host: Identity
): Contribution {
  const core: ContributionCore = {
    ...fields,
    subject: subject.did,
    host: host.did,
  };
  const subjBytes = canonicalSubjContribution(core);
  const hostBytes = canonicalContribution(core);
  return {
    ...fields,
    subject: subject.did,
    host: host.did,
    subj_sig: subject.sign(subjBytes),
    host_sig: host.sign(hostBytes),
  };
}

// Verify one signature under a did, fail-soft: a malformed did or wrong-length
// sig yields false rather than throwing.
function verifyOne(did: string, bytes: Uint8Array, sig: Uint8Array): boolean {
  try {
    return PublicIdentity.fromDid(did).verify(bytes, sig);
  } catch {
    return false;
  }
}

// Verify a contribution from its own fields + dids — no trust in any server.
// authentic and attested are checked independently so a malformed did on one
// side does not zero the other. Non-canonical fields render both false.
export function verifyContribution(c: Contribution): Verification {
  let subjBytes: Uint8Array;
  let hostBytes: Uint8Array;
  try {
    subjBytes = canonicalSubjContribution(c);
    hostBytes = canonicalContribution(c);
  } catch {
    return { authentic: false, attested: false };
  }
  return {
    authentic: verifyOne(c.subject, subjBytes, c.subj_sig),
    attested: verifyOne(c.host, hostBytes, c.host_sig),
  };
}
