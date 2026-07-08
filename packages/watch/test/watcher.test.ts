import { Workspace } from '@thaddeus.run/fs';
import { HeuristicExtractor, SymbolGraph } from '@thaddeus.run/graph';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { type SemanticEvent, SemanticWatcher } from '../src/watcher';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

async function seed(): Promise<{
  ws: Workspace;
  graph: SymbolGraph;
  dev: Identity;
}> {
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
  return { ws, graph, dev };
}

describe('SemanticWatcher — subscriptions fire on meaning', () => {
  test('a rename fires a renamed event to a symbol subscription', async () => {
    const { graph, dev } = await seed();
    const id = (await graph.resolve('refresh'))!;
    const watcher = await SemanticWatcher.over(graph);
    const sub = watcher.watch({ symbol: id, kinds: ['renamed'] });

    await graph.rename(id, 'refreshToken', dev);
    const events = await watcher.poll();

    const expected: SemanticEvent = {
      kind: 'renamed',
      symbol: id,
      from: 'refresh',
      to: 'refreshToken',
    };
    expect(events).toContainEqual(expected);
    expect(sub.take()).toEqual([expected]);
  });

  test('defining and removing a symbol fire defined/removed', async () => {
    const { ws, graph, dev } = await seed();
    const watcher = await SemanticWatcher.over(graph);
    const sub = watcher.watch({ kinds: ['defined', 'removed'] });

    ws.write('src/extra.rs', enc('fn helper() {}'));
    ws.write('src/auth.rs', enc('fn refresh() {}\n')); // login (and its call) gone
    await ws.commit(dev);
    await watcher.poll();

    const events = sub.take();
    expect(
      events.some((e) => e.kind === 'defined' && e.name === 'helper')
    ).toBe(true);
    expect(events.some((e) => e.kind === 'removed' && e.name === 'login')).toBe(
      true
    );
  });

  test('adding a caller fires references-changed for the callee', async () => {
    const { ws, graph, dev } = await seed();
    const refresh = (await graph.resolve('refresh'))!;
    const watcher = await SemanticWatcher.over(graph);
    const sub = watcher.watch({
      symbol: refresh,
      kinds: ['references-changed'],
    });

    ws.write(
      'src/auth.rs',
      enc(
        'fn refresh() {}\nfn login() {\n  refresh();\n}\nfn retry() {\n  refresh();\n}\n'
      )
    );
    await ws.commit(dev);
    await watcher.poll();

    const events = sub.take();
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe('references-changed');
    if (e.kind === 'references-changed') {
      expect(e.added.map((r) => r.line)).toContain(6); // the new refresh() call
    }
  });

  test('poll advances the baseline: a second poll with no change is empty', async () => {
    const { graph, dev } = await seed();
    const id = (await graph.resolve('refresh'))!;
    const watcher = await SemanticWatcher.over(graph);
    await graph.rename(id, 'refreshToken', dev);
    expect((await watcher.poll()).length).toBeGreaterThan(0);
    expect(await watcher.poll()).toEqual([]);
  });

  test('overlapping poll() calls coalesce — delivered exactly once', async () => {
    const { graph, dev } = await seed();
    const id = (await graph.resolve('refresh'))!;
    const watcher = await SemanticWatcher.over(graph);
    const sub = watcher.watch({ symbol: id, kinds: ['renamed'] });

    await graph.rename(id, 'refreshToken', dev);
    // Two polls in flight at once must not race the baseline: one diff, one event.
    const [a, b] = await Promise.all([watcher.poll(), watcher.poll()]);
    expect(a).toBe(b); // the second call reused the in-flight poll
    expect(sub.take()).toHaveLength(1); // delivered exactly once
  });

  test('a filter scopes delivery; unwatch stops it', async () => {
    const { graph, dev } = await seed();
    const refresh = (await graph.resolve('refresh'))!;
    const login = (await graph.resolve('login'))!;
    const watcher = await SemanticWatcher.over(graph);
    const onlyLogin = watcher.watch({ symbol: login });
    const onlyRefresh = watcher.watch({ symbol: refresh });

    await graph.rename(refresh, 'refreshToken', dev);
    await watcher.poll();
    expect(onlyLogin.take()).toEqual([]); // login is untouched
    expect(onlyRefresh.take()).toHaveLength(1);

    watcher.unwatch(onlyRefresh);
    await graph.rename(refresh, 'refreshAgain', dev);
    await watcher.poll();
    expect(onlyRefresh.take()).toEqual([]); // unwatched, no delivery
  });
});
