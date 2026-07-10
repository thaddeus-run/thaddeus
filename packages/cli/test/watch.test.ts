import { Workspace } from '@thaddeus.run/fs';
import { HeuristicExtractor, SymbolGraph } from '@thaddeus.run/graph';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { MemoryStore } from '@thaddeus.run/store';
import type { SemanticEvent } from '@thaddeus.run/watch';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { loadIdentity } from '../src/identity';
import { run } from '../src/run';
import {
  formatSemanticEvent,
  parseWatchInterval,
  resolveWatchSymbol,
  watchRemote,
} from '../src/watch';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-watch-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Capture every file byte-for-byte so a watcher cannot hide durable mutations.
function snapshotTree(root: string, dir = root): [string, Uint8Array][] {
  const entries: [string, Uint8Array][] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      entries.push(...snapshotTree(root, path));
    } else {
      entries.push([relative(root, path), new Uint8Array(readFileSync(path))]);
    }
  }
  return entries;
}

test('parses watch durations and rejects intervals below 100ms', () => {
  expect(parseWatchInterval(undefined)).toBe(2_000);
  expect(parseWatchInterval('250ms')).toBe(250);
  expect(parseWatchInterval('2s')).toBe(2_000);
  expect(parseWatchInterval('1m')).toBe(60_000);
  expect(() => parseWatchInterval('99ms')).toThrow('at least 100ms');
  expect(() => parseWatchInterval('2')).toThrow('invalid watch interval');
});

test('formats every semantic event as one concise line', () => {
  const cases: { event: SemanticEvent; line: string }[] = [
    {
      event: {
        kind: 'defined',
        symbol: 'abc123',
        name: 'refresh',
        path: 'src/auth.rs',
      },
      line: 'defined  abc123  refresh at src/auth.rs',
    },
    {
      event: { kind: 'removed', symbol: 'abc123', name: 'refresh' },
      line: 'removed  abc123  refresh',
    },
    {
      event: {
        kind: 'renamed',
        symbol: 'abc123',
        from: 'refresh',
        to: 'refreshToken',
      },
      line: 'renamed  abc123  refresh → refreshToken',
    },
    {
      event: {
        kind: 'moved',
        symbol: 'abc123',
        from: { path: 'src/old.rs', line: 3 },
        to: { path: 'src/new.rs', line: 7 },
      },
      line: 'moved  abc123  src/old.rs:3 → src/new.rs:7',
    },
    {
      event: {
        kind: 'references-changed',
        symbol: 'abc123',
        added: [{ symbol: 'abc123', path: 'src/new.rs', line: 8 }],
        removed: [{ symbol: 'abc123', path: 'src/old.rs', line: 4 }],
      },
      line: 'references-changed  abc123  +src/new.rs:8 -src/old.rs:4',
    },
  ];

  for (const item of cases) {
    expect(formatSemanticEvent(item.event)).toBe(item.line);
  }
});

async function watchGraph(
  path = 'src/auth.rs',
  text = 'fn refresh() {}\nfn login() {}\n'
): Promise<SymbolGraph> {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const identity = Identity.create();
  const workspace = Workspace.open(log, store, {
    source: 'main',
    reader: identity,
  });
  workspace.write(path, new TextEncoder().encode(text));
  await workspace.commit(identity);
  return SymbolGraph.over(workspace, {
    extractor: new HeuristicExtractor(),
  });
}

test('resolves watch filters by name, full id, and unique prefix', async () => {
  const graph = await watchGraph();
  const id = (await graph.resolve('refresh'))!;
  expect(await resolveWatchSymbol(graph, 'refresh')).toBe(id);
  expect(await resolveWatchSymbol(graph, id)).toBe(id);
  expect(await resolveWatchSymbol(graph, id.slice(0, 12))).toBe(id);
  let missing: unknown;
  try {
    await resolveWatchSymbol(graph, 'missing');
  } catch (error) {
    missing = error;
  }
  expect(missing).toBeInstanceOf(Error);
  expect((missing as Error).message).toContain('no symbol matching missing');

  let ambiguous: unknown;
  try {
    await resolveWatchSymbol(graph, '');
  } catch (error) {
    ambiguous = error;
  }
  expect(ambiguous).toBeInstanceOf(Error);
  expect((ambiguous as Error).message).toContain('ambiguous symbol prefix');
});

