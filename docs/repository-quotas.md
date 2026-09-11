# Durable repository and object quotas

THA-146 resumes THA-23. The server charges repositories and retained encrypted
objects to the repository **owner**. Delegated uploads consume that owner's
budget. The same identity's usage is aggregated across all repositories on one
backend. Each retained ciphertext version counts separately, including
rotations; re-uploading an existing object in the same repository does not
consume another object or creation slot. The same object in another repository
occupies storage again and is charged again.

Byte usage measures the actual encoded `obj/` records, including ciphertext,
base64 expansion and object metadata. It does not claim to measure filesystem
blocks, the recovery journal, capabilities, operation history, or other
metadata. General mutation, provenance and veto spam limiting remains THA-10.

## Configuration

Pass `quotas` to `createServer` or `startServer`, or use `thaddeus serve` flags:

| Configuration property    | CLI flag                      | Default per owner              |
| ------------------------- | ----------------------------- | ------------------------------ |
| `maxRepositories`         | `--max-repositories`          | 100 repositories               |
| `maxObjects`              | `--max-objects`               | 100,000 retained objects       |
| `maxObjectBytes`          | `--max-object-bytes`          | 1,073,741,824 encoded bytes    |
| `repositoryCreationLimit` | `--repository-creation-limit` | 20 new repositories per window |
| `objectCreationLimit`     | `--object-creation-limit`     | 10,000 new objects per window  |
| `creationWindowMs`        | `--creation-window-ms`        | 3,600,000 milliseconds         |

Every value must be a positive safe integer no greater than
`floor(Number.MAX_SAFE_INTEGER / 4)`. Zero, null, fractions, non-finite values,
unknown configuration properties, and invalid CLI numeric strings fail startup.
There is no disable switch. Lowering a quota below existing usage blocks growth;
deleting data remains possible. Identical uploads remain possible at the storage
and creation boundaries.

Repository and object windows are independent fixed windows anchored at the
first successful creation in each window. The exact expiry millisecond admits
the next creation. Deletion refunds storage usage but **never** creation rate.
Failed writes that roll back refund both. Moving the clock backwards cannot
reset a live window. Changing a configured window length intentionally changes
the enforcement policy applied to its persisted start time.

## HTTP contract

The JSON body is `{ "error": "<code>", "code": "<code>" }`. Responses carry
`Cache-Control: no-store`. Errors contain no identity, repository name, object
address, filesystem path, or content.

| Status | Code                               | `Retry-After`                                            |
| ------ | ---------------------------------- | -------------------------------------------------------- |
| 403    | `repository_quota_exceeded`        | Absent; delete owned data or raise the limit             |
| 403    | `object_quota_exceeded`            | Absent                                                   |
| 403    | `object_bytes_quota_exceeded`      | Absent                                                   |
| 429    | `repository_creation_rate_limited` | Positive whole seconds, rounded up to window expiry      |
| 429    | `object_creation_rate_limited`     | Positive whole seconds, rounded up to window expiry      |
| 413    | `quota_batch_too_large`            | Absent; split uploads or perform operator maintenance    |
| 503    | `quota_storage_unavailable`        | 1 second; operational recovery may still be required     |
| 409    | `repository_exists`                | Absent; another server instance won the same-name create |

Existing malformed-body, authentication, authorization, and same-server name
conflict responses retain their contracts. Quota failure aborts the whole upload
batch, including otherwise-valid earlier objects. Ordinary invalid bundle items
still use the existing `rejected[]` result and do not consume object capacity.

## Reservations, persistence and cleanup

The existing request-body/field guards run first. A repository reservation is
checked before the Platform allocates its hot repository. A bounded object
preflight checks submitted content addresses and their durable size deltas
before loading a cold repository. Checks and commits serialize within the
backend's coordination domain, so concurrent creates and pushes cannot
oversubscribe.

