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

> **Status: spike.** Single process; reads are a fully public mirror; writes are
> owner-only; replay is bounded by a timestamp window. No TLS, no client SDK
> (see the server design spec).
