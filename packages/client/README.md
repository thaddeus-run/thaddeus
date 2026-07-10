# @thaddeus.run/client

The **Thaddeus** client SDK. A `Client` holds a self-owned `Identity` and speaks
the untrusted HTTP remote (`@thaddeus.run/server`): `createRepo`, `clone`,
`push`, `land`, `scheduleReveal`, and `reveal`. It signs every write, ingests
pulled ciphertext into a local durable repo, and never sends plaintext keys; all
wrapping and encryption is client-side. A scheduled reveal deliberately sends a
capability wrapped to the well-known public identity, making the chosen host the
trusted embargo custodian for that file until its start time.

> **Status: spike.** Single-owner writes; online, full-set sync (see the CLI
> design spec).
