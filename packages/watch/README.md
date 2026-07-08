# @thaddeus.run/watch

Live semantic subscriptions for **Strata** (working name) — Pillar 11
(subscriptions slice).

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

> **Status: spike.** In-memory, single process, **pull-based** (events surface
> on `poll()`, not a background loop or push). Snapshot-diff detection is
> inherited from the graph's decryption boundary. A real push/webhook transport,
> an incremental (non-full-re-derive) diff, and `signature-changed` detection
> (needs a real parser, not the heuristic extractor) are deferred.
