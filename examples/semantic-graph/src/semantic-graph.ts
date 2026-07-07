// Semantic graph demo for @thaddeus.run/graph (Pillar 08).
// Run: CI= moon run example-semantic-graph:demo
//
// Three acts: (1) code is a graph you query — resolve/definitionOf/
// referencesTo/callersOf; (2) rename is ONE signed operation, rendered across
// the definition and every reference, with identity preserved; (3) the graph
// stops at the capability boundary — an undecryptable definition is invisible.

import { Workspace } from '@thaddeus.run/fs';
import {
  HeuristicExtractor,
  SymbolGraph,
  verifySymbolOp,
} from '@thaddeus.run/graph';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null): string =>
  b === null ? '(unreadable)' : new TextDecoder().decode(b);
const rule = (): void => console.log('—'.repeat(60));

await ready();
const store = new MemoryStore();
const log = new OpLog(store);
const dev = Identity.create();

// Seed: a definition `fn refresh()` and a caller `fn login()` that calls it.
const ws = Workspace.open(log, store, { source: 'main', reader: dev });
ws.write(
  'src/auth.rs',
  enc('fn refresh() {}\nfn login() {\n  refresh();\n}\n')
);
await ws.commit(dev);
const g = SymbolGraph.over(ws, { extractor: new HeuristicExtractor() });

// Act 1 — code is a graph you query.
const id = (await g.resolve('refresh'))!;
rule();
console.log('1. code is a graph you query (not a pile of text):');
console.log('   resolve("refresh") →', id.slice(0, 16), '…');
console.log('   definitionOf       →', await g.definitionOf(id));
console.log('   referencesTo       →', await g.referencesTo(id));
console.log(
  '   callersOf          →',
  (await g.callersOf(id)).map((s) => s.id.slice(0, 8))
);

// Act 2 — rename is ONE signed operation, rendered everywhere.
const { symbolOp, ops } = await g.rename(id, 'refreshToken', dev);
rule();
console.log('2. rename is ONE signed op, rendered across every reference:');
console.log(
  '   SymbolOp            →',
  symbolOp.kind,
  symbolOp.from,
  '→',
  symbolOp.to,
  `(verify: ${verifySymbolOp(symbolOp)})`
);
console.log(`   rendered as         → ${ops.length} signed P03 text op(s)`);
console.log('   src/auth.rs now     →');
console.log(
  dec(await ws.read('src/auth.rs'))
    .split('\n')
    .map((l) => '     ' + l)
    .join('\n')
);
console.log(
  '   identity survived   → resolve("refreshToken") === original id:',
  (await g.resolve('refreshToken')) === id
);
console.log(
  '   history(id)         →',
  g.history(id).map((h) => `${h.from}→${h.to}`)
);

// Act 3 — the graph stops at the capability boundary. Two authors land on the
// same `main`: Alice's code (which Alice can decrypt) and Mallory's ungranted
// secret (which Alice cannot). Alice's graph sees her own symbol, not Mallory's.
const store2 = new MemoryStore();
const log2 = new OpLog(store2);
const alice = Identity.create();
const mallory = Identity.create();
await log2.write('main', 'src/app.rs', enc('fn greet() {}'), alice);
await log2.write('main', 'src/secret.rs', enc('fn hidden() {}'), mallory);
const view = Workspace.open(log2, store2, { source: 'main', reader: alice });
const bounded = SymbolGraph.over(view, { extractor: new HeuristicExtractor() });
rule();
console.log('3. the graph is bounded by what you can decrypt:');
console.log(
  '   secret path listed  →',
  (await view.list()).includes('src/secret.rs')
);
console.log('   resolve("greet")    →', await bounded.resolve('greet'));
console.log('   resolve("hidden")   →', await bounded.resolve('hidden'));
console.log(
  '   symbols visible     →',
  (await bounded.symbols()).map((s) => s.id.slice(0, 8))
);

rule();
console.log(
  'Acceptance: meaning is queryable; a rename is one signed op rendered'
);
console.log(
  'everywhere with a stable identity; the graph stops at the capability line.'
);
