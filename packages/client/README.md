# @thaddeus.run/client

The **Thaddeus** client SDK. A `Client` holds a self-owned `Identity` and speaks
the untrusted HTTP remote (`@thaddeus.run/server`): `createRepo`, `clone`,
`push`, `land`, `scheduleReveal`, and `reveal`. It signs every write, ingests
pulled ciphertext into a local durable repo, and never sends plaintext keys; all
wrapping and encryption is client-side. A scheduled reveal deliberately sends a
capability wrapped to the well-known public identity, making the chosen host the
trusted embargo custodian for that file until its start time.

Portable reputation uses `exportReputation(did)` to fetch a public, versioned
archive and `importReputation(archive)` to submit it in a request signed by the
archive subject. The destination verifies every contribution independently and
returns imported/duplicate/total counts.

Every signed mutation carries a fresh random nonce covered by its signature, so
the server can reject an otherwise-valid request replayed during the timestamp
window.

> **Status: spike.** Single-owner writes; online, full-set sync (see the CLI
> design spec).
