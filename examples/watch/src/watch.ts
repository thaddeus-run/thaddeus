// Live semantic-subscriptions demo for @thaddeus.run/watch (Pillar 11, Slice 2).
// Run: CI= moon run example-watch:demo
//
// Three acts: (1) a rename fires a semantic event on the SYMBOL (not a path);
// (2) a new caller fires references-changed on the callee; (3) a scoped
// subscription stays quiet for an unrelated change while a lifecycle
// subscription fires. Triggers fire on meaning, surfaced by poll().

import { Workspace } from '@thaddeus.run/fs';
import { HeuristicExtractor, SymbolGraph } from '@thaddeus.run/graph';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { type SemanticEvent, SemanticWatcher } from '@thaddeus.run/watch';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const rule = (): void => console.log('—'.repeat(60));

function fmt(e: SemanticEvent): string {
  switch (e.kind) {
    case 'renamed':
      return `renamed ${e.from}→${e.to}`;
    case 'defined':
      return `defined ${e.name} (${e.path})`;
    case 'removed':
      return `removed ${e.name}`;
    case 'moved':
      return `moved ${e.symbol.slice(0, 8)}`;
    case 'references-changed':
      return `references-changed +${e.added.length}/-${e.removed.length}`;
  }
}
const show = (label: string, events: readonly SemanticEvent[]): void =>
  console.log(`   ${label}`, events.map(fmt));

await ready();
const store = new MemoryStore();
const log = new OpLog(store);
const dev = Identity.create();
const ws = Workspace.open(log, store, { source: 'main', reader: dev });
ws.write(
  'src/auth.rs',
  enc('fn refresh() {}\nfn login() {\n  refresh();\n}\n')
);
await ws.commit(dev);
const graph = SymbolGraph.over(ws, { extractor: new HeuristicExtractor() });
const refresh = (await graph.resolve('refresh'))!;

const watcher = await SemanticWatcher.over(graph);
const onRefresh = watcher.watch({ symbol: refresh }); // anything about `refresh`
const onDefs = watcher.watch({ kinds: ['defined', 'removed'] }); // lifecycle anywhere

// Act 1 — a rename fires a semantic event on the symbol.
await graph.rename(refresh, 'refreshToken', dev);
await watcher.poll();
rule();
console.log('1. rename → a semantic event on the SYMBOL, not a path:');
show('onRefresh:', onRefresh.take());

// Act 2 — a new caller fires references-changed on the callee.
ws.write(
  'src/auth.rs',
  enc(
    'fn refreshToken() {}\nfn login() {\n  refreshToken();\n}\nfn retry() {\n  refreshToken();\n}\n'
  )
);
await ws.commit(dev);
await watcher.poll();
rule();
console.log('2. a new caller → references-changed on the callee:');
show('onRefresh:', onRefresh.take());
show('onDefs:   ', onDefs.take()); // `retry` was defined

// Act 3 — a scoped subscription stays quiet for an unrelated change.
ws.write('src/util.rs', enc('fn helper() {}'));
await ws.commit(dev);
await watcher.poll();
rule();
console.log(
  '3. an unrelated new symbol → lifecycle fires, scoped sub is quiet:'
);
show('onDefs:   ', onDefs.take()); // defined helper
show('onRefresh:', onRefresh.take()); // [] — helper is not about refresh

rule();
console.log(
  'Acceptance: subscriptions fire on meaning (rename, references, lifecycle),'
);
console.log(
  'are scoped by symbol/kind, and surface on poll() — no path webhooks.'
);
