# @thaddeus.run/client

The **Thaddeus** client SDK. A `Client` holds a self-owned `Identity` and speaks
the untrusted HTTP remote (`@thaddeus.run/server`): `createRepo`, `clone`,
`push`, `land`. It signs every write, ingests pulled ciphertext into a local
durable repo, and never sends a key — all crypto is client-side.

> **Status: spike.** Single-owner writes; online, full-set sync (see the CLI
> design spec).
