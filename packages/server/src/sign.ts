import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { type Identity, PublicIdentity } from '@thaddeus.run/identity';

// A signed write request must arrive within this clock skew. Bounds replay; a
// seen-nonce store (full replay-proofing) is deferred (spec §11).
const SKEW_MS = 5 * 60 * 1000;

export interface SignedHeaders {
  did: string;
  timestamp: string;
  signature: string; // base64
}

// The canonical bytes a request signature covers: method, path+query, a hash of
// the body, and the timestamp. Hashing the body binds the signature to exactly
// these bytes, so a tampered payload fails verification.
export function canonicalRequest(
  method: string,
  pathWithQuery: string,
  body: Uint8Array,
  timestamp: string
): Uint8Array {
  const hash = bytesToHex(blake3(body));
  return new TextEncoder().encode(
    `${method}\n${pathWithQuery}\n${hash}\n${timestamp}`
  );
}

// Client side: produce the three header values for a request.
export function signRequest(
  method: string,
  pathWithQuery: string,
  body: Uint8Array,
  signer: Identity,
  timestamp: string
): SignedHeaders {
  const sig = signer.sign(
    canonicalRequest(method, pathWithQuery, body, timestamp)
  );
  return {
    did: signer.did,
    timestamp,
    signature: Buffer.from(sig).toString('base64'),
  };
}

// Server side: verify headers against the body. Returns the verified signer DID,
// or null on any failure (missing/invalid signature, expired/early timestamp,
// undecodable DID).
export function verifyRequest(
  method: string,
  pathWithQuery: string,
  body: Uint8Array,
  headers: SignedHeaders | null,
  nowMs: number
): string | null {
  if (headers === null) {
    return null;
  }
  // Fail closed: a misconfigured server clock (NaN nowMs) must reject rather
  // than silently disable the skew/replay window.
  if (Number.isNaN(nowMs)) {
    return null;
  }
  const t = Date.parse(headers.timestamp);
  if (Number.isNaN(t) || Math.abs(nowMs - t) > SKEW_MS) {
    return null;
  }
  try {
    const pub = PublicIdentity.fromDid(headers.did);
    const sig = new Uint8Array(Buffer.from(headers.signature, 'base64'));
    const ok = pub.verify(
      canonicalRequest(method, pathWithQuery, body, headers.timestamp),
      sig
    );
    return ok ? headers.did : null;
  } catch {
    return null;
  }
}
