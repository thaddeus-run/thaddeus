// Live query-surface demo for @thaddeus.run/query (Pillar 11, query slice).
// Run: CI= moon run example-query:demo
//
// Three acts: (1) the signed --why behind a change; (2) cross-cutting graph
// queries (who calls a symbol, where it's used); (3) the codebase over time —
// time-window and per-principal queries ("what did this agent touch, and when").

import { Workspace } from '@thaddeus.run/fs';
import { HeuristicExtractor, SymbolGraph } from '@thaddeus.run/graph';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import { CodeDB } from '@thaddeus.run/query';
import { MemoryStore } from '@thaddeus.run/store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const rule = (): void => console.log('—'.repeat(60));

await ready();
const store = new MemoryStore();
const log = new OpLog(store);
const dev = Identity.create();
const agent = Identity.create();

// Dev authors a definition + a caller, then renames it as one signed op with a
// "why" bound to the rendered change.
const ws = Workspace.open(log, store, { source: 'main', reader: dev });
ws.write(
  'src/auth.rs',
  enc('fn refresh() {}\nfn login() {\n  refresh();\n}\n')
);
await ws.commit(dev);
const graph = SymbolGraph.over(ws, { extractor: new HeuristicExtractor() });
const prov = new ProvenanceLog(store);
const rid = (await graph.resolve('refresh'))!;
const { ops } = await graph.rename(rid, 'refreshToken', dev);
await prov.record(
  ops[0],
  {
    intent: 'clarify token refresh',
    reasoning: 'the name shadowed a field; renamed the symbol',
    actorKind: 'agent:claude-code@1.2',
  },
  dev
);

// An untrusted agent touches a file at a fixed point in the past.
const AGENT_AT = '2020-06-15T09:15:00.000Z';
await log.write('main', 'src/telemetry.rs', enc('fn beacon() {}'), agent, {
  at: AGENT_AT,
});

const db = CodeDB.over({ graph, log, provenance: prov });

// Act 1 — the signed --why behind a change.
rule();
console.log('1. --why behind the rename:');
const w = db.why(ops[0].id);
console.log('   verified:', w.verified);
console.log(
  '   intent:  ',
  w.why.map((p) => p.intent)
);

// Act 2 — cross-cutting graph queries.
rule();
console.log('2. query the code as a graph:');
const rt = (await graph.resolve('refreshToken'))!;
console.log(
  '   callers(refreshToken):   ',
  (await db.callers(rt)).map((c) => c.definition?.name)
);
console.log(
  '   references(refreshToken):',
  (await db.references('refreshToken')).map((r) => `${r.path}:${r.line}`)
);

// Act 3 — the codebase over time (needs the signed op.at, P03).
rule();
console.log('3. the codebase over time & by principal:');
console.log(
  '   touchedSince(2000):        ',
  db.touchedSince('2000-01-01T00:00:00.000Z').length,
  'ops'
);
console.log(
  '   by(agent):                 ',
  db.by(agent.did).map((o) => o.path)
);
console.log(
  '   touchedBetween(2020 window):',
  db
    .touchedBetween('2020-01-01T00:00:00.000Z', '2020-12-31T23:59:59.000Z')
    .map((o) => o.path)
);

rule();
console.log(
  'Acceptance: every change carries a verifiable why; the graph is queryable;'
);
console.log(
  'and the signed op.at makes "what did X touch, and when" a first-class query.'
);
