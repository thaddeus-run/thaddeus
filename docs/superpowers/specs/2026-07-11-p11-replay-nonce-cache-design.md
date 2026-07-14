# P11 Replay-Nonce Cache Design

**Date:** 2026-07-11 **Status:** Shipped; durability followed up in P12

## Problem

The signed-request envelope previously bound a request body and timestamp to a
signer, but freshness alone did not provide uniqueness. Anyone who observed a
valid mutation could submit the exact envelope again while its timestamp was
inside the five-minute acceptance window.

## Protocol

- Every signed mutation includes an `x-thaddeus-nonce` header. The client
  generates a fresh random UUID by default.
- The nonce is part of the canonical signed bytes, after the timestamp, so it
  cannot be replaced without invalidating the signature.
- After the complete signature and timestamp check succeeds, the server
  atomically consumes the `(signer DID, nonce)` pair. Every signed route shares
  the same cache, including `DELETE` mutations.
- Entries remain until the request timestamp is strictly outside the accepted
  five-minute window. A map provides duplicate lookup and a minimum heap removes
  expired entries without scanning the cache on every request.
- The default cache limit is 100,000 live entries and is configurable with
  `ServerConfig.replayCacheCapacity`. A full cache rejects new signed requests;
  it never evicts a still-live nonce, because doing so would reopen its replay
  window.
- Invalid signatures do not consume cache entries.

## Compatibility

The canonical request bytes and required headers changed together. Clients and
servers must be upgraded together; an old envelope without a nonce is rejected.
Callers that use `verifyRequest` as a standalone signature primitive can omit a
cache and retain stateless verification, while the HTTP server always supplies
one.

## Security boundary

The public `ReplayNonceCache` remains process-local for standalone
compatibility.

> **P12 durability follow-up (2026-07-14, THA-8/#61):** HTTP routes now consume
> opaque nonce keys through the backend-neutral atomic `ReplayNonceBackend`.
> `MemoryBackend` and the single-node `FileBackend` implement the contract;
> `FileBackend` persists versioned expiries in a hidden namespace, rebuilds a
> bounded index after restart, and fails closed on corrupt or excessive state.
> Operators can bound capacity and narrow request skew, but every durable nonce
> expires exactly five minutes after issuance regardless of the configured
> `THADDEUS_REQUEST_SKEW_MS` value. Stable 429/503 responses plus fixed-label
> metrics expose saturation and availability. The original cache API remains
> available but is no longer the server route's replay boundary.

Cross-node linearizability is still outside this design. Shared CAS, distributed
backend conformance, and multi-replica replay protection remain deferred to P14.
