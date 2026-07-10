# P8 Watch / Subscriptions Design

**Date:** 2026-07-10 **Status:** Approved

## Context

P8 exposes the live-subscription substrate that already exists in
`@thaddeus.run/watch`. `SemanticWatcher` can diff two decryptable semantic-graph
snapshots and emit `defined`, `removed`, `renamed`, `moved`, and
`references-changed` events, but today callers must assemble and poll the graph
themselves. The CLI has no long-running watch command, and lazythad refreshes
only when the user presses `r`.

P1's atomic `/pull` route is now the polling primitive. The server remains an
untrusted ciphertext mirror and cannot derive semantic events because it does
not have readers' decryption keys. Event detection therefore belongs on the
client.

## Goals

- Add an observer-only `thaddeus watch` command that streams semantic events
  from a remote branch.
- Preserve stable symbol identity across signed remote renames.
- Support human-readable output and newline-delimited JSON for automation.
- Allow optional filtering by stable symbol and event kind.
- Make lazythad update automatically without blocking keyboard input.
- Keep both surfaces responsive through transient network failures.

## Non-goals

- No SSE, WebSocket, webhook, or new server endpoint.
- No server-side semantic index or server-side decryption.
- No mutation of checked-out files, the working-copy branch, its saved base, its
  configuration, or its durable object store.
- No durable subscription registry or notification delivery while the watcher is
  offline.
- No incremental parser/index work; P8 retains the existing full graph
  re-derivation and heuristic extractor.
- No changes to the existing explicit `thaddeus pull` workflow.

## Chosen approach

`thaddeus watch` maintains an isolated in-memory mirror. It performs one atomic
pull to establish a baseline, then repeats the same pull at a configurable
interval. Each successful pull advances the mirror's private view and asks
`SemanticWatcher` to diff the new decryptable graph against its previous
snapshot.

This was chosen over a hidden durable watch view because it cannot contend with
or leave state in the working copy's shared store. It was chosen over a push
transport because a server notification would only say that ciphertext changed;
the client would still need to pull and decrypt before it could produce a
semantic event.

## CLI contract

```text
thaddeus watch [symbol] [--kind <event>]... [--interval <duration>] [--json]
```

- The command runs from a Thaddeus working copy and watches that copy's remote
  repo and current branch.
- With no positional `symbol`, every visible symbol is watched. A symbol may be
  a current name, a full stable id, or a unique id prefix. Resolution happens
  against the initial baseline, so the filter keeps following the same identity
  after a rename.
- `--kind` is repeatable. Valid values are `defined`, `removed`, `renamed`,
  `moved`, and `references-changed`. With no `--kind`, every kind is emitted.
- `--interval` accepts `ms`, `s`, or `m` duration suffixes, defaults to `2s`,
  and rejects values below `100ms`.
- The initial pull captures a baseline and emits no historical events.
- Text mode prints one concise line per event. `--json` writes one serialized
  `SemanticEvent` per line, making the stream JSONL rather than one never-ending
  JSON array.
- Diagnostics never enter stdout in JSON mode. Initial setup failures return a
  non-zero exit code; transient polling failures go to stderr and are retried.
- Ctrl-C aborts the pending wait, removes the signal handler, and exits cleanly.

## Components and data flow

### In-memory remote mirror

A small watch runner in the CLI package owns a `MemoryBackend`, `Client`, and
private `Repo`. `Client.clone` performs the baseline pull. Later iterations call
`Client.pull` against the same in-memory repo and branch. Pull responses remain
atomic at the HTTP boundary, ingestion is content-addressed and idempotent, and
the private branch is repointed only after the response has been decoded and
ingested.

The runner accepts an `AbortSignal`, clock/sleep seam, event callback, and error
callback. This keeps the polling loop sequential and single-flight and makes it
testable without real time or process signals.

### Semantic graph and subscription

The private repo is opened as a `Workspace` with the user's identity as reader,
then projected through `SymbolGraph` and `SemanticWatcher`. The existing
decryption boundary is preserved: content for which the identity has no valid
capability is absent from both the baseline and later snapshots.

