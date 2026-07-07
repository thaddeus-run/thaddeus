import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { SymbolGraph } from '../src/graph';
import { HeuristicExtractor } from '../src/symbol';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// A repo with `fn refresh()` and a caller `fn login()` that calls refresh().
async function seed(): Promise<{ ws: Workspace; g: SymbolGraph }> {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const dev = Identity.create();
  const ws = Workspace.open(log, store, { source: 'main', reader: dev });
  ws.write(
    'src/auth.rs',
    enc('fn refresh() {}\nfn login() {\n  refresh();\n}\n')
  );
  await ws.commit(dev);
  const g = SymbolGraph.over(ws, { extractor: new HeuristicExtractor() });
  return { ws, g };
}

describe('SymbolGraph — read model', () => {
  test('resolve maps a name to a stable id; definitionOf reports the site', async () => {
    const { g } = await seed();
    const id = await g.resolve('refresh');
    expect(id).not.toBeNull();
    expect(await g.resolve('refresh')).toBe(id); // stable across queries
    const def = await g.definitionOf(id!);
    expect(def).toMatchObject({
      name: 'refresh',
      path: 'src/auth.rs',
      line: 1,
    });
  });

  test('referencesTo includes the call site; callersOf includes login', async () => {
    const { g } = await seed();
    const refresh = (await g.resolve('refresh'))!;
    const login = (await g.resolve('login'))!;
    expect(await g.referencesTo(refresh)).toEqual([
      { symbol: refresh, path: 'src/auth.rs', line: 3 },
    ]);
    expect((await g.callersOf(refresh)).map((s) => s.id)).toContain(login);
  });

  test('symbols and edges expose the whole decryptable graph', async () => {
    const { g } = await seed();
    expect((await g.symbols()).length).toBe(2); // refresh, login
    const refresh = (await g.resolve('refresh'))!;
    const login = (await g.resolve('login'))!;
    expect(await g.edges()).toEqual(
      expect.arrayContaining([
        { kind: 'calls', from: login, to: refresh },
        { kind: 'references', from: login, to: refresh },
      ])
    );
  });

  test('the graph is decryption-bounded: an ungranted def is invisible', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const dev = Identity.create();
    const other = Identity.create();
    // `other` writes an ungranted secret to main; `dev` cannot decrypt it.
    await log.write('main', 'src/secret.rs', enc('fn hidden() {}'), other);
    const ws = Workspace.open(log, store, { source: 'main', reader: dev });
    const g = SymbolGraph.over(ws, { extractor: new HeuristicExtractor() });
    expect(await ws.list()).toContain('src/secret.rs'); // path visible
    expect(await g.resolve('hidden')).toBeNull(); // meaning not
    expect((await g.symbols()).length).toBe(0);
  });
});