async function seedWatchRepo(): Promise<{
  fetchImpl: (request: Request) => Promise<Response>;
  home: string;
  writer: string;
  writerEnv: {
    cwd: string;
    home: string;
    fetchImpl: (request: Request) => Promise<Response>;
    out: (line: string) => void;
  };
}> {
  const server = createServer({ backend: new MemoryBackend() });
  const fetchImpl = server.fetch.bind(server);
  const home = mkdtempSync(join(tmp, 'home-'));
  const writer = mkdtempSync(join(tmp, 'writer-'));
  const writerOut: string[] = [];
  const writerEnv = {
    cwd: writer,
    home,
    fetchImpl,
    out: (line: string): void => {
      writerOut.push(line);
    },
  };
  await run(['init'], { ...writerEnv, cwd: home });
  await run(['create', 'http://t', 'proj'], { ...writerEnv, cwd: home });
  await run(['clone', 'http://t', 'proj', writer], writerEnv);
  writeFileSync(
    join(writer, 'auth.rs'),
    'fn refresh() {}\nfn login() {\n  refresh();\n}\n'
  );
  await run(['push', '-m', 'initial'], writerEnv);
  return { fetchImpl, home, writer, writerEnv };
}

test('validates watch command intervals and event kinds', async () => {
  const out: string[] = [];
  const errors: string[] = [];
  const invalidEnv = {
    cwd: tmp,
    home: tmp,
    out: (line: string): void => {
      out.push(line);
    },
    err: (line: string): void => {
      errors.push(line);
    },
  };

  expect(await run(['watch', '--interval', '99ms'], invalidEnv)).toBe(2);
  expect(out).toEqual(['watch interval must be at least 100ms']);

  out.length = 0;
  expect(await run(['watch', '--kind', 'signature-changed'], invalidEnv)).toBe(
    2
  );
  expect(out).toEqual(['invalid watch kind: signature-changed']);
  expect(errors).toEqual([]);

  out.length = 0;
  expect(await run(['watch', '--unknown'], invalidEnv)).toBe(2);
  expect(out).toHaveLength(1);
  expect(out[0]).toContain('--unknown');
  expect(errors).toEqual([]);
});

test('routes every JSON watch preflight diagnostic to stderr', async () => {
  const malformed = mkdtempSync(join(tmp, 'malformed-'));
  mkdirSync(join(malformed, '.thaddeus'));
  writeFileSync(join(malformed, '.thaddeus', 'config.json'), 'not json\n');
  const cases: {
    args: string[];
    cwd: string;
    code: number;
    diagnostic: string;
  }[] = [
    {
      args: ['watch', '--json', '--interval', '99ms'],
      cwd: tmp,
      code: 2,
      diagnostic: 'watch interval must be at least 100ms',
    },
    {
      args: ['watch', '--json', '--kind', 'signature-changed'],
      cwd: tmp,
      code: 2,
      diagnostic: 'invalid watch kind: signature-changed',
    },
    {
      args: ['watch', '--json', 'first', 'second'],
      cwd: tmp,
      code: 2,
      diagnostic: 'usage: thaddeus watch',
    },
    {
      args: ['watch', '--json', '--unknown'],
      cwd: tmp,
      code: 2,
      diagnostic: '--unknown',
    },
    {
      args: ['watch', '--json'],
      cwd: tmp,
      code: 2,
      diagnostic: 'not a thaddeus working copy',
    },
    {
      args: ['watch', '--json'],
      cwd: malformed,
      code: 1,
      diagnostic: 'error:',
    },
  ];

  for (const item of cases) {
    const out: string[] = [];
    const errors: string[] = [];
    const code = await run(item.args, {
      cwd: item.cwd,
      home: tmp,
      out: (line: string): void => {
        out.push(line);
      },
      err: (line: string): void => {
        errors.push(line);
      },
    });
    expect(code).toBe(item.code);
    expect(out).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(item.diagnostic);
  }
});

