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

// A subject's UNATTESTED claim: the subject-signed half of a contribution, with
// no host yet. A subject can mint this alone (it never needs the host key,
// because the subject core deliberately excludes `host`); an attesting instance
// then co-signs it with `attest` to produce a full, attested Contribution. This
// is how reputation travels the wire: the client ships a claim, the host (if it
// holds a key) attests on land.
export interface ContributionClaim extends ContributionFields {
  readonly subject: string; // = subject.did
  readonly subj_sig: Uint8Array;
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

// Reject non-canonical subject-claim fields (subject, repo, ref, at, kind) —
// the fields the subject's signature covers. Mirrors op.ts / provenance.ts: a
// required field that is empty or the wrong type throws. `host` is NOT checked
// here, so a bad host can never invalidate the subject's (host-independent)
// claim during verification.
function assertCanonicalSubject(core: ContributionCore): void {
  const required: [string, unknown][] = [
    ['subject', core.subject],
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

// The full host-core check: the subject fields plus a non-empty `host`. Used by
// the host canonical encoding and (transitively) by signContribution, so a
// record can never be MINTED with a bad host — only an externally-tampered host
// is tolerated fail-soft at verify time (and then only the attested side fails).
function assertCanonical(core: ContributionCore): void {
  assertCanonicalSubject(core);
  if (typeof core.host !== 'string' || core.host.length === 0) {
    throw new TypeError('contribution.host must be a non-empty string');
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
  assertCanonicalSubject(core);
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

// Verify one side, fail-soft and fully isolated: the canonical bytes are
// computed INSIDE the try (via a thunk), so a non-canonical core for this side —
// or a malformed did / wrong-length sig — yields false without throwing and
// without affecting the other side's result.
function verifySide(
  did: string,
  bytes: () => Uint8Array,
  sig: Uint8Array
): boolean {
  try {
    return PublicIdentity.fromDid(did).verify(bytes(), sig);
  } catch {
    return false;
  }
}

// Verify a contribution from its own fields + dids — no trust in any server.
// authentic and attested are checked independently: a malformed/empty `host`
// breaks only `attested`, never `authentic`, because the subject core omits
// host entirely (the portability guarantee). A non-canonical subject field
// fails authentic; either side's bad did fails only that side.
export function verifyContribution(c: Contribution): Verification {
  return {
    authentic: verifySide(
      c.subject,
      () => canonicalSubjContribution(c),
      c.subj_sig
    ),
    attested: verifySide(c.host, () => canonicalContribution(c), c.host_sig),
  };
}

// Build a subject-signed claim (no host). The subject signs the five-field
// subject core; `host` is irrelevant to those bytes, so the subject mints this
// with its key alone. The subject's own did stands in for `host` only to satisfy
// the shared core type — it never enters the signed bytes.
export function signClaim(
  fields: ContributionFields,
  subject: Identity
): ContributionClaim {
  const core: ContributionCore = {
    ...fields,
    subject: subject.did,
    host: subject.did,
  };
  return {
    ...fields,
    subject: subject.did,
    subj_sig: subject.sign(canonicalSubjContribution(core)),
  };
}

// Verify a claim's subject signature, fail-soft: a non-canonical field, a
// malformed did, or a wrong-length sig yields false rather than throwing.
export function verifyClaim(claim: ContributionClaim): boolean {
  return verifySide(
    claim.subject,
    () => canonicalSubjContribution({ ...claim, host: claim.subject }),
    claim.subj_sig
  );
}

// Co-sign a claim with the host key to produce a full, attested Contribution.
// The claim's subject signature is carried through unchanged (so `authentic`
// still holds) and the host signs the six-field core (so `attested` holds).
export function attest(claim: ContributionClaim, host: Identity): Contribution {
  const core: ContributionCore = {
    repo: claim.repo,
    ref: claim.ref,
    kind: claim.kind,
    at: claim.at,
    subject: claim.subject,
    host: host.did,
  };
  return {
    repo: claim.repo,
    ref: claim.ref,
    kind: claim.kind,
    at: claim.at,
    subject: claim.subject,
    host: host.did,
    subj_sig: claim.subj_sig,
    host_sig: host.sign(canonicalContribution(core)),
  };
}
