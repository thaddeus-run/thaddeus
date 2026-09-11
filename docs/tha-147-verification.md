# THA-147 verification — September 11, 2026

Implementation [PR #211](https://github.com/thaddeus-run/thaddeus/pull/211)
merged at 14:59:27 UTC as `00fc30e5feefd8fdb935cc21c917398374c47c89`. This
verification starts from that merged commit and changes only tests and evidence.
It covers THA-147 ([#209](https://github.com/thaddeus-run/thaddeus/issues/209))
and the THA-23 parent
([#76](https://github.com/thaddeus-run/thaddeus/issues/76)).

## Execution environment

The tests use the pinned Bun 1.3.14 and Moon 2.3.3 with `AGENT=1`. The compiled
test builds `packages/cli/src/bin.ts` into a standalone executable, starts its
`serve` command with `--data` pointing to an isolated temporary directory and
`--port 0`, and sends signed requests over real HTTP. Server restarts stop and
await the child process, then start another process over the same data.

Identities are generated independently. Working copies and CLI identity homes
are temporary child-process configuration; developer identities and production
data are not used. Each scenario cleans up its listener and temporary files.

## Observed exit criteria

The six compiled tests are in
[quota-compile.test.ts](../packages/cli/test/quota-compile.test.ts).

| Criterion                        | Observed result                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository quota and concurrency | Six concurrent creates with a limit of two return exactly two 201s and four 403s. Both below-limit and exact-boundary allocations succeed.                                                                                                                                                                                        |
| Object quota and concurrency     | Eight unique uploads across two repositories with an aggregate limit of two return exactly two 200s and six 403 `object_quota_exceeded` responses. The stored object keys match only the two winners; rejected uploads have no object records or Retry-After.                                                                     |
| Byte boundary                    | An object at its exact encoded-record byte limit returns 200. Lowering that limit by one byte returns 403 `object_bytes_quota_exceeded` with no stored object.                                                                                                                                                                    |
| Rejection and duplicates         | Duplicate uploads succeed without additional allocation. Over-limit uploads leave repository keys unchanged. Legacy repository over-allocation returns 403 `repository_quota_exceeded`.                                                                                                                                           |
| Independent identities           | While the first identity has exhausted repository, object, or creation capacity, a second independently signed identity creates and uploads successfully.                                                                                                                                                                         |
| Durable usage                    | New server processes over the same data still reject repository and object growth beyond the existing limits.                                                                                                                                                                                                                     |
| Durable rate state               | After restart and deletion, object creation still returns 429 `object_creation_rate_limited` with Retry-After. Repository churn reaches its creation limit and remains 429 after another process restart. Deletion does not refund creation events.                                                                               |
| Deletion cleanup                 | Deleting both repositories removes their keys. Creating a replacement and uploading succeeds, proving repository and object capacity reclamation. The route suite also checks encoded-byte reclamation and nested-repository protection.                                                                                          |
| Failed journal write             | A file occupying the generic `.staging` path permits reads but prevents the journal write. The upload returns 503 `quota_storage_unavailable`, leaves repository keys unchanged, and publishes no journal. After filesystem repair and process restart, the same upload succeeds with both object and creation limits set to one. |
| Pagination and second upload     | With page size one, compiled `repos` returns three repositories; compiled `clone`, `push`, a fresh `clone`, a second `push`, and `pull` preserve the exact first- and second-upload file contents.                                                                                                                                |
| Existing flat data               | While stopped, a seeded store is reconstructed as flat percent-encoded records with no quota ledger. The compiled server reads it, adopts its usage, accepts a duplicate, and rejects further owner allocations. A second identity remains operational. This is a legacy-layout fixture, not execution of an old binary.          |
| New shards and legacy deletion   | New encrypted records exist at `.records-v1/<sha256-prefix>/<encoded-key>` and have no flat copy. Deleting the legacy repository removes all its flat files and frees capacity for a new repository/upload.                                                                                                                       |

Repository-key assertions concern persistent repository/object allocation.
Authenticated rejection can still consume its bounded replay nonce; the tests do
not claim that rejected signed requests perform no storage activity at all.

## Route, storage, and browser regressions

[Server quota route tests](../packages/server/test/quotas.test.ts) run against
MemoryBackend and FileBackend with real authentication and routing. They cover
fail-closed configuration and corrupt records, exact creation-window expiry,
owner/delegate charging, bounded adoption, rejection before a cold object scan,
whole-bundle rollback, failed genesis, interrupted commits, prepared legacy
recall recovery, cache eviction, stale cursors, and deletion races.

The injected-backend route tests separately verify failures **after journal
publication**, undo accounting, and restart replay when rollback publication is
unavailable. The compiled filesystem test verifies a real **pre-commit journal
write failure**; it does not simulate power loss or claim post-commit rollback.
This distinction corrects the earlier evidence description in
[THA-146 verification](tha-146-verification.md), whose original
directory-at-object fixture actually failed during preflight.

[Persistence tests](../packages/persist/test/backend.test.ts) additionally check
flat/sharded duplicate suppression, lazy overwrite removal of the flat file,
deletion of both representations, and bounded scanners. The
[browser bundle regression](../packages/client/test/browser.test.ts) checks that
the SDK browser bundle has no Node builtin import. Metrics route tests check
fixed labels, absence of identity/repository data, and availability while quota
recovery is failing.

## Commands and observed output

Run from the repository root. The full verification uses `--force` so Moon
executes every affected test and typecheck rather than restoring cached results.

```bash
export AGENT=1
export PATH="/root/.proto/bin:$PATH"
moon run cli:test -- test/quota-compile.test.ts
moon run root:format root:lint
moon run --force server:test persist:test client:test cli:test store:test platform:test \
  server:typecheck persist:typecheck client:typecheck cli:typecheck \
  store:typecheck platform:typecheck
```

The focused compiled run returned exit 0:

```text
cli:test | 6 pass
cli:test | 0 fail
cli:test | 103 expect() calls
cli:test | Ran 6 tests across 1 file.
```

The full affected run returned exit 0, with **426 tests passing and zero
failures**:

| Project  | Passing tests | Typecheck |
| -------- | ------------: | --------- |
| server   |           160 | Passed    |
| persist  |            36 | Passed    |
| client   |            30 | Passed    |
| cli      |           101 | Passed    |
| store    |            50 | Passed    |
| platform |            49 | Passed    |

Formatting and lint returned exit 0. Lint reported 45 existing `require-await`
warnings and zero errors. The initial run caught an unnecessary type assertion
in the new test; it was removed before final verification.

## Completion scope

The implementation is merged and the local verification satisfies the listed
THA-147/THA-23 exit criteria. Closing references in the verification PR allow
the existing GitHub/Linear integration to close the linked verification and
parent issues on merge. Direct Linear access required reauthentication in this
session; no direct Linear status update is claimed.

This verifies core quotas, not Safe Agent Mode or production deployment. The
[documented operational limits](repository-quotas.md) remain: one process per
FileBackend root, bounded offline adoption for large legacy stores, contention
during large atomic deletions, and residual Sybil risk from freely minted
identities. General mutation/provenance/veto spam limits remain THA-10.