test('streams JSONL without mutating the observer and cleans up SIGINT', async () => {
  const { fetchImpl, home, writerEnv } = await seedWatchRepo();
  const observer = mkdtempSync(join(tmp, 'observer-'));
  await run(['clone', 'http://t', 'proj', observer], {
    ...writerEnv,
    cwd: observer,
  });
  const jsonOut: string[] = [];
  const diagnostics: string[] = [];
  const controller = new AbortController();
  let ticks = 0;
  writeFileSync(join(observer, 'dirty.txt'), 'uncommitted\n');
  const before = snapshotTree(observer);
  const code = await run(
    ['watch', 'refresh', '--kind', 'renamed', '--interval', '100ms', '--json'],
    {
      cwd: observer,
      home,
      fetchImpl,
      signal: controller.signal,
      sleep: async () => {
        ticks += 1;
        if (ticks === 1) {
          await run(
            ['rename', 'refresh', 'refreshToken', '-m', 'clearer'],
            writerEnv
          );
        } else {
          controller.abort();
        }
      },
      out: (line: string): void => {
        jsonOut.push(line);
      },
      err: (line: string): void => {
        diagnostics.push(line);
      },
    }
  );
  const after = snapshotTree(observer);
  expect(code).toBe(0);
  expect(after).toEqual(before);
  expect(jsonOut).toHaveLength(1);
  expect(JSON.parse(jsonOut[0]) as SemanticEvent).toMatchObject({
    kind: 'renamed',
    from: 'refresh',
    to: 'refreshToken',
  });
  expect(diagnostics).toEqual([]);

  const beforeListeners = process.listeners('SIGINT');
  const lifecycleCode = await run(['watch', '--interval', '100ms'], {
    cwd: observer,
    home,
    fetchImpl,
    sleep: () => {
      const added = process
        .listeners('SIGINT')
        .find((listener) => !beforeListeners.includes(listener));
      expect(added).toBeDefined();
      (added as () => void)();
      return Promise.resolve();
    },
    out: () => {},
    err: (line: string): void => {
      diagnostics.push(line);
    },
  });
  expect(lifecycleCode).toBe(0);
  expect(process.listeners('SIGINT')).toEqual(beforeListeners);
});

