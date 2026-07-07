import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { Identity, PublicIdentity } from '@thaddeus.run/identity';

// A signed structural operation over the semantic graph. Targets a Symbol.id,
// never a path (the manifesto's "step 3's Op targets a symbol id"). The spike
// ships 'rename-symbol'; change-signature/move-definition share this shape.
export interface SymbolOp {
  readonly id: string;
  readonly kind: 'rename-symbol';
  readonly symbol: string;
  readonly from: string;
  readonly to: string;
  readonly base: string | null;
  readonly author: string;
  readonly sig: Uint8Array;
}

// The signable fields, before id/author/sig are computed.
export interface SymbolOpFields {
  readonly kind: 'rename-symbol';
  readonly symbol: string;
  readonly from: string;
  readonly to: string;
  readonly base: string | null;
}

// Domain tag prefixed into the signed tuple so a SymbolOp signature can never be
// confused with an op (thaddeus.log.op.v1) or provenance (thaddeus.provenance.v1)
// signature.
const SYMBOLOP_DOMAIN = 'thaddeus.graph.symbolop.v1';

// Reject non-canonical field values before they are hashed/signed. Mirrors
// op.ts/provenance.ts: an empty/wrong-typed required field throws, so
// verifySymbolOp (try/catch) rejects such records and signSymbolOp fails fast.
function assertCanonical(fields: SymbolOpFields, author: string): void {
  if (fields.kind !== 'rename-symbol') {
    throw new TypeError('symbolOp.kind must be "rename-symbol"');
  }
  const required: [string, unknown][] = [
    ['symbol', fields.symbol],
    ['from', fields.from],
    ['to', fields.to],
    ['author', author],
  ];
  for (const [name, value] of required) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`symbolOp.${name} must be a non-empty string`);
    }
  }
  if (
    fields.base !== null &&
    (typeof fields.base !== 'string' || fields.base.length === 0)
  ) {
    throw new TypeError('symbolOp.base must be a non-empty string or null');
  }
}

// Deterministic bytes for id + signature.
export function canonicalSymbolOp(
  fields: SymbolOpFields,
  author: string
): Uint8Array {
  assertCanonical(fields, author);
  return new TextEncoder().encode(
    JSON.stringify([
      SYMBOLOP_DOMAIN,
      fields.kind,
      fields.symbol,
      fields.from,
      fields.to,
      fields.base,
      author,
    ])
  );
}

// Build the full signed record. id = blake3(canonical); sig = author over the
// same canonical bytes, so id and signature bind the identical tuple.
export function signSymbolOp(
  fields: SymbolOpFields,
  author: Identity
): SymbolOp {
  const bytes = canonicalSymbolOp(fields, author.did);
  return {
    id: bytesToHex(blake3(bytes)),
    kind: fields.kind,
    symbol: fields.symbol,
    from: fields.from,
    to: fields.to,
    base: fields.base,
    author: author.did,
    sig: author.sign(bytes),
  };
}

// Valid iff the id matches the canonical bytes AND the signature verifies under
// the author's did:key. Fails closed: any mismatch OR malformed input (an
// undecodable did:key, a wrong-length sig) returns false rather than throwing.
export function verifySymbolOp(op: SymbolOp): boolean {
  try {
    const bytes = canonicalSymbolOp(op, op.author);
    if (bytesToHex(blake3(bytes)) !== op.id) {
      return false;
    }
    return PublicIdentity.fromDid(op.author).verify(bytes, op.sig);
  } catch {
    return false;
  }
}
