import { Workspace } from '@thaddeus.run/fs';
import { HeuristicExtractor, SymbolGraph } from '@thaddeus.run/graph';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { CodeDB } from '../src/codedb';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const PAST = '2000-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

async function seed(): Promise<{
  log: OpLog;
  author: Identity;
  ops: readonly import('@thaddeus.run/log').Op[];
  graph: SymbolGraph;
  provenance: ProvenanceLog;
  db: CodeDB;
}> {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const author = Identity.create();
  const ws = Workspace.open(log, store, { source: 'main', reader: author });
  ws.write(
    'src/auth.rs',
    enc('fn refresh() {}\nfn login() {\n  refresh();\n}\n')
  );
  const ops = await ws.commit(author);
  const graph = SymbolGraph.over(ws, { extractor: new HeuristicExtractor() });
  const provenance = new ProvenanceLog(store);
  const db = CodeDB.over({ graph, log, provenance });
  return { log, author, ops, graph, provenance, db };
}

describe('CodeDB — the query surface', () => {
  test('why returns the verified provenance bound to an op', async () => {
    const { ops, provenance, author, db } = await seed();
    const op = ops[0];
    await provenance.record(
      op,
      { intent: 'fix refresh', reasoning: 'race', actorKind: 'agent:x' },
      author
    );
    const w = db.why(op.id);
    expect(w.verified).toBe(true);
    expect(w.op?.id).toBe(op.id);
    expect(w.why.map((p) => p.intent)).toContain('fix refresh');
  });

  test('why on an op with no provenance is empty and unverified', async () => {
    const { ops, db } = await seed();
    const w = db.why(ops[0].id);
    expect(w.why).toEqual([]);
    expect(w.verified).toBe(false);
  });

  test('a genuine why stays verified alongside an unverifiable (forged) record', async () => {
    const { ops, provenance, author, db } = await seed();
    const op = ops[0];
    const good = await provenance.record(
      op,
      { intent: 'genuine', reasoning: 'real reason', actorKind: 'agent:x' },
      author
    );
    // Keep-and-label: a peer attaches a forged record (good's signature over a
    // tampered field). It is kept but does not verify — and must NOT poison the
    // genuine why.
    provenance.append({ ...good, reasoning: 'a plausible lie' });
    const w = db.why(op.id);
    expect(w.why).toHaveLength(2);
    expect(w.verified).toBe(true);
  });

  test('touchedSince / touchedBetween filter by wall-clock', async () => {
    const { ops, db } = await seed();
    const ids = ops.map((o) => o.id);
    expect(db.touchedSince(PAST).map((o) => o.id)).toEqual(
      expect.arrayContaining(ids)
    );
    expect(db.touchedSince(FUTURE)).toEqual([]);
    expect(db.touchedBetween(PAST, FUTURE).map((o) => o.id)).toEqual(
      expect.arrayContaining(ids)
    );
    expect(
      db.touchedBetween('2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z')
    ).toEqual([]);
  });

  test('by filters to a principal, honoring an optional window', async () => {
    const { ops, author, db } = await seed();
    const other = Identity.create();
    expect(db.by(author.did).map((o) => o.id)).toEqual(
      expect.arrayContaining(ops.map((o) => o.id))
    );
    expect(db.by(other.did)).toEqual([]);
    expect(db.by(author.did, { from: FUTURE })).toEqual([]);
  });

  test('an invalid time bound throws rather than matching nothing', async () => {
    const { db } = await seed();
    expect(() => db.touchedSince('not-a-date')).toThrow(RangeError);
    expect(() => db.touchedBetween(PAST, 'nope')).toThrow(RangeError);
  });

  test('callers joins a symbol to its callers + their defs; references resolves by name', async () => {
    const { graph, db } = await seed();
    const refresh = (await graph.resolve('refresh'))!;
    const login = (await graph.resolve('login'))!;
    const callers = await db.callers(refresh);
    expect(callers.map((c) => c.symbol.id)).toContain(login);
    expect(callers.find((c) => c.symbol.id === login)?.definition?.name).toBe(
      'login'
    );
    expect((await db.references('refresh')).map((r) => r.line)).toContain(3);
    expect(await db.references('does-not-exist')).toEqual([]);
  });

  test('a pinned wall-clock lands in exact time-window boundaries', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const at = '2026-07-07T12:00:00.000Z';
    const op = await log.write('main', 'a.ts', enc('x'), author, { at });
    const graph = SymbolGraph.over(
      Workspace.open(log, store, { source: 'main', reader: author }),
      { extractor: new HeuristicExtractor() }
    );
    const db = CodeDB.over({
      graph,
      log,
      provenance: new ProvenanceLog(store),
    });
    expect(db.touchedBetween(at, at).map((o) => o.id)).toEqual([op.id]);
    expect(
      db.touchedBetween('2026-07-07T12:00:00.001Z', '2026-07-07T13:00:00.000Z')
    ).toEqual([]);
  });
});