test('keeps JSONL stdout clean while recovering from a pull failure', async () => {
  const seeded = await seedWatchRepo();
  const observer = mkdtempSync(join(tmp, 'observer-flaky-'));
  await run(['clone', 'http://t', 'proj', observer], {
    ...seeded.writerEnv,
    cwd: observer,
  });
  let pullCalls = 0;
  const flakyFetch = async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname.endsWith('/pull')) {
      pullCalls += 1;
      if (pullCalls === 2) {
        return new Response(JSON.stringify({ error: 'temporary' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return seeded.fetchImpl(request);
  };
  const controller = new AbortController();
  const jsonOut: string[] = [];
  const diagnostics: string[] = [];
  let ticks = 0;
  const code = await run(['watch', '--interval', '100ms', '--json'], {
    cwd: observer,
    home: seeded.home,
    fetchImpl: flakyFetch,
    signal: controller.signal,
    sleep: async () => {
      ticks += 1;
      if (ticks === 1) {
        await run(
          ['rename', 'refresh', 'refreshToken', '-m', 'clearer'],
          seeded.writerEnv
        );
      } else if (ticks === 3) {
        controller.abort();
      }
    },
    out: (line: string): void => {
      jsonOut.push(line);
    },
    err: (line: string): void => {
      diagnostics.push(line);
    },
  });
  expect(code).toBe(0);
  expect(
    jsonOut.map((line) => (JSON.parse(line) as SemanticEvent).kind)
  ).toEqual(['renamed']);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toContain('temporary');
});

test('retries a rename uploaded before startup after its heads land', async () => {
  const { fetchImpl, home, writerEnv } = await seedWatchRepo();
  const expectedGraph = await watchGraph('auth.rs');
  const stable = (await expectedGraph.resolveAt('auth.rs', 'refresh'))!;
  await run(
    ['rename', 'refresh', 'refreshToken', '--no-land', '-m', 'clearer'],
    writerEnv
  );

  const controller = new AbortController();
  const events: SemanticEvent[] = [];
  let ticks = 0;
  await watchRemote({
    server: 'http://t',
    repo: 'proj',
    view: 'main',
    identity: loadIdentity(home),
    fetchImpl,
    intervalMs: 100,
    signal: controller.signal,
    sleep: async () => {
      ticks += 1;
      if (ticks === 1) {
        expect(await run(['land'], writerEnv)).toBe(0);
      } else {
        controller.abort();
      }
    },
    onEvent: (event) => events.push(event),
    onError: (error) => {
      throw error;
    },
  });

  expect(events).toEqual([
    {
      kind: 'renamed',
      symbol: stable,
      from: 'refresh',
      to: 'refreshToken',
    },
  ]);
});

test('chained renames from separate invocations keep one stable id', async () => {
  // Every real `thaddeus rename` is its own process. The second invocation
  // must recover the symbol's stable id from the durable SymbolOp log instead
  // of minting a fresh birth for the current name — otherwise the chain forks
  // and a watcher sees removed+defined instead of the second renamed event.
  const { fetchImpl, home, writerEnv } = await seedWatchRepo();
  const expectedGraph = await watchGraph('auth.rs');
  const stable = (await expectedGraph.resolveAt('auth.rs', 'refresh'))!;
  const controller = new AbortController();
  const events: SemanticEvent[] = [];
  let ticks = 0;
  await watchRemote({
    server: 'http://t',
    repo: 'proj',
    view: 'main',
    identity: loadIdentity(home),
    fetchImpl,
    kinds: ['renamed'],
    intervalMs: 100,
    signal: controller.signal,
    sleep: async () => {
      ticks += 1;
      if (ticks === 1) {
        await run(
          ['rename', 'refresh', 'refreshToken', '-m', 'clearer'],
          writerEnv
        );
      } else if (ticks === 2) {
        await run(
          ['rename', 'refreshToken', 'refreshFinal', '-m', 'again'],
          writerEnv
        );
      } else {
        controller.abort();
      }
    },
    onEvent: (event) => events.push(event),
    onError: (error) => {
      throw error;
    },
  });

  expect(events).toEqual([
    { kind: 'renamed', symbol: stable, from: 'refresh', to: 'refreshToken' },
    {
      kind: 'renamed',
      symbol: stable,
      from: 'refreshToken',
      to: 'refreshFinal',
    },
  ]);
});

test('emits all semantic event kinds without overlapping pulls', async () => {
  const { fetchImpl, home, writer, writerEnv } = await seedWatchRepo();
  const initialGraph = await watchGraph('auth.rs');
  const refresh = (await initialGraph.resolve('refresh'))!;
  const login = (await initialGraph.resolve('login'))!;
  const finalGraph = await watchGraph(
    'auth.rs',
    'fn helper() {}\nfn refreshToken() {}\nfn retry() {\n  refreshToken();\n}\n'
  );
  const helper = (await finalGraph.resolve('helper'))!;
  const retry = (await finalGraph.resolve('retry'))!;
  let activePulls = 0;
  let maxActivePulls = 0;
  const trackingFetch = async (request: Request): Promise<Response> => {
    const isPull = new URL(request.url).pathname.endsWith('/pull');
    if (isPull) {
      activePulls += 1;
      maxActivePulls = Math.max(maxActivePulls, activePulls);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    try {
      return await fetchImpl(request);
    } finally {
      if (isPull) {
        activePulls -= 1;
      }
    }
  };
  const controller = new AbortController();
  const events: SemanticEvent[] = [];
  let ticks = 0;
  await watchRemote({
    server: 'http://t',
    repo: 'proj',
    view: 'main',
    identity: loadIdentity(home),
    fetchImpl: trackingFetch,
    intervalMs: 100,
    signal: controller.signal,
    sleep: async () => {
      ticks += 1;
      if (ticks === 1) {
        await run(
          ['rename', 'refresh', 'refreshToken', '-m', 'clearer'],
          writerEnv
        );
      } else if (ticks === 2) {
        writeFileSync(
          join(writer, 'auth.rs'),
          'fn helper() {}\nfn refreshToken() {}\nfn retry() {\n  refreshToken();\n}\n'
        );
        await run(['push', '-m', 'reshape callers'], writerEnv);
      } else {
        controller.abort();
      }
    },
    onEvent: (event) => events.push(event),
    onError: (error) => {
      throw error;
    },
  });
  expect(events).toHaveLength(6);
  expect(events.filter((event) => event.kind === 'renamed')).toEqual([
    {
      kind: 'renamed',
      symbol: refresh,
      from: 'refresh',
      to: 'refreshToken',
    },
  ]);
  expect(
    events
      .filter((event) => event.kind === 'defined')
      .sort((a, b) => a.name.localeCompare(b.name))
  ).toEqual([
    { kind: 'defined', symbol: helper, name: 'helper', path: 'auth.rs' },
    { kind: 'defined', symbol: retry, name: 'retry', path: 'auth.rs' },
  ]);
  expect(events.filter((event) => event.kind === 'removed')).toEqual([
    { kind: 'removed', symbol: login, name: 'login' },
  ]);
  expect(events.filter((event) => event.kind === 'moved')).toEqual([
    {
      kind: 'moved',
      symbol: refresh,
      from: { path: 'auth.rs', line: 1 },
      to: { path: 'auth.rs', line: 2 },
    },
  ]);
  expect(events.filter((event) => event.kind === 'references-changed')).toEqual(
    [
      {
        kind: 'references-changed',
        symbol: refresh,
        added: [{ symbol: refresh, path: 'auth.rs', line: 4 }],
        removed: [{ symbol: refresh, path: 'auth.rs', line: 3 }],
      },
    ]
  );
  expect(maxActivePulls).toBe(1);
});

test('reports a transient pull failure and recovers on the next tick', async () => {
  const { fetchImpl, home, writerEnv } = await seedWatchRepo();
  let failNextPull = false;
  const flakyFetch = async (request: Request): Promise<Response> => {
    if (failNextPull && new URL(request.url).pathname.endsWith('/pull')) {
      failNextPull = false;
      return new Response(JSON.stringify({ error: 'temporary' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    return fetchImpl(request);
  };
  const controller = new AbortController();
  const recovered: SemanticEvent[] = [];
  const failures: string[] = [];
  let ticks = 0;
  await watchRemote({
    server: 'http://t',
    repo: 'proj',
    view: 'main',
    identity: loadIdentity(home),
    fetchImpl: flakyFetch,
    intervalMs: 100,
    signal: controller.signal,
    sleep: async () => {
      ticks += 1;
      if (ticks === 1) {
        await run(
          ['rename', 'refresh', 'refreshToken', '-m', 'clearer'],
          writerEnv
        );
        failNextPull = true;
      } else if (ticks === 3) {
        controller.abort();
      }
    },
    onEvent: (event) => recovered.push(event),
    onError: (error) => failures.push(error.message),
  });
  expect(failures).toHaveLength(1);
  expect(recovered.map((event) => event.kind)).toEqual(['renamed']);
});
