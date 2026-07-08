# @thaddeus.run/query

The live query surface for **Thaddeus** (working name) — Pillar 11 (query
slice).

`CodeDB` treats the codebase as a database you interrogate: it **joins** the
four first-class dimensions the substrate already stores — the semantic graph
(P08), the operation-log history with wall-clock time (P03), provenance (P04),
and capabilities (P01) — into cross-cutting answers that Git and GitHub cannot
give:

- `why(opId)` — the signed **`--why`** behind a change (provenance +
  verification).
- `touchedSince(at)` / `touchedBetween(from, to)` — every change in a time
  window ("all code an untrusted agent touched in the last hour").
- `by(did, window?)` — every change a principal authored.
- `callers(symbolId)` — who currently calls a symbol, and where they're defined.
- `references(name)` — every use-site of a symbol, by name.

Pure read-only joins — no new signed records. The graph half is
**decryption-bounded** (inherited from the `Workspace` the `SymbolGraph` was
built over); operation metadata (path, author, `at`) is cleartext by P03 design.

> **Status: spike.** In-memory, single process, full re-derive per query.
> Subscriptions that fire on semantic events (Slice 2), policy as standing
> queries (Slice 3), incremental indexing / millisecond-scale, a durable query
> store, and behavioral-diff across full history are deferred (see the design
> spec).
