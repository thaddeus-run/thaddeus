import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { type Identity, PublicIdentity } from '@thaddeus.run/identity';
import {
  MAX_REPLAY_NONCE_CAPACITY,
  DEFAULT_REPLAY_NONCE_CAPACITY as STORE_DEFAULT_REPLAY_NONCE_CAPACITY,
} from '@thaddeus.run/store';

// A signed write request must arrive within this clock skew. The server retains
// each accepted nonce until its timestamp can no longer pass this window.
export const REQUEST_SKEW_MS: number = 5 * 60 * 1000;
export const DEFAULT_REPLAY_NONCE_CAPACITY: number =
  STORE_DEFAULT_REPLAY_NONCE_CAPACITY;
/** @deprecated Use DEFAULT_REPLAY_NONCE_CAPACITY. */
export const DEFAULT_REPLAY_CACHE_CAPACITY: number =
  DEFAULT_REPLAY_NONCE_CAPACITY;
export { MAX_REPLAY_NONCE_CAPACITY };

export interface SignedHeaders {
  did: string;
  timestamp: string;
  nonce: string;
  signature: string; // base64
}

interface Expiration {
  readonly key: string;
  readonly expiresAt: number;
}

// Process-local, bounded nonce replay protection. A min-heap makes expiry
// proportional to the number of stale entries rather than scanning the whole
// five-minute window on every write. Capacity exhaustion rejects new writes
// until an entry expires: fail closed rather than evicting a live nonce and
// reopening its replay window.
export class ReplayNonceCache {
  readonly #capacity: number;
  readonly #seen = new Map<string, number>();
  readonly #expirations: Expiration[] = [];

  constructor(capacity: number = DEFAULT_REPLAY_CACHE_CAPACITY) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity <= 0 ||
      capacity > MAX_REPLAY_NONCE_CAPACITY
    ) {
      throw new RangeError(
        `replay cache capacity must be a positive safe integer no greater than ${MAX_REPLAY_NONCE_CAPACITY}`
      );
    }
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#seen.size;
  }

  consume(
    did: string,
    nonce: string,
    expiresAt: number,
    nowMs: number
  ): boolean {
    this.#prune(nowMs);
    const key = `${did}\n${nonce}`;
    if (this.#seen.has(key) || this.#seen.size >= this.#capacity) return false;
    this.#seen.set(key, expiresAt);
    this.#push({ key, expiresAt });
    return true;
  }

  #prune(nowMs: number): void {
    for (;;) {
      const first = this.#expirations[0];
      // The timestamp remains valid at the exact skew boundary, so retain its
      // nonce until the server clock moves strictly past the expiry.
      if (first === undefined || first.expiresAt >= nowMs) return;
      const expired = this.#pop();
      if (
        expired !== undefined &&
        this.#seen.get(expired.key) === expired.expiresAt
      ) {
        this.#seen.delete(expired.key);
      }
    }
  }

  #push(value: Expiration): void {
    const heap = this.#expirations;
    heap.push(value);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentValue = heap[parent];
      if (parentValue === undefined || parentValue.expiresAt <= value.expiresAt)
        break;
      heap[index] = parentValue;
      index = parent;
    }
    heap[index] = value;
  }

  #pop(): Expiration | undefined {
    const heap = this.#expirations;
    const first = heap[0];
    const last = heap.pop();
    if (first === undefined || last === undefined || heap.length === 0) {
      return first;
    }
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const leftValue = heap[left];
      if (leftValue === undefined) break;
      const rightValue = heap[right];
      const child =
        rightValue !== undefined && rightValue.expiresAt < leftValue.expiresAt
          ? right
          : left;
      const childValue = heap[child];
      if (childValue === undefined || childValue.expiresAt >= last.expiresAt)
        break;
      heap[index] = childValue;
      index = child;
    }
    heap[index] = last;
    return first;
  }
}

/**
 * Builds the canonical bytes covered by a request signature.
 * Hashing the body binds the signature to its exact payload.
 */
export function canonicalRequest(
  method: string,
  pathWithQuery: string,
  body: Uint8Array,
  timestamp: string,
  nonce: string
): Uint8Array {
  const hash = bytesToHex(blake3(body));
  return new TextEncoder().encode(
    `${method}\n${pathWithQuery}\n${hash}\n${timestamp}\n${nonce}`
  );
}

/**
 * Derives an opaque, domain-separated replay key from a signer and nonce.
 * JSON tuple encoding keeps their boundaries unambiguous.
 */
export function replayNonceKey(signerDid: string, nonce: string): string {
  const tuple = JSON.stringify([signerDid, nonce]);
  return bytesToHex(
    blake3(new TextEncoder().encode(`thaddeus/replay-nonce/v1\0${tuple}`))
  );
}

/** Produces the four signed header values for a client request. */
export function signRequest(
  method: string,
  pathWithQuery: string,
  body: Uint8Array,
  signer: Identity,
  timestamp: string,
  nonce: string = crypto.randomUUID()
): SignedHeaders {
  const sig = signer.sign(
    canonicalRequest(method, pathWithQuery, body, timestamp, nonce)
  );
  return {
    did: signer.did,
    timestamp,
    nonce,
    signature: Buffer.from(sig).toString('base64'),
  };
}

/**
 * Verifies signed request headers and returns the signer DID on success.
 * Missing, malformed, expired, replayed, or undecodable envelopes return null.
 */
export function verifyRequest(
  method: string,
  pathWithQuery: string,
  body: Uint8Array,
  headers: SignedHeaders | null,
  nowMs: number,
  replayCacheOrRequestSkew?: ReplayNonceCache | number,
  configuredRequestSkewMs: number = REQUEST_SKEW_MS
): string | null {
  const replayCache =
    typeof replayCacheOrRequestSkew === 'number'
      ? undefined
      : replayCacheOrRequestSkew;
  const requestSkewMs =
    typeof replayCacheOrRequestSkew === 'number'
      ? replayCacheOrRequestSkew
      : configuredRequestSkewMs;
  if (headers === null) {
    return null;
  }
  // Fail closed: a misconfigured server clock (NaN nowMs) must reject rather
  // than silently disable the skew/replay window.
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(requestSkewMs) ||
    requestSkewMs < 1 ||
    requestSkewMs > REQUEST_SKEW_MS ||
    typeof headers.nonce !== 'string' ||
    headers.nonce.length === 0 ||
    headers.nonce.length > 128
  ) {
    return null;
  }
  const t = Date.parse(headers.timestamp);
  if (Number.isNaN(t) || Math.abs(nowMs - t) > requestSkewMs) {
    return null;
  }
  try {
    const pub = PublicIdentity.fromDid(headers.did);
    const sig = new Uint8Array(Buffer.from(headers.signature, 'base64'));
    const ok = pub.verify(
      canonicalRequest(
        method,
        pathWithQuery,
        body,
        headers.timestamp,
        headers.nonce
      ),
      sig
    );
    if (!ok) return null;
    if (
      replayCache !== undefined &&
      !replayCache.consume(
        headers.did,
        headers.nonce,
        t + REQUEST_SKEW_MS,
        nowMs
      )
    ) {
      return null;
    }
    return headers.did;
  } catch {
    return null;
  }
}