Repository creation, push, recall and deletion stage their writes under this
reservation. Staging is capped at 64 MiB of bytes/key allowance and 1,000,000
keys, independently of operator-raised quotas; rollback bytes are separately
capped at 64 MiB. Per-object savepoints retain only that object's changed keys.
Failed validation discards the batch and evicts its hot state.

A versioned redo journal publishes the accepted write set and the updated owner
counters together. Records are applied idempotently; the journal is removed
last. A failed write publishes an undo journal when storage permits, restores
previous records and returns 503. Deletions retain a redo journal rather than
copying all deleted ciphertext into memory. An interrupted commit or cleanup is
replayed before subsequent routes access data. If storage fails before an undo
journal can be published, the accepted redo journal remains authoritative;
recovery may complete the operation after a 503. Clients should inspect state
and retry idempotently after operational errors. Counters never free capacity
while an authoritative journal still retains the allocation.

Deleting a repository reclaims its encoded object bytes, retained object count
and repository slot in the same durable batch. Scanning deletion is bounded to
1,000,000 underlying entries and skips nested repositories with their own owner
metadata. The server retires idle locks and limits its hot repository cache to
128 inactive/active entries except while concurrent mutations pin entries;
eviction invalidates the associated cursor revision. Cursor sessions retain the
existing THA-9 bounds.

`MemoryBackend` coordinates its instance. `FileBackend` instances using the same
resolved root coordinate in **one process**, matching the existing replay-nonce
deployment domain. Run one server process per data directory. This is not a
multi-process or distributed quota service; P14 coordination remains separate.
Do not mutate backend files behind a running server.

## Existing FileBackend data

New generic records are stored in `.records-v1/<sha256-prefix>/<encoded-key>`,
using 256 shards. Flat percent-encoded files remain readable. Overwrites migrate
flat records lazily; sharded records win when an interrupted migration leaves
both copies. Scans suppress duplicates, ignore staging/nonce directories, and
count traversed directory entries against the existing scanner budget. Deletion
removes both copies. Old binaries cannot read the new sharded layout; take a
backup before upgrading rather than attempting an in-place binary downgrade.

Before the first quota-controlled mutation or cold repository open, a backend
without the quota marker adopts existing repository/object usage once. Adoption
streams at most 100,000 underlying entries and records owner totals with a
journal; it does not reset usage to zero on upgrade. Over-limit legacy usage is
retained and charged. Malformed ownership, orphaned objects, corrupt accounting,
or an adoption scan that exceeds the hard budget fail closed with 503. Stores
exceeding that bound require an offline migration reviewed against their actual
data before serving writes or opening a cold repository for reads; repeated HTTP
requests cannot bypass the bound. Cold opening uses the same owner transaction
because store loading can replay an interrupted recall and create an object.
Recovery charges new records once and preserves existing object usage. Creation
history from before the upgrade is unavailable, so new creation windows begin at
adoption.

## Metrics and residual abuse risk

`thaddeus_quota_limit{kind="..."}` exposes configured limits.
`thaddeus_quota_outcomes_total{outcome="..."}` exposes committed batches,
recovered journals and the fixed rejection codes above. Counters are local to
the process and reset on restart; enforcement accounting and windows do not.
Labels never contain DIDs, names, object IDs or content. Durable owner record
keys use a domain-separated prefix and a BLAKE3 digest of the public identity;
these opaque storage keys are not emitted as metrics.

A `did:key` identity is free to mint. An attacker can create fresh identities to
obtain fresh quotas and can grow the durable set of owner records. These limits
bound one identity, not one person or the entire host. Operators still need disk
monitoring, capacity planning and an admission policy suitable for their service
(for example invitations or paid accounts). Quotas do not solve Sybil attacks,
request-flood protection, or THA-10 mutation spam.

Verification commands and observed results are recorded in
[THA-146 verification](tha-146-verification.md).

Rejected uploads allocate no repository/object data. As with other authenticated
failures, they still consume a nonce in the separately bounded durable replay
store; those records expire under the existing replay policy.
