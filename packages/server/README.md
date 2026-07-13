# @thaddeus.run/server

The **untrusted API-first remote** for Thaddeus.

A `Bun.serve` HTTP server over the durable `Platform`. For ordinary content it
holds no decryption keys and serves ciphertext: it **verifies** pushed
ops/objects/caps (`verifyOp`, content-address, `verifyCapability`), runs
policy-gated `land`, and serves a public ciphertext mirror for clone. Writes are
gated by a signed-request envelope checked against the per-repo owner.

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
signature. A bounded process-local cache rejects an accepted `(signer, nonce)`
for the rest of its five-minute timestamp-validity window. A full cache fails
closed. The cache is intentionally not durable or shared between nodes, so a
restart or a request routed to another process begins a new replay boundary.

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

`GET /metrics` exposes Prometheus gauges for the application and transport
limits plus process-local rejection counters with fixed reason labels. Counters
reset on restart and contain no request paths, identities, headers, or body
content. Bun-native pre-handler rejections cannot increment an application
counter; their status remains observable at the HTTP proxy.

> **Status: spike.** Single process; reads are a fully public mirror; writes are
> owner-only; replay is blocked within a process. No TLS, no client SDK (see the
> server design spec).
