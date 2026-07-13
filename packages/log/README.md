# @thaddeus.run/log

The operation log for **Thaddeus** — Pillar 03.

Signed, CRDT-ordered `Op` records on a DAG. The log is the source of truth; file
snapshots are a derived projection (`materialize()`). Branches dissolve into
zero-copy named views. An embargoed op publishes only an opaque ordering token
to the public mirror; its metadata releases at a chosen time T via the
`@thaddeus.run/store` membrane.

## Signed shared heads

`HeadRecord` is the portable authority for a shared view. It binds repository,
view, monotonic version, previous record ID, sorted operation heads, and owner
in a fixed canonical tuple. Its ID is BLAKE3 and its Ed25519 signature is
verified through the owner's `did:key`.

`verifyHeadChain` rejects rollback, forks, gaps, broken links, owner/scope
changes, and dropped prior heads. `verifyHeadSnapshot` additionally requires a
pull's operations to be exactly the signed heads' reachable closure—no missing
head or ancestor, forgery, duplicate, or unrelated extra operation.

`HeadStore` durably retains every owner-authored version under
`head/<view>/<version>`. It has no unsigned current pointer: `current()` is the
last record in a completely valid contiguous chain, and load/import fail closed
on corruption or conflict.

> **Status: spike.** In-memory and durable backends are single-process. Content
> merge and convergence over sealed metadata remain deferred.
