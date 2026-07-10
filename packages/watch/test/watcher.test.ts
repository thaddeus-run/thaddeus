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

  test('fresh hydration rejects two symbols claiming one projected binding', async () => {
    const dev = Identity.create();
    const peer = Identity.create();
    const birthStore = new MemoryStore();
    const birthLog = new OpLog(birthStore);
    const births = Workspace.open(birthLog, birthStore, {
      source: 'main',
      reader: dev,
    });
    births.write('src/shared.rs', enc('fn alpha() {}\nfn beta() {}\n'));
    await births.commit(dev);
    const birthGraph = SymbolGraph.over(births, {
      extractor: new HeuristicExtractor(),
    });
    const alpha = (await birthGraph.resolve('alpha'))!;
    const beta = (await birthGraph.resolve('beta'))!;

    const claims = [
      signSymbolOp(
        {
          kind: 'rename-symbol',
          symbol: alpha,
          from: 'alpha',
          to: 'shared',
          base: null,
        },
        dev
      ),
      signSymbolOp(
        {
          kind: 'rename-symbol',
          symbol: beta,
          from: 'beta',
          to: 'shared',
          base: null,
        },
        peer
      ),
    ];

    for (const reverse of [false, true]) {
      const projectedStore = new MemoryStore();
      const projectedLog = new OpLog(projectedStore);
      const projected = Workspace.open(projectedLog, projectedStore, {
        source: 'main',
        reader: dev,
      });
      projected.write('src/shared.rs', enc('fn shared() {}\n'));
      await projected.commit(dev);
      const graph = SymbolGraph.over(projected, {
        extractor: new HeuristicExtractor(),
      });
      const provisional = (await graph.resolve('shared'))!;
      const watcher = await SemanticWatcher.over(graph);

      await graph.syncRenames(reverse ? [...claims].reverse() : claims);

      expect(await watcher.poll()).toEqual([]);
      expect(await graph.resolve('shared')).toBe(provisional);
      expect(await graph.definitionOf(alpha)).toBeNull();
      expect(await graph.definitionOf(beta)).toBeNull();
    }
  });

  test('incremental sync rejects two symbols claiming one projected binding', async () => {
    const dev = Identity.create();
    const peer = Identity.create();
    for (const reverse of [false, true]) {
      const store = new MemoryStore();
      const log = new OpLog(store);
      const ws = Workspace.open(log, store, {
        source: 'main',
        reader: dev,
      });
      ws.write('src/shared.rs', enc('fn alpha() {}\nfn beta() {}\n'));
      await ws.commit(dev);
      const graph = SymbolGraph.over(ws, {
        extractor: new HeuristicExtractor(),
      });
      const alpha = (await graph.resolve('alpha'))!;
      const beta = (await graph.resolve('beta'))!;
      await graph.syncRenames([]);
      const watcher = await SemanticWatcher.over(graph);
      const claims = [
        signSymbolOp(
          {
            kind: 'rename-symbol',
            symbol: alpha,
            from: 'alpha',
            to: 'shared',
            base: null,
          },
          dev
        ),
        signSymbolOp(
          {
            kind: 'rename-symbol',
            symbol: beta,
            from: 'beta',
            to: 'shared',
            base: null,
          },
          peer
        ),
      ];

      ws.write('src/shared.rs', enc('fn shared() {}\n'));
      await ws.commit(dev);
      await graph.syncRenames(reverse ? [...claims].reverse() : claims);
      const events = await watcher.poll();
      const shared = (await graph.resolve('shared'))!;

      expect(events.filter((event) => event.kind === 'renamed')).toEqual([]);
      expect(events.filter((event) => event.kind === 'defined')).toEqual([
        {
          kind: 'defined',
          symbol: shared,
          name: 'shared',
          path: 'src/shared.rs',
        },
      ]);
      expect(
        events
          .filter((event) => event.kind === 'removed')
          .map((event) => event.symbol)
          .sort()
      ).toEqual([alpha, beta].sort());
      expect(shared).not.toBe(alpha);
      expect(shared).not.toBe(beta);
    }
  });

  test('equivalent signed edges restore one stable rename', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const dev = Identity.create();
    const peer = Identity.create();
    const ws = Workspace.open(log, store, {
      source: 'main',
      reader: dev,
    });
    ws.write('src/shared.rs', enc('fn alpha() {}\n'));
    await ws.commit(dev);
    const graph = SymbolGraph.over(ws, {
      extractor: new HeuristicExtractor(),
    });
    const stable = (await graph.resolve('alpha'))!;
    const claims = [
      signSymbolOp(
        {
          kind: 'rename-symbol',
          symbol: stable,
          from: 'alpha',
          to: 'beta',
          base: null,
        },
        dev
      ),
      signSymbolOp(
        {
          kind: 'rename-symbol',
          symbol: stable,
          from: 'alpha',
          to: 'beta',
          base: null,
        },
        peer
      ),
    ];
    await graph.syncRenames(claims);
    const watcher = await SemanticWatcher.over(graph);

    ws.write('src/shared.rs', enc('fn beta() {}\n'));
    await ws.commit(dev);
    await graph.syncRenames(claims);

    expect(await watcher.poll()).toEqual([
      {
        kind: 'renamed',
        symbol: stable,
        from: 'alpha',
        to: 'beta',
      },
    ]);
    expect(await graph.resolve('beta')).toBe(stable);
    await graph.syncRenames([...claims].reverse());
    expect(await watcher.poll()).toEqual([]);
    expect(await graph.resolve('beta')).toBe(stable);
  });

  test('hydration never deletes another history stable birth id', async () => {
    const dev = Identity.create();
    const peer = Identity.create();
    const birthStore = new MemoryStore();
    const birthLog = new OpLog(birthStore);
    const births = Workspace.open(birthLog, birthStore, {
      source: 'main',
      reader: dev,
    });
    births.write('src/shared.rs', enc('fn alpha() {}\nfn beta() {}\n'));
    await births.commit(dev);
    const birthGraph = SymbolGraph.over(births, {
      extractor: new HeuristicExtractor(),
    });
    const alpha = (await birthGraph.resolve('alpha'))!;
    const beta = (await birthGraph.resolve('beta'))!;
    const claims = [
      signSymbolOp(
        {
          kind: 'rename-symbol',
          symbol: alpha,
          from: 'alpha',
          to: 'beta',
          base: null,
        },
        dev
      ),
      signSymbolOp(
        {
          kind: 'rename-symbol',
          symbol: beta,
          from: 'beta',
          to: 'gamma',
          base: null,
        },
        peer
      ),
    ];

    for (const reverse of [false, true]) {
      const projectedStore = new MemoryStore();
      const projectedLog = new OpLog(projectedStore);
      const projected = Workspace.open(projectedLog, projectedStore, {
        source: 'main',
        reader: dev,
      });
      projected.write('src/shared.rs', enc('fn beta() {}\nfn gamma() {}\n'));
      await projected.commit(dev);
      const graph = SymbolGraph.over(projected, {
        extractor: new HeuristicExtractor(),
      });
      const projectedBeta = (await graph.resolve('beta'))!;
      const gamma = (await graph.resolve('gamma'))!;
      expect(projectedBeta).toBe(beta);
      const watcher = await SemanticWatcher.over(graph);

      await graph.syncRenames(reverse ? [...claims].reverse() : claims);

      expect(await watcher.poll()).toEqual([]);
      expect(await graph.resolve('beta')).toBe(beta);
      expect(await graph.resolve('gamma')).toBe(gamma);
      expect(await graph.definitionOf(alpha)).toBeNull();
    }
  });

  test('rejected contention retries when the competing birth reappears', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const dev = Identity.create();
    const peer = Identity.create();
    const ws = Workspace.open(log, store, {
      source: 'main',
      reader: dev,
    });
    ws.write('src/shared.rs', enc('fn alpha() {}\nfn beta() {}\n'));
    await ws.commit(dev);
    const graph = SymbolGraph.over(ws, {
      extractor: new HeuristicExtractor(),
    });
    const alpha = (await graph.resolve('alpha'))!;
    const beta = (await graph.resolve('beta'))!;
    await graph.syncRenames([]);
    const watcher = await SemanticWatcher.over(graph);
    const claims = [
      signSymbolOp(
        {
          kind: 'rename-symbol',
          symbol: alpha,
          from: 'alpha',
          to: 'shared',
          base: null,
        },
        dev
      ),
      signSymbolOp(
        {
          kind: 'rename-symbol',
          symbol: beta,
          from: 'beta',
          to: 'shared',
          base: null,
        },
        peer
      ),
    ];

    ws.write('src/shared.rs', enc('fn shared() {}\n'));
    await ws.commit(dev);
    await graph.syncRenames(claims);
    await watcher.poll();
    const provisional = (await graph.resolve('shared'))!;
    expect(provisional).not.toBe(alpha);
    expect(provisional).not.toBe(beta);

    ws.write('src/shared.rs', enc('fn shared() {}\nfn beta() {}\n'));
    await ws.commit(dev);
    await graph.syncRenames(claims);
    const events = await watcher.poll();

    expect(await graph.resolve('shared')).toBe(alpha);
    expect(await graph.resolve('beta')).toBe(beta);
    expect(events.filter((event) => event.kind === 'renamed')).toEqual([]);
    expect(
      events
        .filter((event) => event.kind === 'defined')
        .map((event) => `${event.symbol}:${event.name}`)
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(
      [`${alpha}:shared`, `${beta}:beta`].sort((left, right) =>
        left.localeCompare(right)
      )
    );
    expect(events.filter((event) => event.kind === 'removed')).toEqual([
      { kind: 'removed', symbol: provisional, name: 'shared' },
    ]);
    await graph.syncRenames(claims);
    expect(await watcher.poll()).toEqual([]);
    expect(await graph.resolve('shared')).toBe(alpha);
  });

  test('cold hydration contention retries when the competing birth reappears', async () => {
    // Production watch ordering: the first syncRenames runs on a fresh mirror
    // BEFORE any read, so neither claimant has a ledger binding to retry from.
    const dev = Identity.create();
    const peer = Identity.create();
    const birthStore = new MemoryStore();
    const birthLog = new OpLog(birthStore);
    const births = Workspace.open(birthLog, birthStore, {
      source: 'main',
      reader: dev,
    });
    births.write('src/shared.rs', enc('fn alpha() {}\nfn beta() {}\n'));
    await births.commit(dev);
    const birthGraph = SymbolGraph.over(births, {
      extractor: new HeuristicExtractor(),
    });
    const alpha = (await birthGraph.resolve('alpha'))!;
    const beta = (await birthGraph.resolve('beta'))!;
    const claims = [
      signSymbolOp(
        {
          kind: 'rename-symbol',
          symbol: alpha,
          from: 'alpha',
          to: 'shared',
          base: null,
        },
        dev
      ),
      signSymbolOp(
        {
          kind: 'rename-symbol',
          symbol: beta,
          from: 'beta',
          to: 'shared',
          base: null,
        },
        peer
      ),
    ];

    const store = new MemoryStore();
    const log = new OpLog(store);
    const ws = Workspace.open(log, store, { source: 'main', reader: dev });
    ws.write('src/shared.rs', enc('fn shared() {}\n'));
    await ws.commit(dev);
    const graph = SymbolGraph.over(ws, {
      extractor: new HeuristicExtractor(),
    });
    await graph.syncRenames(claims); // cold: two claims contend, both rejected
    const watcher = await SemanticWatcher.over(graph);
    const provisional = (await graph.resolve('shared'))!;
    expect(provisional).not.toBe(alpha);
    expect(provisional).not.toBe(beta);

    // The competing birth reappears — `shared` now has exactly one live claim.
    ws.write('src/shared.rs', enc('fn shared() {}\nfn beta() {}\n'));
    await ws.commit(dev);
    await graph.syncRenames(claims);
    const events = await watcher.poll();

    expect(await graph.resolve('shared')).toBe(alpha);
    expect(await graph.resolve('beta')).toBe(beta);
    expect(events.filter((event) => event.kind === 'removed')).toEqual([
      { kind: 'removed', symbol: provisional, name: 'shared' },
    ]);
    await graph.syncRenames(claims);
    expect(await watcher.poll()).toEqual([]);
    expect(await graph.resolve('shared')).toBe(alpha);
  });

  test('a rename pulled after ordinary reads keeps the stable id', async () => {
    // A graph that served reads before its first syncRenames must reconcile a
    // landed rename by MOVING the existing binding, not minting a new identity.
    const store = new MemoryStore();
    const log = new OpLog(store);
    const dev = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: dev });
    ws.write('src/shared.rs', enc('fn alpha() {}\n'));
    await ws.commit(dev);
    const graph = SymbolGraph.over(ws, {
      extractor: new HeuristicExtractor(),
    });
    const alpha = (await graph.resolve('alpha'))!; // read before any sync
    const watcher = await SemanticWatcher.over(graph);
    const op = signSymbolOp(
      {
        kind: 'rename-symbol',
        symbol: alpha,
        from: 'alpha',
        to: 'beta',
        base: null,
      },
      dev
    );
    ws.write('src/shared.rs', enc('fn beta() {}\n'));
    await ws.commit(dev);

    await graph.syncRenames([op]); // FIRST sync on this graph
    expect(await graph.resolve('beta')).toBe(alpha);
    expect(await watcher.poll()).toEqual([
      { kind: 'renamed', symbol: alpha, from: 'alpha', to: 'beta' },
    ]);
    await graph.syncRenames([op]);
    expect(await watcher.poll()).toEqual([]);
    expect(await graph.resolve('beta')).toBe(alpha);
  });

  test('a stale provisional target promotes once its claims are refuted', async () => {
    // Contention marks `shared` provisional. When both claimed births reappear
    // alongside it, the marker must not outlive the contention: `shared` is an
    // ordinary definition again, so a local rename of it must succeed.
    const dev = Identity.create();
    const peer = Identity.create();
    const store = new MemoryStore();
    const log = new OpLog(store);
    const ws = Workspace.open(log, store, { source: 'main', reader: dev });
    ws.write('src/shared.rs', enc('fn alpha() {}\nfn beta() {}\n'));
    await ws.commit(dev);
    const graph = SymbolGraph.over(ws, {
      extractor: new HeuristicExtractor(),
    });
    const alpha = (await graph.resolve('alpha'))!;
    const beta = (await graph.resolve('beta'))!;
    const claims = [
      signSymbolOp(
        {
          kind: 'rename-symbol',
          symbol: alpha,
          from: 'alpha',
          to: 'shared',
          base: null,
        },
        dev
      ),
      signSymbolOp(
        {
          kind: 'rename-symbol',
          symbol: beta,
          from: 'beta',
          to: 'shared',
          base: null,
        },
        peer
      ),
    ];
    ws.write('src/shared.rs', enc('fn shared() {}\n'));
    await ws.commit(dev);
    await graph.syncRenames(claims); // contention → shared stays provisional
    await graph.symbols();

    // Both births return next to shared: neither claim is live any more.
    ws.write(
      'src/shared.rs',
      enc('fn alpha() {}\nfn beta() {}\nfn shared() {}\n')
    );
    await ws.commit(dev);
    await graph.syncRenames(claims);
    const shared = (await graph.resolve('shared'))!;
    const renamed = await graph.rename(shared, 'promoted', dev);
    expect(renamed.symbolOp.from).toBe('shared');
    expect(await graph.resolve('promoted')).toBe(shared);
  });

  test('a dense adversarial rename history is ignored without stalling', async () => {
    // Any key can sign rename records, so route search over a crafted history
    // must stay bounded: past the search budget the history is treated as not
    // authoritative and the projected definition keeps a fresh identity.
    const dev = Identity.create();
    const birthStore = new MemoryStore();
    const birthLog = new OpLog(birthStore);
    const births = Workspace.open(birthLog, birthStore, {
      source: 'main',
      reader: dev,
    });
    births.write('src/shared.rs', enc('fn alpha() {}\n'));
    await births.commit(dev);
    const birthGraph = SymbolGraph.over(births, {
      extractor: new HeuristicExtractor(),
    });
    const alpha = (await birthGraph.resolve('alpha'))!;

    const names = Array.from({ length: 20 }, (_, i) => `step${i}`);
    const rename = (from: string, to: string) =>
      signSymbolOp(
        { kind: 'rename-symbol', symbol: alpha, from, to, base: null },
        dev
      );
    // One real route (alpha → target) beside a dense decoy graph whose simple
    // paths explode combinatorially without ever reaching the target.
    const ops = [rename('alpha', 'target'), rename('alpha', 'step0')];
    for (const [i, from] of names.entries()) {
      for (const to of names.slice(i + 1)) {
        ops.push(rename(from, to));
      }
    }

    const store = new MemoryStore();
    const log = new OpLog(store);
    const ws = Workspace.open(log, store, { source: 'main', reader: dev });
    ws.write('src/shared.rs', enc('fn target() {}\n'));
    await ws.commit(dev);
    const graph = SymbolGraph.over(ws, {
      extractor: new HeuristicExtractor(),
    });
    const startedAt = Date.now();
    await graph.syncRenames(ops);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await graph.resolve('target')).not.toBe(alpha);
  }, 30_000);

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
