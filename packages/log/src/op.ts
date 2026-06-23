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

// Deterministic bytes for id + signature. `parents` is sorted so the id does
// not depend on head-enumeration order; payload encodes as its Ref pair or null.
export function canonicalOp(fields: OpFields, author: string): Uint8Array {
  const payload =
    fields.payload === null
      ? null
      : [fields.payload.id, fields.payload.plaintext_id];
  return new TextEncoder().encode(
    JSON.stringify([
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
