# @thaddeus.run/persist

Durable backends for **Thaddeus** — the cold tier behind the in-memory hot
cache.

A `Backend` is a tiny async key→bytes store (`@thaddeus.run/store`).
`FileBackend` writes each key to a percent-encoded file (atomic temp+rename);
`MemoryBackend` is a `Map` for fast deterministic tests;
`scoped(backend, prefix)` namespaces a backend so one store can hold many repos.
Give one to a `Store`/`OpLog` (or `Platform.createDurable`/`openDurable`) and a
repo survives a restart.

Both backends also implement the atomic `ReplayNonceBackend` contract.
`MemoryBackend` uses a bounded map/min-heap. `FileBackend` stores versioned
expiry records below the dedicated `.replay-nonces-v1/` directory, which normal
`Backend.list()` never enumerates. The server derives each filename as a
domain-separated BLAKE3 digest of the signer/nonce tuple, so raw identities and
nonces never reach persistence.

`FileBackend` lazily rebuilds its bounded nonce index with streaming directory
iteration after restart. Malformed records and stores beyond the 1,000,000 hard
maximum fail closed. New records are written through staging and atomically
hard-linked into place before the signed request may mutate application state;
expired records are removed from the min-heap only after their exact expiry
boundary.

> **Status: spike.** `FileBackend` coordinates replay consumption in one server
> process. Cross-node linearizability, SQLite/S3 CAS, conformance, and migration
> remain deferred to P14.
