# @thaddeus.run/server

The **untrusted API-first remote** for Thaddeus.

A `Bun.serve` HTTP server over the durable `Platform`. For ordinary content it
holds no decryption keys and serves ciphertext: it **verifies** pushed
ops/objects/caps (`verifyOp`, content-address, `verifyCapability`), runs
policy-gated `land`, and serves a public ciphertext mirror for clone. Writes are
gated by a signed-request envelope checked against the per-repo owner.

Public shared views are authorized by owner-signed, monotonic `HeadRecord`
chains—not raw `OpLog` view pointers. Repository and branch creation require a
signed version-0 record. A land must carry the owner's exact next record for the
policy-approved merged heads; the server persists it before updating its
projection. Delegates may upload signed operations, but cannot create shared
branches or land them. A policy denial stores no candidate head.

View and pull responses include the current record and complete chain. Before
serving a pull, the server verifies that it holds exactly the signed heads'
reachable operation closure. Legacy raw views return 428 until their owner uses
the bootstrap endpoint to select a complete version-0 head; raw pointers are
never used as bootstrap trust input.

Timed reveals arrive as signed capabilities wrapped to the well-known public
identity. They are persisted separately from served capabilities, never appear
in a pull before their start time, and are promoted by the hosting CLI's
scheduled scan. This is an explicit exception to the normal untrusted-server
model: the public identity's seed is well-known, so scheduling trusts the host
not to unwrap or publish that file's capability before its start time. The
membrane is store-honest, not trustless; trustless unattended release still
requires time-lock crypto.

Portable reputation is public on `GET /reputation/:did/export` and imported by
the subject on signed `POST /reputation/import`. Imports are strict and durable
in one content-addressed record. `ServerConfig.trustedReputationHosts` controls
which foreign host attestations count toward profiles and reputation policy; the
server's own host identity is always trusted.

Every signed mutation includes an `x-thaddeus-nonce` value covered by the
signature. After signature verification, the server derives an opaque,
domain-separated BLAKE3 key and atomically consumes it through the configured
`Backend & ReplayNonceBackend` before parsing JSON, taking repository locks, or
persisting state. Validly signed semantic failures still consume their one-shot
envelope; invalid signatures never reserve capacity.

`ServerConfig.replayNonceCapacity` defaults to 100,000 and is capped at
1,000,000. The deprecated `replayCacheCapacity` programmatic alias remains for
compatibility, but both names cannot be set together. `requestSkewMs` may narrow
timestamp acceptance from the default/protocol maximum of 300,000 ms down to 1
ms. Accepted nonces are always retained through `signed timestamp + 300,000 ms`
so narrowing and later widening the configured skew cannot reopen a replay.

Replay failures have stable responses:

- Invalid, expired, or replayed envelopes:
  `401 {"error":"unsigned or invalid request"}`.
- Full nonce store:
  `429 {"error":"replay protection capacity exceeded","code":"replay_capacity_exceeded"}`
  with `Retry-After`.
- Failed or corrupt nonce storage:
  `503 {"error":"replay protection unavailable","code":"replay_store_unavailable"}`.

## Bounded request bodies

Recognized POST routes stream request bodies through a bounded reader before
signature verification or JSON decoding. `ServerConfig.maxRequestBodyBytes` sets
the inclusive application limit and defaults to the exported
`DEFAULT_MAX_REQUEST_BODY_BYTES` value of 16 MiB. It must be a positive safe
integer no greater than `Number.MAX_SAFE_INTEGER - 1`.

The CLI host configures Bun's native transport ceiling one sentinel byte above
the application limit. This lets the application detect the exact overflow
boundary while Bun rejects larger declarations before routing. The host also
pins Bun's connection idle timeout at 10 seconds so a stalled partial request
cannot retain its buffered prefix indefinitely. Application rejections use these
stable JSON responses:

- `413 {"error":"request body too large","maxBytes":<limit>}` for a declared or
  streamed overflow.
- `400 {"error":"invalid content-length header"}` for a malformed or unsafe
  `Content-Length`.
- `400 {"error":"invalid request body"}` when a request stream fails.

Bun-native transport rejections happen before the handler and return 413 with an
empty body. Unmatched request bodies are cancelled without buffering.

`GET /metrics` exposes Prometheus gauges for the application/transport body
limits, replay nonce capacity, and request timestamp skew. Fixed-label
process-local counters cover body rejections; signed-request `accepted`,
`invalid`, `replayed`, `capacity`, and `store_error` outcomes; and expired nonce
records cleaned. Counters reset on restart and contain no request paths,
identities, nonces, signatures, filenames, headers, or body content. Bun-native
pre-handler rejections cannot increment an application counter; their status
remains observable at the HTTP proxy.

> **Status: spike.** Single process; reads are a fully public ciphertext mirror;
> shared heads are owner-only. `FileBackend` replay state survives process
> restart on one node, but cross-node linearizability remains deferred to P14.
> No TLS.
