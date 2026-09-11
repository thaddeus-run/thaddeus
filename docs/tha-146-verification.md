# THA-146 verification — September 11, 2026

Implementation: THA-146 /
[GitHub #208](https://github.com/thaddeus-run/thaddeus/issues/208).
Verification:
[GitHub #209](https://github.com/thaddeus-run/thaddeus/issues/209), “Verify
quota enforcement across restart, concurrency, and a second identity”. This
evidence covers THA-23 quotas, not Safe Agent Mode or production deployment.

Branch:
`feature/tha-146-enforce-durable-repositoryobject-quotas-and-creation-rate`.
Toolchain: the repository's pinned Bun 1.3.14 and moon 2.3.3, with `AGENT=1`.

## Real compiled CLI and server

`packages/cli/test/quota-compile.test.ts` compiles `src/bin.ts` into a
standalone executable, starts that executable's `serve` command on an
OS-assigned port, and makes signed requests over real HTTP. Every server uses a
temporary data directory. CLI working copies and identity configuration are
isolated in child processes. Restart stops the server process and starts a new
process over the same directory; it does not reuse an in-memory backend or
server object.

Run the focused evidence with:

```bash
export AGENT=1
moon run cli:test -- test/quota-compile.test.ts
```

The compiled scenarios are also included in the complete CLI suite below:

| Scenario                       | Observed assertions                                                                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository concurrency         | Six concurrent creates with a two-repository limit yield exactly two 201 responses and four 403 responses.                                                                                                           |
| Independent identity           | A second independently minted identity creates and uploads successfully while the first is exhausted.                                                                                                                |
| Object boundary                | Two concurrent object uploads across two repositories succeed at a two-object aggregate limit; the next returns 403 `object_quota_exceeded`.                                                                         |
| Duplicate and rejected uploads | A duplicate upload returns 200; a rejected upload adds no repository keys. Replay nonce consumption is accounted separately.                                                                                         |
| Byte boundary                  | An object at the exact encoded byte limit returns 200; the same object with the limit reduced by one byte returns 403 `object_bytes_quota_exceeded` and leaves no object record.                                     |
| Restart                        | Fresh server processes retain repository/object usage and both creation-window states.                                                                                                                               |
| Deletion and rate              | Deletion frees storage; the next upload can still return 429 `object_creation_rate_limited` because deletion does not refund creation. Repository churn similarly reaches 429 with `Retry-After`.                    |
| Filesystem failure             | A directory deliberately occupying an object destination forces 503; after removing the fault and restarting, journal recovery refunds the failed attempt and an upload at a one-object/one-creation limit succeeds. |
| Shipped pagination             | Compiled `repos` traverses multiple pages with page size 1. Compiled `clone`, first `push`, fresh `clone`, second `push`, and `pull` preserve the exact file contents.                                               |

The second-upload test found that `Client.land` fetched only one page of signed
head history. It now uses the existing THA-9 cursor collector before chain
verification. No server pagination implementation was replaced.

## Route and storage coverage

`packages/server/test/quotas.test.ts` exercises `createServer.fetch` with real
signed envelopes against MemoryBackend and FileBackend. It covers quota and
window boundaries, concurrent repository/object mutations, duplicate uploads,
owner/delegate accounting, independent identities, deletion, restart, corrupt
records, an interrupted commit, a failed genesis, failed object writes, a
bounded legacy-adoption scan, and early rejection before a cold object scan.

A route test also cycles unauthorized uploads across 130 repositories and
verifies that an evicted delegation registry reloads from storage.

The deletion test preserves a second owner's nested repository and its quota
when deleting a parent name prefix. Whole-bundle quota rejection discards
earlier staged objects and their hot cache. The metrics test verifies fixed
labels and absence of repository names and public identity strings.

`packages/persist/test/backend.test.ts` covers shard writes and scans, restart,
flat-file reads, lazy overwrite migration, duplicate suppression after an
interrupted migration, and deletion of both layouts. Legacy server metadata is
adopted into owner accounting before a new create can bypass its existing usage.

## Verification commands and output

```bash
export AGENT=1
moon run root:format root:lint
moon run server:test persist:test client:test cli:test store:test platform:test \
  server:typecheck persist:typecheck client:typecheck cli:typecheck \
  store:typecheck platform:typecheck
```

The affected suites completed with **415 passing tests and zero failures**:

| Project                                      | Passing tests |
| -------------------------------------------- | ------------: |
| server                                       |           151 |
| persist                                      |            36 |
| client                                       |            29 |
| cli, including four compiled quota scenarios |            99 |
| store                                        |            50 |
| platform                                     |            49 |

All six affected typechecks passed. Formatting and lint are part of the required
final verification; existing `require-await` warnings are not test failures.

## Scope and completion tracking

The implementation and evidence are ready for review; this file does not assert
that a PR has merged or that a deployed service was tested. Linear access in
this session required reauthentication, so Linear completion state could not be
updated. GitHub #209 supplied the verification criteria. Keep the parent and
verification issue open until the implementation PR and this evidence are linked
and the project accepts their exit criteria.

The supported coordination domain is one process per FileBackend root. The
bounded legacy adoption limit and residual risk from freely minted identities
are documented in [repository quotas](repository-quotas.md).
