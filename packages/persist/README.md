# @thaddeus.run/persist

Durable backends for **Strata** (working name) — the cold tier behind the
in-memory hot cache.

A `Backend` is a tiny async key→bytes store (`@thaddeus.run/store`).
`FileBackend` writes each key to a percent-encoded file (atomic temp+rename);
`MemoryBackend` is a `Map` for fast deterministic tests;
`scoped(backend, prefix)` namespaces a backend so one store can hold many repos.
Give one to a `Store`/`OpLog` (or `Platform.createDurable`/`openDurable`) and a
repo survives a restart.

> **Status: spike.** Single process, durable not concurrent. No SQLite/S3
> backend, no compaction, no server (see the persistence design spec).
