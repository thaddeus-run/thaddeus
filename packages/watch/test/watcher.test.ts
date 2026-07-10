import { Workspace } from '@thaddeus.run/fs';
import {
  HeuristicExtractor,
  signSymbolOp,
  SymbolGraph,
} from '@thaddeus.run/graph';
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

  test('a pulled rename keeps its stable id across a fresh watcher', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const dev = Identity.create();
    const remote = Workspace.open(log, store, {
      source: 'main',
      reader: dev,
      name: 'remote',
    });
    remote.write(
      'src/auth.rs',
      enc('fn refresh() {}\nfn login() {\n  refresh();\n}\n')
    );
    await remote.commit(dev);
    const source = SymbolGraph.over(remote, {
      extractor: new HeuristicExtractor(),
    });
    const stable = (await source.resolve('refresh'))!;
    const first = await source.rename(stable, 'refreshToken', dev);

    const mirror = Workspace.open(log, store, {
      source: 'remote',
      reader: dev,
      name: 'watch/mirror',
    });
    const graph = SymbolGraph.over(mirror, {
      extractor: new HeuristicExtractor(),
    });
    await graph.syncRenames([first.symbolOp]);
    expect(await graph.resolve('refreshToken')).toBe(stable);

    const watcher = await SemanticWatcher.over(graph);
    const sub = watcher.watch({ symbol: stable, kinds: ['renamed'] });
    const second = await source.rename(stable, 'refreshAgain', dev);
    const forged = { ...second.symbolOp, to: 'forged' };
    await graph.syncRenames([first.symbolOp, forged]);
    expect(await graph.resolve('refreshToken')).toBe(stable);
    await log.repoint('watch/mirror', [...log.heads('remote')]);
    await graph.syncRenames([first.symbolOp, second.symbolOp]);
    await watcher.poll();

    expect(sub.take()).toEqual([
      {
        kind: 'renamed',
        symbol: stable,
        from: 'refreshToken',
        to: 'refreshAgain',
      },
    ]);
  });

  test('unlanded and colliding rename hints wait for projected text', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const dev = Identity.create();
    const remote = Workspace.open(log, store, {
      source: 'main',
      reader: dev,
      name: 'remote',
    });
    remote.write('src/auth.rs', enc('fn refresh() {}\nfn login() {}\n'));
    await remote.commit(dev);

    const mirror = Workspace.open(log, store, {
      source: 'remote',
      reader: dev,
      name: 'watch/mirror',
    });
    const graph = SymbolGraph.over(mirror, {
      extractor: new HeuristicExtractor(),
    });
    const stable = (await graph.resolve('refresh'))!;
    const login = (await graph.resolve('login'))!;
    await graph.syncRenames([]);
    const watcher = await SemanticWatcher.over(graph);
    const sub = watcher.watch();
    const collision = signSymbolOp(
      {
        kind: 'rename-symbol',
        symbol: stable,
        from: 'refresh',
        to: 'login',
        base: null,
      },
      dev
    );

    await graph.syncRenames([collision]);
    expect(await watcher.poll()).toEqual([]);
    expect(sub.take()).toEqual([]);
    expect(await graph.resolve('refresh')).toBe(stable);
    expect(await graph.resolve('login')).toBe(login);

    const source = SymbolGraph.over(remote, {
      extractor: new HeuristicExtractor(),
    });
    const sourceStable = (await source.resolve('refresh'))!;
    expect(sourceStable).toBe(stable);
    const landed = await source.rename(sourceStable, 'refreshToken', dev);
    await graph.syncRenames([collision, landed.symbolOp]);
    expect(await watcher.poll()).toEqual([]);
    expect(sub.take()).toEqual([]);

    await log.repoint('watch/mirror', [...log.heads('remote')]);
    await graph.syncRenames([collision, landed.symbolOp]);
    await watcher.poll();

    expect(sub.take()).toEqual([
      {
        kind: 'renamed',
        symbol: stable,
        from: 'refresh',
        to: 'refreshToken',
      },
    ]);
    expect(await graph.resolve('refreshToken')).toBe(stable);
    expect(await graph.resolve('login')).toBe(login);
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