The optional CLI filters are registered as one `Subscription`. The runner polls
the watcher after every successful remote pull and drains only the events that
match that subscription.

### Stable identity across remote renames

An in-process rename already preserves identity because `SymbolGraph.rename`
rebinds its `SymbolLedger`. A remote pull changes text and adds signed
`SymbolOp`s, so P8 must perform the equivalent ledger update before diffing.

At startup, the graph/watch layer hydrates the ledger from the complete signed
`SymbolOpLog`: it reconstructs each chain's birth name and final current name,
matches the deterministic birth id against the current definition's path and
kind, and binds that current definition to the signed stable id. Before each
later snapshot, newly ingested rename records are verified and replayed into the
same ledger in causal log order.

This makes a pulled rename produce one `renamed` event with the stable symbol
id, not an unrelated `removed` plus `defined` pair. Malformed, unverifiable, or
non-causal rename hints are ignored by the event reconciler; the underlying
snapshot diff remains safe and may fall back to structural events.

No new signed record or wire field is introduced.

### CLI integration

The command parser resolves the current working-copy configuration and identity,
validates filters and interval, and starts the watch runner. The runner lives in
a focused module rather than extending the already large `run.ts` with polling
state. `run.ts` only handles argument parsing, output formatting, and lifecycle
wiring.

The CLI package adds `@thaddeus.run/watch` as a workspace dependency and reuses
its existing graph, client, platform, and persistence dependencies.

### Lazythad live updates

Lazythad continues to read public mirror metadata; it does not attempt to derive
semantic events without keys. A background refresh worker periodically fetches
the repo list and the selected repo's pull/releases. The terminal thread only
schedules work and applies completed messages, so a slow remote never blocks
keyboard handling or drawing.

Only one refresh may be in flight. Each result carries the selected repo and
view it was requested for; stale results are discarded if the selection changed
while the request was running. Applying a fresh result preserves selection by
repo name, op id, and release id where those records still exist, otherwise it
clamps to the nearest valid row. Automatic refresh does not dismiss an open
query or reputation overlay.

The last good data stays visible when a refresh fails. The status line reports
the error and the next interval retries. Manual `r` remains available and asks
the same worker for an immediate refresh.

## Error and concurrency behavior

- The watch polling loop is sequential; an interval cannot overlap a prior pull
  or graph derivation.
- A failed poll does not advance the semantic baseline. The next successful pull
  therefore emits the complete change since the last successful snapshot.
- Repeated pulls are safe because encrypted objects, operations, capabilities,
  and semantic records ingest idempotently.
- A partially ingested local mirror after an ingestion error is harmless: the
  private view is not repointed, and retrying the same bundle completes it.
- JSONL stdout remains machine-readable; diagnostics use stderr.
- TUI refresh messages are non-blocking, single-flight, and selection-scoped.

## Testing

### TypeScript

- Extend `@thaddeus.run/watch` tests for ledger hydration from historical rename
  chains and replay of newly pulled signed renames.
- Add CLI watch tests that prove the initial baseline is silent and later pulls
  emit each semantic event kind.
- Test symbol and kind filters, name/id/prefix resolution, invalid/too-short
  intervals, human output, and JSONL output.
- Test transient failure followed by recovery, sequential polling, and abort
  cleanup with injected sleep/signal seams.
- Assert that a dirty working copy, its config, base, files, and durable store
  are byte-for-byte unchanged by a bounded watch run.
- Add an integration test over the real in-process server/client path for a
  remote signed rename, asserting one stable-id `renamed` event rather than
  `removed` plus `defined`.

### Rust

- Test scheduling and applying background refresh messages without blocking.
- Test that stale results are discarded.
- Test repo/op/release selection preservation and fallback when selected items
  disappear.
- Test that refresh errors retain the last good data and remain retryable.

### Repository verification

Run the focused watch, CLI, client/server integration, and lazythad tests and
typechecks, followed by the repository baseline:

```bash
moon run root:format root:lint
```

## Documentation and roadmap

Update CLI help/README, the watch package README, lazythad help/README,
getting-started/deployment documentation where relevant, the changelog, and the
post-P3 roadmap. Mark P8 shipped only after the focused and baseline
verification commands pass.
