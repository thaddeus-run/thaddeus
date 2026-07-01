import { Identity, PublicIdentity } from '@thaddeus.run/identity';

// A reviewer's standing "no" attached to an Op.id (P03). Pillar 10 keeps merge a
// function — policy, proof, reputation — but the vision reserves one human
// right that survives the automation: a reviewer may read any change and veto
// it, even one a green policy would merge. A Veto records exactly that. The op
// is referenced by id, never embedded. Every field is covered by `sig`, so
// nothing on the record is malleable on relay.
export interface Veto {
  readonly op: string;
  readonly reviewer: string;
  readonly reason: string;
  readonly at: string;
  readonly sig: Uint8Array;
}

// The signable fields, before `reviewer`/`sig` are computed.
export interface VetoFields {
  readonly op: string;
  readonly reason: string;
  readonly at: string;
}

// Domain tag prefixed into the signed tuple so a veto signature can never be
// confused with an op (thaddeus.log.op.v1), provenance (thaddeus.provenance.v1),
// or contribution (thaddeus.contribution.v1) signature — or another protocol's
// payload that happens to serialize the same.
const VETO_DOMAIN = 'thaddeus.veto.v1';

// Reject non-canonical field values before they are signed. Mirrors
// provenance.ts's assertCanonical: a required field that is empty or the wrong
// type throws, so verifyVeto (try/catch) rejects such records and signVeto fails
// fast on bad input. Unlike a Contribution, a Veto is single-signed — the
// reviewer covers every field, including `op` and `at`.
function assertCanonical(fields: VetoFields, reviewer: string): void {
  const required: [string, unknown][] = [
    ['op', fields.op],
    ['reviewer', reviewer],
    ['reason', fields.reason],
    ['at', fields.at],
  ];
  for (const [name, value] of required) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`veto.${name} must be a non-empty string`);
    }
  }
}

// Deterministic bytes for the signature: the domain tag followed by all four
// fields (op, reviewer, reason, at) in a fixed order. Throws on non-canonical
// input.
export function canonicalVeto(
  fields: VetoFields,
  reviewer: string
): Uint8Array {
  assertCanonical(fields, reviewer);
  return new TextEncoder().encode(
    JSON.stringify([VETO_DOMAIN, fields.op, reviewer, fields.reason, fields.at])
  );
}

// Build the full signed record. sig = reviewer over the canonical bytes covering
// every field, so no field is malleable.
export function signVeto(fields: VetoFields, reviewer: Identity): Veto {
  const bytes = canonicalVeto(fields, reviewer.did);
  return {
    op: fields.op,
    reviewer: reviewer.did,
    reason: fields.reason,
    at: fields.at,
    sig: reviewer.sign(bytes),
  };
}

// Valid iff the signature verifies under the reviewer's did:key over the
// canonical bytes. Fails closed: any mismatch OR malformed input (an undecodable
// did:key, a wrong-length sig, a non-canonical field) returns false rather than
// throwing.
export function verifyVeto(v: Veto): boolean {
  try {
    const bytes = canonicalVeto(v, v.reviewer);
    return PublicIdentity.fromDid(v.reviewer).verify(bytes, v.sig);
  } catch {
    return false;
  }
}
