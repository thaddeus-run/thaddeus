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
  expect(
    formatSemanticEvent({
      kind: 'renamed',
      symbol: 'abc123',
      from: 'refresh',
      to: 'refreshToken',
    })
  ).toBe('renamed  abc123  refresh → refreshToken');
});

async function watchGraph(): Promise<SymbolGraph> {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const identity = Identity.create();
  const workspace = Workspace.open(log, store, {
    source: 'main',
    reader: identity,
  });
  workspace.write(
    'src/auth.rs',
    new TextEncoder().encode('fn refresh() {}\nfn login() {}\n')
  );
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
  expect(resolveWatchSymbol(graph, 'missing')).rejects.toThrow(
    'no symbol matching missing'
  );
  expect(resolveWatchSymbol(graph, '')).rejects.toThrow(
    'ambiguous symbol prefix'
  );
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

test('emits all semantic event kinds without overlapping pulls', async () => {
  const { fetchImpl, home, writer, writerEnv } = await seedWatchRepo();
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
  expect(new Set(events.map((event) => event.kind))).toEqual(
    new Set(['defined', 'removed', 'renamed', 'moved', 'references-changed'])
  );
  const renamed = events.find((event) => event.kind === 'renamed');
  expect(renamed).toMatchObject({ from: 'refresh', to: 'refreshToken' });
  expect(renamed?.symbol).toHaveLength(64);
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
