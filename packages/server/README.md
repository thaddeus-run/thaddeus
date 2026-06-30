# @thaddeus.run/server

The **untrusted API-first remote** for Thaddeus.

A `Bun.serve` HTTP server over the durable `Platform`. It holds no keys, never
decrypts, and serves ciphertext: it **verifies** pushed ops/objects/caps
(`verifyOp`, content-address, `verifyCapability`), runs policy-gated `land`, and
serves a public ciphertext mirror for clone. Writes are gated by a
signed-request envelope checked against the per-repo owner.

> **Status: spike.** Single process; reads are a fully public mirror; writes are
> owner-only; replay is bounded by a timestamp window. No TLS, no client SDK
> (see the server design spec).
