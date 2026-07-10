# @thaddeus.run/watch

Live semantic subscriptions for **Thaddeus** — Pillar 11 (subscriptions slice).

`SemanticWatcher` turns the semantic graph (P08) into something you can
**subscribe to**: triggers that fire on _meaning_ — "tell me when this symbol is
renamed", "when a reference to it is added or removed", "when its definition
moves" — instead of coarse, path-level webhooks.

It works by **diffing graph snapshots**: `over(graph)` captures a baseline, and
each `poll()` re-derives the current graph, diffs it against the baseline, and
emits `SemanticEvent`s (`defined` / `removed` / `renamed` / `moved` /
`references-changed`), dispatching each to the standing `Subscription`s whose
filter it matches.

```ts
const watcher = await SemanticWatcher.over(graph);
const sub = watcher.watch({ symbol: id, kinds: ['renamed'] });
await graph.rename(id, 'refreshToken', author);
await watcher.poll();
sub.take(); // [{ kind: 'renamed', symbol: id, from: 'refresh', to: 'refreshToken' }]
```

## Remote polling

The CLI exposes this as:

```text
thaddeus watch [symbol] [--kind <event>]... [--interval <duration>] [--json]
```

The initial pull is a silent baseline. Later text output is line-oriented, and
`--json` emits one `SemanticEvent` per line as JSONL. Optional filters select a
stable symbol id (resolved from a current name, full id, or unique id prefix)
and repeatable event kinds; a symbol filter follows the same id through verified
signed renames.

Remote watching polls the existing atomic public-ciphertext pull route into an
isolated in-memory mirror. Full semantic graph derivation stays on the client
and remains bounded by its decryption capabilities. The mirror never updates or
cleans the checked-out files or durable working-copy store; `thaddeus pull`
remains explicit. Polls are sequential, transient errors retry without advancing
the baseline, and Ctrl-C exits cleanly.

> **Status: live polling.** `SemanticWatcher` itself remains snapshot-driven:
> events surface when its caller invokes `poll()`, and the CLI supplies the
> sequential background pull loop. Durable offline delivery, SSE/WebSockets,
> webhooks, an incremental (non-full-re-derive) diff, and `signature-changed`
> detection (which needs a real parser rather than the heuristic extractor) are
> deferred. No plaintext semantic index exists on the server.
