# @thaddeus.run/log

The operation log for **Strata** (working name) — Pillar 03.

Signed, CRDT-ordered `Op` records on a DAG. The log is the source of truth; file
snapshots are a derived projection (`materialize()`). Branches dissolve into
zero-copy named views. An embargoed op publishes only an opaque ordering token
to the public mirror; its metadata releases at a chosen time T via the
`@thaddeus.run/store` membrane.

> **Status: spike.** In-memory, single process. Content merge, convergence over
> sealed metadata, and symbol-level ops are deferred (see the design spec).
