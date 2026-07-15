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

View and pull responses include the current record and bounded chain/bundle
fragments. The same-version client drains the snapshot-bound pages and verifies
that their reassembled operations are exactly the signed heads' reachable
closure before changing local state. Legacy raw views return 428 until their
owner uses the bootstrap endpoint to select a complete version-0 head; raw
pointers are never used as bootstrap trust input.

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
an exact allowlist: foreign proofs remain visible but only listed host DIDs and
the active local or managed attester count. Trust is never recursive or
transitive. Every trusted proof remains available for audit/export, while gates
count one deterministic proof per `(subject, repo, kind, ref)` event.
`minMerges` installs a gate only when this exact allowlist contains a host or an
active attester supplies one automatically. With no trust source, proofs remain
auditable but the server does not install an unusable gate.

Merge issuance verifies that the subject authored an operation newly entering
the requested repository and excludes operations authored by that repository's
owner. Release binding retains its existing rules and owner-authored releases
remain eligible. Merge and release proofs share a durable per-subject rolling
hour limit of 20; invalid and duplicate claims consume no capacity. Limiter or
signer outages fail closed for proofs but do not prevent repository operations.
This blocks straightforward owner farming and duplicate/multi-host counting, but
allowed colluding hosts and Sybil identities remain residual risks. Because the
current proof does not encode historical repository control, consumers trust
each allowed host to have enforced this policy when it signed.

Production callers provide an `AttestationSigner`, normally backed by AWS KMS.
The server process then holds no private signing key bytes, but its short-lived
IAM permission to request signatures is security-sensitive. The deprecated
`host` compatibility setting loads a private seed and is development-only.
Neither mode changes the ordinary content boundary: the server has no repository
decryption keys. Timed reveal is the explicit world-known-seed exception
described above.

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

THA-9 adds flat `ServerConfig` limits for nested reputation archives, raw
contribution counts, decoded logical text, page item/byte bounds, and cursor
capacity/idle lifetime. Collection responses carry `nextCursor` and
`Cache-Control: no-store`; cursors are opaque, rotating, one-use, route-bound,
capacity-bounded, and revision-bound. `Server.close()` releases outstanding
scanners during shutdown.

Stable bounded-input and pagination errors are:

| Status | Code                           | Meaning                                            |
| -----: | ------------------------------ | -------------------------------------------------- |
|    413 | body response has no code      | Request body exceeded `maxRequestBodyBytes`        |
|    413 | `archive_too_large`            | Nested reputation archive exceeded its byte cap    |
|    413 | `contribution_limit_exceeded`  | Raw contribution count exceeded its cap            |
|    413 | `field_too_large`              | Decoded logical UTF-8 text exceeded its byte cap   |
|    400 | `invalid_pagination`           | Pagination parameters were invalid or duplicated   |
|    410 | `pagination_cursor_invalid`    | Cursor was unknown, expired, replayed, or misbound |
|    409 | `pagination_snapshot_changed`  | Relevant data changed during traversal             |
|    429 | `pagination_capacity_exceeded` | Active cursor capacity was full                    |
|    422 | `page_item_too_large`          | One stored item could not fit in a page            |

Limit errors report only stable labels and configured caps. They never echo
submitted values, cursors, paths, repository names, DIDs, or record content.

`GET /metrics` exposes Prometheus gauges for the application/transport body
limits, replay controls, and attestation enabled/rate-limit state. Fixed-label
process-local counters cover body rejections; signed-request outcomes; expired
nonce records; attestation outcomes; and expired rate records. Counters reset on
restart and contain no request paths, identities, repository names, refs,
nonces, signatures, KMS ARNs, filenames, headers, or body content. Bun-native
pre-handler rejections cannot increment an application counter; their status
remains observable at the HTTP proxy.

> **Status: spike.** Single process; reads are a fully public ciphertext mirror;
> shared heads are owner-only. `FileBackend` replay state survives process
> restart on one node, but cross-node linearizability remains deferred to P14.
> No TLS.
