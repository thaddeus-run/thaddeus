import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { Identity, PublicIdentity } from '@thaddeus.run/identity';
import type { Ref } from '@thaddeus.run/store';

// A signed operation — the unit that replaces the commit. View-agnostic: an op
// is a DAG node, never stamped with a branch. Metadata (path, parents, lamport,
// author) is cleartext so any peer can order and merge it WITHOUT decryption;
// the payload is a capability-gated store Ref only grantees can read. A null
// payload is a delete tombstone.
export interface Op {
  readonly id: string;
  readonly path: string;
  readonly parents: readonly string[];
  readonly lamport: number;
  readonly author: string;
  readonly payload: Ref | null;
  readonly sig: Uint8Array;
}

// The signable fields, before id/sig are computed.
export interface OpFields {
  readonly path: string;
  readonly parents: readonly string[];
  readonly lamport: number;
  readonly payload: Ref | null;
}

// Domain tag prefixed into the signed tuple so an op signature can never be
// confused with another protocol's payload that happens to serialize the same.
const OP_DOMAIN = 'thaddeus.log.op.v1';

// Reject non-canonical field values before they are hashed/signed. JSON.stringify
// silently coerces NaN/Infinity/undefined to `null` inside arrays, so without this
// a peer could sign over a coerced canonical form while the op carries a poisoning
// value (e.g. lamport = NaN, which breaks ordering). Throwing here makes verifyOp
// (which is try/catch) reject such ops and makes signOp fail fast on bad input.
function assertCanonical(fields: OpFields, author: string): void {
  if (typeof fields.path !== 'string' || fields.path.length === 0) {
    throw new TypeError('op.path must be a non-empty string');
  }
  if (typeof author !== 'string' || author.length === 0) {
    throw new TypeError('op.author must be a non-empty string');
  }
  if (!Number.isSafeInteger(fields.lamport) || fields.lamport < 0) {
    throw new TypeError('op.lamport must be a non-negative safe integer');
  }
  for (const p of fields.parents) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new TypeError('op.parents must be non-empty strings');
    }
  }
  if (
    fields.payload !== null &&
    (typeof fields.payload.id !== 'string' ||
      typeof fields.payload.plaintext_id !== 'string')
  ) {
    throw new TypeError('op.payload must have string id and plaintext_id');
  }
}

// Deterministic bytes for id + signature. `parents` is sorted so the id does
// not depend on head-enumeration order; payload encodes as its Ref pair or null.
export function canonicalOp(fields: OpFields, author: string): Uint8Array {
  assertCanonical(fields, author);
  const payload =
    fields.payload === null
      ? null
      : [fields.payload.id, fields.payload.plaintext_id];
  return new TextEncoder().encode(
    JSON.stringify([
      OP_DOMAIN,
      fields.path,
      [...fields.parents].sort(),
      fields.lamport,
      author,
      payload,
    ])
  );
}

export function opId(fields: OpFields, author: string): string {
  return bytesToHex(blake3(canonicalOp(fields, author)));
}

// Build the full signed record. id = blake3(canonical); sig = author over the
// same canonical bytes, so id and signature bind the identical tuple.
export function signOp(fields: OpFields, author: Identity): Op {
  const bytes = canonicalOp(fields, author.did);
  return {
    id: bytesToHex(blake3(bytes)),
    path: fields.path,
    parents: fields.parents,
    lamport: fields.lamport,
    author: author.did,
    payload: fields.payload,
    sig: author.sign(bytes),
  };
}

// Valid iff the id matches the canonical bytes AND the signature verifies under
// the author's did:key. Fails closed: any mismatch OR malformed input (an
// undecodable did:key, a wrong-length sig) returns false rather than throwing,
// so an adversarial peer op can never crash the append path that gates on it.
export function verifyOp(op: Op): boolean {
  try {
    const bytes = canonicalOp(op, op.author);
    if (bytesToHex(blake3(bytes)) !== op.id) {
      return false;
    }
    return PublicIdentity.fromDid(op.author).verify(bytes, op.sig);
  } catch {
    return false;
  }
}
