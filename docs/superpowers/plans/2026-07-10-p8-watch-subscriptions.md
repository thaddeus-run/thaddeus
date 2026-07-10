# P8 Watch / Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an observer-only `thaddeus watch` semantic-event stream and
non-blocking automatic lazythad refreshes over the existing atomic pull route.

**Architecture:** The CLI keeps a private `MemoryBackend` mirror, advances a
private workspace view after each pull, replays verified `SymbolOp` renames into
one stable `SymbolLedger`, and passes the resulting graph to `SemanticWatcher`.
Lazythad uses a single-flight background worker and applies completed snapshots
on the terminal thread while preserving selection and last-known-good data.

**Tech Stack:** TypeScript, Bun test, `@thaddeus.run/client`,
`@thaddeus.run/graph`, `@thaddeus.run/watch`, Moon, Rust, ratatui, `ureq`, and
`std::sync::mpsc`.

## Global Constraints

- `thaddeus watch` must not mutate checked-out files, the working-copy branch,
  saved base, configuration, or durable local store.
- Use the existing `/pull` route; add no SSE, WebSocket, webhook, server-side
  semantic index, decryption, or new server endpoint.
- The initial pull is a silent baseline; output only changes observed after the
  command starts.
- Default interval is `2s`; accept `ms`, `s`, and `m`; reject intervals below
  `100ms`.
- JSON mode is JSONL with one `SemanticEvent` per stdout line; diagnostics go to
  stderr.
- Event detection remains decryption-bounded and uses the existing full graph
  re-derivation and heuristic extractor.
- Lazythad keeps the last good data on errors, performs at most one remote
  refresh at a time, and never blocks keyboard handling on refresh I/O.
- Set `AGENT=1` for every terminal session and use Bun/Moon rather than npm,
  pnpm, or npx.
- After code changes, run `moon run root:format root:lint` plus focused
  typechecks/tests and `cargo test --locked` in `lazythad/`.

---

## File map

- `packages/graph/src/graph.ts` — restore deterministic symbol identities from
  verified historical rename records and replay newly pulled renames.
- `packages/watch/test/watcher.test.ts` — prove startup hydration and remote
  rename replay produce one stable-id event.
- `packages/cli/src/watch.ts` — own duration parsing, event formatting, symbol
  resolution, the in-memory mirror, and the sequential watch loop.
- `packages/cli/src/run.ts` — parse `watch`, route stdout/stderr, and wire
  AbortController/SIGINT lifecycle.
- `packages/cli/src/help.ts`, `packages/cli/README.md`,
  `packages/cli/package.json`, `bun.lock` — expose and document the command and
  its workspace dependency.
- `packages/cli/test/watch.test.ts` — cover the streaming command over the real
  in-process server and assert local isolation.
- `lazythad/src/live.rs` — background single-flight refresh worker and message
  types.
- `lazythad/src/app.rs` — expose pure refresh targets/results, apply snapshots,
  and request refreshes without network I/O.
- `lazythad/src/main.rs` — schedule periodic/manual work and drain worker
  messages in the terminal loop.
- `lazythad/src/ui.rs`, `lazythad/README.md`, `npm/lazythad/README.md` — show
  and document live status.
- `packages/watch/README.md`, `docs/getting-started.md`, `CHANGELOG.md`, and
  `docs/plans/2026-07-09-post-p3-roadmap.md` — document the shipped P8 behavior
  and its polling/trust boundaries.

---

### Task 1: Preserve stable symbol identity across pulled renames

**Files:**

- Modify: `packages/graph/src/graph.ts`
- Test: `packages/watch/test/watcher.test.ts`

**Interfaces:**

- Consumes: existing verified `SymbolOp` records and `SymbolGraph`'s retained
  `SymbolLedger`.
- Produces: `SymbolGraph.syncRenames(ops: readonly SymbolOp[]): Promise<void>`.
  The first call hydrates current bindings from full history without emitting a
  change; later calls replay unseen verified rename chains into the same ledger.

- [ ] **Step 1: Write the failing historical-hydration and remote-replay tests**

Add this test beside the existing `SemanticWatcher` rename test:

```ts
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
```

The `forged` assertion proves that changing `to` while retaining the genuine
signature cannot rebind the symbol.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
AGENT=1 moonx watch:test -- watcher.test.ts
```

Expected: FAIL because `SymbolGraph.syncRenames` does not exist.

- [ ] **Step 3: Extract deterministic id calculation and add safe ledger
      restore**

In `packages/graph/src/graph.ts`, move the existing birth hash calculation into
one helper and use it from `mintOrGet`:

```ts
function symbolIdFor(binding: Binding): string {
  return bytesToHex(
    blake3(
      new TextEncoder().encode(
        JSON.stringify([
          SYMBOL_DOMAIN,
          binding.path,
          binding.name,
          binding.kind,
        ])
      )
    )
  );
}
```

Add a private-to-the-module restore operation on `SymbolLedger`:

```ts
restore(id: string, birth: Binding, current: Binding): boolean {
  if (symbolIdFor(birth) !== id) {
    return false;
  }
  const currentKey = bindingKey(current);
  const existingBinding = this.#byId.get(id);
  if (
    existingBinding !== undefined &&
    bindingKey(existingBinding) !== currentKey
  ) {
    return false;
  }
  const provisional = this.#byKey.get(currentKey);
  if (provisional !== undefined && provisional !== id) {
    const provisionalBinding = this.#byId.get(provisional);
    if (
      provisionalBinding !== undefined &&
      bindingKey(provisionalBinding) === currentKey
    ) {
      this.#byId.delete(provisional);
    }
  }
  this.#byKey.set(currentKey, id);
  this.#byId.set(id, current);
  return true;
}
```

- [ ] **Step 4: Implement verified startup hydration and unseen-op replay**

Import `verifySymbolOp`, add `#renamesHydrated` and `#syncedRenameOps` fields to
`SymbolGraph`, and implement this public method:

```ts
async syncRenames(ops: readonly SymbolOp[]): Promise<void> {
  const valid = ops.filter((op) => verifySymbolOp(op));
  if (!this.#renamesHydrated) {
    const model = await this.#model();
    const bySymbol = new Map<string, SymbolOp[]>();
    for (const op of valid) {
      const history = bySymbol.get(op.symbol) ?? [];
      history.push(op);
      bySymbol.set(op.symbol, history);
    }
    for (const definition of model.defs) {
      const kind = model.kinds.get(definition.symbol) ?? 'function';
      for (const [symbol, history] of bySymbol) {
        const births = new Set(history.map((op) => op.from));
        for (const birthName of births) {
          const birth = { path: definition.path, name: birthName, kind };
          const current = {
            path: definition.path,
            name: definition.name,
            kind,
          };
          if (
            symbolIdFor(birth) === symbol &&
            renamePathExists(history, birthName, definition.name) &&
            this.ledger.restore(symbol, birth, current)
          ) {
            break;
          }
        }
      }
    }
    for (const op of valid) {
      this.#syncedRenameOps.add(op.id);
    }
    this.#renamesHydrated = true;
    return;
  }

  const pending = valid.filter((op) => !this.#syncedRenameOps.has(op.id));
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let index = pending.length - 1; index >= 0; index--) {
      const op = pending[index];
      if (op !== undefined && this.ledger.currentName(op.symbol) === op.from) {
        this.ledger.rebind(op.symbol, op.to);
        this.#syncedRenameOps.add(op.id);
        pending.splice(index, 1);
        progressed = true;
      }
    }
  }
}
```

Add `renamePathExists(history, from, to)` above the class. It must build a
`Map<string, Set<string>>` from each verified `from → to` edge and perform a
cycle-safe breadth-first search. Return true immediately when `from === to`.
Unmatched unseen records remain retryable on a future full-history call.

```ts
function renamePathExists(
  history: readonly SymbolOp[],
  from: string,
  to: string
): boolean {
  if (from === to) {
    return true;
  }
  const edges = new Map<string, Set<string>>();
  for (const op of history) {
    const next = edges.get(op.from) ?? new Set<string>();
    next.add(op.to);
    edges.set(op.from, next);
  }
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const name = queue.shift()!;
    for (const next of edges.get(name) ?? []) {
      if (next === to) {
        return true;
      }
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}
```

- [ ] **Step 5: Run graph/watch tests and typechecks to verify GREEN**

Run:

```bash
AGENT=1 moon run graph:typecheck watch:typecheck graph:test watch:test
```

Expected: all graph and watch tests pass with zero failures.

- [ ] **Step 6: Commit the stable-identity slice**

```bash
git add packages/graph/src/graph.ts packages/watch/test/watcher.test.ts
git -c user.name="Codex" -c user.email="codex@openai.com" commit -m "feat(watch): reconcile pulled symbol renames"
```

---

### Task 2: Build the isolated semantic watch runner

**Files:**

- Create: `packages/cli/src/watch.ts`
- Create: `packages/cli/test/watch.test.ts`
- Modify: `packages/cli/package.json`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: `Client.clone`, `Client.pull`, `MemoryBackend`,
  `SymbolGraph.syncRenames`, and `SemanticWatcher`.
- Produces: `watchRemote(options: WatchRemoteOptions): Promise<void>`,
  `parseWatchInterval(value?: string): number`,
  `resolveWatchSymbol(graph, value): Promise<string | undefined>`, and
  `formatSemanticEvent(event): string`.

- [ ] **Step 1: Add the CLI workspace dependency**

Add this entry to `packages/cli/package.json` dependencies:

```json
"@thaddeus.run/watch": "workspace:*"
```

Run `bun install` from the repository root so `bun.lock` records the workspace
edge.

- [ ] **Step 2: Write failing parser and formatter tests**

Create `packages/cli/test/watch.test.ts` with this setup:

```ts
import { Workspace } from '@thaddeus.run/fs';
import { HeuristicExtractor, SymbolGraph } from '@thaddeus.run/graph';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { MemoryStore } from '@thaddeus.run/store';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  relative,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadIdentity } from '../src/identity';
import { run } from '../src/run';
import {
  formatSemanticEvent,
  parseWatchInterval,
  resolveWatchSymbol,
  watchRemote,
} from '../src/watch';
import type { SemanticEvent } from '@thaddeus.run/watch';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-watch-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
```

Add focused assertions:

```ts
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
```

Add this local graph fixture and resolution test in the same file:

```ts
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
  await expect(resolveWatchSymbol(graph, 'missing')).rejects.toThrow(
    'no symbol matching missing'
  );
  await expect(resolveWatchSymbol(graph, '')).rejects.toThrow(
    'ambiguous symbol prefix'
  );
});
```

- [ ] **Step 3: Run the focused test to verify RED**

Run:

```bash
AGENT=1 moonx cli:test -- watch.test.ts
```

Expected: FAIL because `../src/watch` does not exist.

- [ ] **Step 4: Implement duration parsing, symbol resolution, and formatting**

Create `packages/cli/src/watch.ts` with these exported types and helpers:

```ts
export type WatchSleep = (
  milliseconds: number,
  signal: AbortSignal
) => Promise<void>;

export interface WatchRemoteOptions {
  readonly server: string;
  readonly repo: string;
  readonly view: string;
  readonly identity: Identity;
  readonly fetchImpl?: (request: Request) => Promise<Response>;
  readonly symbol?: string;
  readonly kinds?: readonly EventKind[];
  readonly intervalMs: number;
  readonly signal: AbortSignal;
  readonly sleep?: WatchSleep;
  readonly onEvent: (event: SemanticEvent) => void;
  readonly onError: (error: Error) => void;
}
```

Implement `parseWatchInterval` with `/^(\d+)(ms|s|m)$/`, safe-integer checks,
unit multipliers, and the `100ms` floor. Implement symbol resolution in the same
order as query: current name, full id, unique prefix; throw clear `no symbol` or
`ambiguous symbol prefix` errors. Format each event kind explicitly, including
`path:line` sites for move/reference changes.

Use these implementations:

```ts
export function parseWatchInterval(value?: string): number {
  if (value === undefined) {
    return 2_000;
  }
  const match = /^(\d+)(ms|s|m)$/.exec(value);
  if (match === null) {
    throw new RangeError(`invalid watch interval: ${value}`);
  }
  const amount = Number(match[1]);
  const multiplier = match[2] === 'ms' ? 1 : match[2] === 's' ? 1_000 : 60_000;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RangeError(`invalid watch interval: ${value}`);
  }
  if (milliseconds < 100) {
    throw new RangeError('watch interval must be at least 100ms');
  }
  return milliseconds;
}

export async function resolveWatchSymbol(
  graph: SymbolGraph,
  value: string
): Promise<string> {
  const named = await graph.resolve(value);
  if (named !== null) {
    return named;
  }
  const matches = (await graph.symbols()).filter((symbol) =>
    symbol.id.startsWith(value)
  );
  if (matches.length === 0) {
    throw new Error(`no symbol matching ${value}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `ambiguous symbol prefix ${value} (${matches.length} matches)`
    );
  }
  return matches[0]!.id;
}

export function formatSemanticEvent(event: SemanticEvent): string {
  switch (event.kind) {
    case 'defined':
      return `defined  ${event.symbol}  ${event.name} at ${event.path}`;
    case 'removed':
      return `removed  ${event.symbol}  ${event.name}`;
    case 'renamed':
      return `renamed  ${event.symbol}  ${event.from} → ${event.to}`;
    case 'moved':
      return `moved  ${event.symbol}  ${event.from.path}:${event.from.line} → ${event.to.path}:${event.to.line}`;
    case 'references-changed': {
      const added = event.added.map((ref) => `+${ref.path}:${ref.line}`);
      const removed = event.removed.map((ref) => `-${ref.path}:${ref.line}`);
      return `references-changed  ${event.symbol}  ${[...added, ...removed].join(' ')}`;
    }
  }
}
```

- [ ] **Step 5: Write the failing remote-event runner tests**

In `packages/cli/test/watch.test.ts`, create the server and writer explicitly:

```ts
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
```

Start `watchRemote` with a sleep seam that performs a remote rename before its
first pull and a second semantic edit before its second pull:

```ts
const { fetchImpl, home, writer, writerEnv } = await seedWatchRepo();
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
```

Add a recovery test with this one-shot fetch wrapper. The initial clone
succeeds; the sleep seam flips `failNextPull` only after committing the remote
change:

```ts
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
```

In the all-events test, wrap `fetchImpl` and pass the wrapper to `watchRemote`
to prove the loop never overlaps pulls:

```ts
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
```

Use `fetchImpl: trackingFetch` in that runner invocation and assert
`expect(maxActivePulls).toBe(1)` after it exits.

- [ ] **Step 6: Run the runner test to verify RED**

Run:

```bash
AGENT=1 moonx cli:test -- watch.test.ts
```

Expected: parser tests pass and runner tests FAIL because `watchRemote` is not
implemented.

- [ ] **Step 7: Implement the sequential in-memory mirror loop**

Implement `watchRemote` with this data flow:

```ts
const backend = new MemoryBackend();
const client = new Client(options.server, options.identity, options.fetchImpl);
const initial = await client.clone(options.repo, backend, options.view);
const watchView = 'watch/live';
const workspace = Workspace.open(initial.repo.log, initial.repo.store, {
  source: options.view,
  reader: options.identity,
  name: watchView,
});
const graph = SymbolGraph.over(workspace, {
  extractor: new HeuristicExtractor(),
  ops: initial.symbols,
});
await graph.syncRenames(initial.symbols.all());
const symbol =
  options.symbol === undefined
    ? undefined
    : await resolveWatchSymbol(graph, options.symbol);
const watcher = await SemanticWatcher.over(graph);
const subscription = watcher.watch({ symbol, kinds: options.kinds });
const sleep = options.sleep ?? abortableSleep;

while (!options.signal.aborted) {
  await sleep(options.intervalMs, options.signal);
  if (options.signal.aborted) {
    break;
  }
  try {
    const pulled = await client.pull(
      options.repo,
      initial.repo,
      backend,
      options.view
    );
    await initial.repo.log.repoint(watchView, [...pulled.heads]);
    await graph.syncRenames(pulled.symbols.all());
    await watcher.poll();
    for (const event of subscription.take()) {
      options.onEvent(event);
    }
  } catch (error) {
    options.onError(error instanceof Error ? error : new Error(String(error)));
  }
}
```

Implement `abortableSleep` with `setTimeout`, a one-shot abort listener, and a
single cleanup function that removes both timer and listener. Resolve rather
than reject on abort so Ctrl-C is a normal exit.

```ts
export function abortableSleep(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}
```

- [ ] **Step 8: Run focused CLI tests and typecheck to verify GREEN**

Run:

```bash
AGENT=1 moon run cli:typecheck cli:test
```

Expected: all CLI tests pass with zero failures.

- [ ] **Step 9: Commit the watch-runner slice**

```bash
git add bun.lock packages/cli/package.json packages/cli/src/watch.ts packages/cli/test/watch.test.ts
git -c user.name="Codex" -c user.email="codex@openai.com" commit -m "feat(cli): add semantic watch runner"
```

---

### Task 3: Expose `thaddeus watch` with streaming-safe lifecycle

**Files:**

- Modify: `packages/cli/src/run.ts`
- Modify: `packages/cli/src/help.ts`
- Test: `packages/cli/test/watch.test.ts`

**Interfaces:**

- Consumes: Task 2's `watchRemote`, `parseWatchInterval`, and
  `formatSemanticEvent`.
- Produces: the documented CLI command and three optional test/runtime seams on
  `CliEnv`: `err`, `signal`, and `sleep`.

- [ ] **Step 1: Write failing command-validation and JSONL tests**

Add validation tests with an explicit output fixture:

```ts
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
expect(await run(['watch', '--kind', 'signature-changed'], invalidEnv)).toBe(2);
expect(out).toEqual(['invalid watch kind: signature-changed']);
expect(errors).toEqual([]);
```

For JSONL, clone the seeded repo from Task 2 into a separate observer directory,
then perform one bounded writer rename with injected sleep/signal seams:

```ts
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
expect(code).toBe(0);
expect(jsonOut).toHaveLength(1);
expect(JSON.parse(jsonOut[0]!)).toMatchObject({
  kind: 'renamed',
  from: 'refresh',
  to: 'refreshToken',
});
expect(diagnostics).toEqual([]);
```

Add a separate JSONL recovery test so exactly one post-baseline `/pull` returns
a 503 response:

```ts
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
expect(jsonOut.map((line) => JSON.parse(line).kind)).toEqual(['renamed']);
expect(diagnostics).toHaveLength(1);
expect(diagnostics[0]).toContain('temporary');
```

In the same freshly seeded command test, add a second invocation that omits
`env.signal`, captures the handler installed by the command, invokes only that
handler from the sleep seam, and proves cleanup:

```ts
const beforeListeners = process.listeners('SIGINT');
const lifecycleCode = await run(['watch', '--interval', '100ms'], {
  cwd: observer,
  home,
  fetchImpl,
  sleep: async () => {
    const added = process
      .listeners('SIGINT')
      .find((listener) => !beforeListeners.includes(listener));
    expect(added).toBeDefined();
    (added as () => void)();
  },
  out: () => {},
  err: (line: string): void => {
    diagnostics.push(line);
  },
});
expect(lifecycleCode).toBe(0);
expect(process.listeners('SIGINT')).toEqual(beforeListeners);
```

- [ ] **Step 2: Run the focused command tests to verify RED**

Run:

```bash
AGENT=1 moonx cli:test -- watch.test.ts
```

Expected: FAIL with `unknown command: watch`.

- [ ] **Step 3: Add stderr, abort, and sleep seams to `CliEnv`**

Extend `CliEnv` in `packages/cli/src/run.ts`:

```ts
export interface CliEnv {
  cwd: string;
  home: string;
  fetchImpl?: (req: Request) => Promise<Response>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  signal?: AbortSignal;
  sleep?: WatchSleep;
}
```

At the start of `run`, bind `err` to `console.error` independently of `out`.

- [ ] **Step 4: Implement parsing and SIGINT cleanup in the `watch` case**

Parse one optional positional, repeatable `--kind`, `--interval`, and `--json`.
Validate kinds against a readonly `EventKind[]`. Resolve the repo/server/view
from `findRoot`, `loadConfig`, and `viewOf`; load only the identity from disk.

When `env.signal` is absent, create an `AbortController`, register one
`process.once('SIGINT', onSigint)` listener, and remove it in `finally`. Pass
`env.sleep` through. Emit text with `formatSemanticEvent` or JSON with
`JSON.stringify(event)`. Catch initial runner errors inside this case, write
`error: <message>` to `err`, and return 1 so JSON stdout stays clean. Return 0
after normal abort.

The command branch should have this shape:

```ts
case 'watch': {
  const { values, positionals } = parseArgs({
    args: [...rest],
    options: {
      kind: { type: 'string', multiple: true },
      interval: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  if (positionals.length > 1) {
    out('usage: thaddeus watch [symbol] [--kind <event>]... [--interval <duration>] [--json]');
    return 2;
  }
  let intervalMs: number;
  try {
    intervalMs = parseWatchInterval(values.interval);
  } catch (error) {
    out(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const allowed: readonly EventKind[] = [
    'defined',
    'removed',
    'renamed',
    'moved',
    'references-changed',
  ];
  const kinds = values.kind ?? [];
  const invalid = kinds.find(
    (kind): boolean => !allowed.includes(kind as EventKind)
  );
  if (invalid !== undefined) {
    out(`invalid watch kind: ${invalid}`);
    return 2;
  }
  const root = findRoot(env.cwd);
  if (root === undefined) {
    out("not a thaddeus working copy — run 'thaddeus clone' first");
    return 2;
  }
  const cfg = loadConfig(root);
  const ownedController = env.signal === undefined ? new AbortController() : null;
  const signal = env.signal ?? ownedController!.signal;
  const onSigint = (): void => ownedController?.abort();
  if (ownedController !== null) {
    process.once('SIGINT', onSigint);
  }
  try {
    await watchRemote({
      server: cfg.server,
      repo: cfg.repo,
      view: viewOf(cfg),
      identity: loadIdentity(env.home),
      fetchImpl: env.fetchImpl,
      symbol: positionals[0],
      kinds: kinds.length === 0 ? undefined : (kinds as EventKind[]),
      intervalMs,
      signal,
      sleep: env.sleep,
      onEvent: (event) =>
        out(values.json === true ? JSON.stringify(event) : formatSemanticEvent(event)),
      onError: (error) => err(`watch error: ${error.message}`),
    });
    return 0;
  } catch (error) {
    err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (ownedController !== null) {
      process.removeListener('SIGINT', onSigint);
    }
  }
}
```

- [ ] **Step 5: Document the command in structured help**

Add this overview entry to `USAGE`:

```text
  watch  [symbol]                 stream remote semantic changes without pulling files
```

Add a `watch` help block with the exact syntax, valid kinds, duration units,
observer-only behavior, silent baseline, JSONL contract, and Ctrl-C behavior.

```ts
watch: `thaddeus watch [symbol] [--kind <event>]... [--interval <duration>] [--json]

  Stream semantic changes from this working copy's remote branch. The initial
  pull is a silent baseline. Events are defined, removed, renamed, moved, and
  references-changed; repeat --kind to filter them. An optional symbol may be a
  current name, stable id, or unique id prefix and keeps following renames.

  --interval accepts ms, s, or m (default 2s, minimum 100ms). --json emits one
  SemanticEvent per line (JSONL); diagnostics use stderr. The watcher uses an
  isolated in-memory mirror and never changes checked-out files, branch heads,
  saved base, config, or the durable local store. Run 'thaddeus pull' explicitly
  to update files. Ctrl-C exits cleanly.`,
```

- [ ] **Step 6: Prove working-copy isolation**

In the bounded command test, write an uncommitted edit before starting watch.
Capture recursively sorted `{relativePath, bytes}` snapshots of the working-copy
directory and shared store plus the config text before and after. Exclude no
paths. Assert all three snapshots are equal while the remote rename event was
still emitted.

Use one recursive helper over the whole observer directory, which includes its
config, store, and checked-out files:

```ts
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

writeFileSync(join(observer, 'dirty.txt'), 'uncommitted\n');
const before = snapshotTree(observer);
```

Place those two lines immediately before the `const code = await run(...)` call
from Step 1, then place these assertions immediately after that call:

```ts
const after = snapshotTree(observer);
expect(code).toBe(0);
expect(after).toEqual(before);
expect(JSON.parse(jsonOut[0]!)).toMatchObject({ kind: 'renamed' });
```

- [ ] **Step 7: Run focused and package verification**

Run:

```bash
AGENT=1 moon run cli:typecheck cli:test
```

Expected: all CLI tests pass, including invalid input, JSONL/stderr separation,
clean abort, semantic filtering, and byte-for-byte isolation.

- [ ] **Step 8: Commit the CLI surface**

```bash
git add packages/cli/src/run.ts packages/cli/src/help.ts packages/cli/test/watch.test.ts
git -c user.name="Codex" -c user.email="codex@openai.com" commit -m "feat(cli): expose semantic watch command"
```

---

### Task 4: Move lazythad refresh I/O off the terminal thread

**Files:**

- Create: `lazythad/src/live.rs`
- Modify: `lazythad/src/main.rs`
- Modify: `lazythad/src/app.rs`
- Modify: `lazythad/src/ui.rs`

**Interfaces:**

- Produces `RefreshTarget { repo: Option<String>, view: String }`,
  `RefreshSnapshot { repos, repo, pull, releases }`, and
  `RefreshMessage { target, result: Result<RefreshSnapshot, String> }`.
- Produces `LiveRefresh::new(remote)`,
  `request(&mut self, target: RefreshTarget) -> bool`, and
  `try_recv(&mut self) -> Option<RefreshMessage>`.
- Produces pure `App::refresh_target`, `App::request_refresh`,
  `App::take_refresh_request`, and
  `App::apply_refresh(message: RefreshMessage) -> bool` methods.

- [ ] **Step 1: Write failing pure App refresh tests**

In `lazythad/src/app.rs`, add tests that construct `RefreshMessage` values and
assert:

```rust
#[test]
fn live_refresh_preserves_selected_ids_and_open_overlays() {
    let mut app = fixture();
    app.op_sel = 1;
    app.activity = Activity::Query;
    app.query = Some(QueryView {
        expression: "references refresh".into(),
        result: QueryResult::References(Vec::new()),
        selected: 0,
    });
    app.reputation = Some(Reputation::default());
    let selected = app.pull.ops[1].id.clone();

    let target = app.refresh_target();
    let message = RefreshMessage {
        target,
        result: Ok(RefreshSnapshot {
            repos: app.repos.clone(),
            repo: app.repos.get(app.repo_sel).cloned(),
            pull: Pull {
                heads: vec!["op3".into()],
                ops: vec![op("op3", 3), op(&selected, 1)],
                prov: HashMap::new(),
                veto: HashMap::new(),
            },
            releases: app.releases.clone(),
        }),
    };
    assert!(app.apply_refresh(message));

    assert_eq!(app.selected_op().map(|op| op.id.as_str()), Some(selected.as_str()));
    assert_eq!(app.activity, Activity::Query);
    assert!(app.query.is_some());
    assert!(app.reputation.is_some());
}
```

Add these explicit failure/selection assertions:

```rust
#[test]
fn stale_or_failed_live_refresh_keeps_last_good_data() {
    let mut app = fixture();
    let old_ids: Vec<String> = app.pull.ops.iter().map(|op| op.id.clone()).collect();
    let stale = RefreshMessage {
        target: RefreshTarget {
            repo: Some("other/repo".into()),
            view: "main".into(),
        },
        result: Ok(RefreshSnapshot {
            repos: vec!["other/repo".into()],
            repo: Some("other/repo".into()),
            pull: Pull::default(),
            releases: Vec::new(),
        }),
    };
    assert!(!app.apply_refresh(stale));
    assert_eq!(app.pull.ops.iter().map(|op| op.id.clone()).collect::<Vec<_>>(), old_ids);

    let failed = RefreshMessage {
        target: app.refresh_target(),
        result: Err("offline".into()),
    };
    assert!(app.apply_refresh(failed));
    assert_eq!(app.pull.ops.iter().map(|op| op.id.clone()).collect::<Vec<_>>(), old_ids);
    assert!(app.status.contains("offline"));
}

#[test]
fn live_refresh_clamps_when_the_selected_item_disappears() {
    let mut app = fixture();
    app.op_sel = 1;
    let message = RefreshMessage {
        target: app.refresh_target(),
        result: Ok(RefreshSnapshot {
            repos: app.repos.clone(),
            repo: app.repos.get(app.repo_sel).cloned(),
            pull: Pull {
                heads: vec!["op3".into()],
                ops: vec![op("op3", 3)],
                prov: HashMap::new(),
                veto: HashMap::new(),
            },
            releases: Vec::new(),
        }),
    };
    assert!(app.apply_refresh(message));
    assert_eq!(app.op_sel, 0);
    assert_eq!(app.selected_op().map(|op| op.id.as_str()), Some("op3"));
}
```

- [ ] **Step 2: Run Rust tests to verify RED**

Run:

```bash
cd lazythad && AGENT=1 cargo test --locked app::tests::live_refresh
```

Expected: compile failure because the live refresh types/methods do not exist.

- [ ] **Step 3: Create the background refresh worker**

Create `lazythad/src/live.rs` with public message structs and a private worker
request channel:

```rust
use std::sync::mpsc;
use std::thread;

use anyhow::Result;

use crate::client::{Pull, Release, Remote};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshTarget {
    pub repo: Option<String>,
    pub view: String,
}

#[derive(Debug, Clone)]
pub struct RefreshSnapshot {
    pub repos: Vec<String>,
    pub repo: Option<String>,
    pub pull: Pull,
    pub releases: Vec<Release>,
}

#[derive(Debug, Clone)]
pub struct RefreshMessage {
    pub target: RefreshTarget,
    pub result: Result<RefreshSnapshot, String>,
}

trait RefreshSource: Send + 'static {
    fn fetch(&mut self, target: &RefreshTarget) -> Result<RefreshSnapshot, String>;
}
```

`LiveRefresh::new(remote)` spawns one thread that uses:

```rust
fn fetch_snapshot(remote: &Remote, target: &RefreshTarget) -> Result<RefreshSnapshot> {
    let mut repos = remote.repos()?;
    repos.sort();
    let repo = target
        .repo
        .as_ref()
        .filter(|name| repos.contains(name))
        .cloned()
        .or_else(|| repos.first().cloned());
    let (pull, releases) = match &repo {
        Some(name) => (
            remote.pull(name, &target.view)?,
            remote.releases(name)?,
        ),
        None => (Pull::default(), Vec::new()),
    };
    Ok(RefreshSnapshot { repos, repo, pull, releases })
}
```

Connect the worker seam to production with:

```rust
impl RefreshSource for Remote {
    fn fetch(&mut self, target: &RefreshTarget) -> Result<RefreshSnapshot, String> {
        fetch_snapshot(self, target).map_err(|error| error.to_string())
    }
}
```

`request` sends immediately only when idle; while busy it stores the newest
target as one coalesced pending request. `try_recv` uses
`mpsc::Receiver::try_recv`, marks the worker idle on a message, and immediately
submits the pending target if present. Channel disconnection becomes one error
message rather than a panic.

Use this state machine inside `LiveRefresh`:

```rust
pub struct LiveRefresh {
    requests: mpsc::Sender<RefreshTarget>,
    results: mpsc::Receiver<RefreshMessage>,
    in_flight: bool,
    active: Option<RefreshTarget>,
    pending: Option<RefreshTarget>,
    disconnected: bool,
}

impl LiveRefresh {
    pub fn new(remote: Remote) -> Self {
        Self::with_source(remote)
    }

    fn with_source<S: RefreshSource>(mut source: S) -> Self {
        let (request_tx, request_rx) = mpsc::channel::<RefreshTarget>();
        let (result_tx, result_rx) = mpsc::channel::<RefreshMessage>();
        thread::spawn(move || {
            while let Ok(target) = request_rx.recv() {
                let result = source.fetch(&target);
                if result_tx.send(RefreshMessage { target, result }).is_err() {
                    break;
                }
            }
        });
        Self {
            requests: request_tx,
            results: result_rx,
            in_flight: false,
            active: None,
            pending: None,
            disconnected: false,
        }
    }

    pub fn request(&mut self, target: RefreshTarget) -> bool {
        if self.in_flight {
            self.pending = Some(target);
            return false;
        }
        if self.requests.send(target.clone()).is_err() {
            self.disconnected = true;
            return false;
        }
        self.in_flight = true;
        self.active = Some(target);
        true
    }

    pub fn try_recv(&mut self) -> Option<RefreshMessage> {
        match self.results.try_recv() {
            Ok(message) => {
                self.in_flight = false;
                self.active = None;
                if let Some(target) = self.pending.take() {
                    self.request(target);
                }
                Some(message)
            }
            Err(mpsc::TryRecvError::Empty) => None,
            Err(mpsc::TryRecvError::Disconnected) if !self.disconnected => {
                self.disconnected = true;
                self.in_flight = false;
                Some(RefreshMessage {
                    target: self.active.take().or_else(|| self.pending.take()).unwrap_or(
                        RefreshTarget {
                            repo: None,
                            view: "main".into(),
                        },
                    ),
                    result: Err("live refresh worker disconnected".into()),
                })
            }
            Err(mpsc::TryRecvError::Disconnected) => None,
        }
    }
}
```

- [ ] **Step 4: Make App refresh application pure and selection-preserving**

Remove network calls from `App::new`, repo cursor movement, Enter, and the
normal `r` path. Add `pub(crate) refresh_requested: bool` to `App`; cursor
movement clears the old repo's pull/releases, sets a loading status, and
requests a refresh. Add `refresh_requested: false` to the literal fixtures in
`app.rs` and `ui.rs`; `App::new` itself initializes it to true. Delete the old
blocking `refresh` and `load_selected_repo` methods after their call sites are
replaced.

Implement `apply_refresh` to compare `message.target` with the currently
selected repo/view, discard stale results, retain data on errors, and on success
restore repo by name, op by id, and release by id. Do not clear `query`,
`query_input`, `activity`, or `reputation` during an automatic refresh.

Add these methods to `App`:

```rust
pub fn refresh_target(&self) -> RefreshTarget {
    RefreshTarget {
        repo: self.repos.get(self.repo_sel).cloned(),
        view: self.view.clone(),
    }
}

pub fn request_refresh(&mut self) {
    self.refresh_requested = true;
}

pub fn take_refresh_request(&mut self) -> bool {
    std::mem::take(&mut self.refresh_requested)
}

pub fn apply_refresh(&mut self, message: RefreshMessage) -> bool {
    let current_repo = self.repos.get(self.repo_sel).cloned();
    if message.target.view != self.view
        || (message.target.repo.is_some() && message.target.repo != current_repo)
    {
        return false;
    }
    let snapshot = match message.result {
        Ok(snapshot) => snapshot,
        Err(error) => {
            self.status = format!("live refresh error: {error}");
            return true;
        }
    };
    let selected_op = self.selected_op().map(|op| op.id.clone());
    let selected_release = self.selected_release().map(|release| release.id.clone());
    self.repos = snapshot.repos;
    self.repo_sel = snapshot
        .repo
        .as_ref()
        .and_then(|name| self.repos.iter().position(|repo| repo == name))
        .unwrap_or(0);
    self.pull = snapshot.pull;
    self.releases = snapshot.releases;
    self.op_sel = selected_op
        .and_then(|id| self.pull.ops.iter().position(|op| op.id == id))
        .unwrap_or_else(|| self.op_sel.min(self.pull.ops.len().saturating_sub(1)));
    self.release_sel = selected_release
        .and_then(|id| self.releases.iter().position(|release| release.id == id))
        .unwrap_or_else(|| {
            self.release_sel
                .min(self.releases.len().saturating_sub(1))
        });
    let repo = snapshot.repo.as_deref().unwrap_or("(no repo)");
    self.status = format!(
        "{repo}  ·  {} op(s)  ·  {} release(s)  ·  {} head(s)  ·  live",
        self.pull.ops.len(),
        self.releases.len(),
        self.pull.heads.len()
    );
    true
}
```

Add a small `queue_selected_repo` helper that resets `pull`, `releases`,
`op_sel`, `release_sel`, `query`, and `reputation`, returns the activity to
`Log`, sets `status` to `loading <repo>…`, and calls `request_refresh`. Invoke
it after repo cursor movement and Enter. These resets are for an explicit repo
selection change; `apply_refresh` itself preserves overlays during automatic
updates. Initialize `refresh_requested` to true and `status` to `loading…` in
`App::new`.

```rust
fn queue_selected_repo(&mut self) {
    self.pull = Pull::default();
    self.releases.clear();
    self.op_sel = 0;
    self.release_sel = 0;
    self.query = None;
    self.reputation = None;
    self.activity = Activity::Log;
    self.status = self
        .repos
        .get(self.repo_sel)
        .map(|repo| format!("loading {repo}…"))
        .unwrap_or_else(|| "loading…".into());
    self.request_refresh();
}
```

- [ ] **Step 5: Run App tests to verify GREEN**

Run:

```bash
cd lazythad && AGENT=1 cargo test --locked app::tests
```

Expected: all App state-transition tests pass.

- [ ] **Step 6: Wire periodic and manual refreshes into the terminal loop**

Declare `mod live;` in `main.rs`. After constructing `App`, create one
`LiveRefresh` and track
`next_refresh = Instant::now() + Duration::from_secs(2)`. Do not submit a
separate startup request: `App::new` initializes `refresh_requested` to true, so
the first loop iteration sends exactly one initial target.

On each 200ms loop iteration:

```rust
while let Some(message) = live.try_recv() {
    app.apply_refresh(message);
}
if app.take_refresh_request() || Instant::now() >= next_refresh {
    live.request(app.refresh_target());
    next_refresh = Instant::now() + Duration::from_secs(2);
}
```

Keep `--dump` synchronous. Update status rendering to include `live` while the
interactive app is healthy and retain the existing error text on failure.

- [ ] **Step 7: Add worker coalescing and responsiveness tests**

Use the `RefreshSource` seam from Step 3. Give `LiveRefresh::new(remote)` a
private generic `LiveRefresh::with_source(source)` constructor. Add a
channel-controlled fake and this test:

```rust
struct BlockingSource {
    started: mpsc::Sender<RefreshTarget>,
    release: mpsc::Receiver<()>,
}

impl RefreshSource for BlockingSource {
    fn fetch(&mut self, target: &RefreshTarget) -> Result<RefreshSnapshot, String> {
        self.started.send(target.clone()).unwrap();
        self.release.recv().unwrap();
        Ok(RefreshSnapshot {
            repos: target.repo.clone().into_iter().collect(),
            repo: target.repo.clone(),
            pull: Pull::default(),
            releases: Vec::new(),
        })
    }
}

#[test]
fn coalesces_while_busy_and_try_recv_never_waits() {
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let mut live = LiveRefresh::with_source(BlockingSource {
        started: started_tx,
        release: release_rx,
    });
    let target = |repo: &str| RefreshTarget {
        repo: Some(repo.into()),
        view: "main".into(),
    };

    assert!(live.request(target("one")));
    assert_eq!(started_rx.recv_timeout(Duration::from_secs(1)).unwrap(), target("one"));
    assert!(!live.request(target("two")));
    assert!(!live.request(target("three")));
    assert!(live.try_recv().is_none());

    release_tx.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    while live.try_recv().is_none() && Instant::now() < deadline {
        thread::yield_now();
    }
    assert_eq!(started_rx.recv_timeout(Duration::from_secs(1)).unwrap(), target("three"));
    release_tx.send(()).unwrap();
}
```

In `app.rs`, assert pressing `r` and moving the repo cursor only set
`refresh_requested`; use a fake/unreachable remote and prove no network error is
produced by `on_key` itself.

- [ ] **Step 8: Run all Rust tests and formatting**

Run:

```bash
cd lazythad
AGENT=1 cargo fmt --check
AGENT=1 cargo test --locked
```

Expected: formatting succeeds and all lazythad tests pass.

- [ ] **Step 9: Commit the live-TUI slice**

```bash
git add lazythad/src/live.rs lazythad/src/main.rs lazythad/src/app.rs lazythad/src/ui.rs
git -c user.name="Codex" -c user.email="codex@openai.com" commit -m "feat(lazythad): refresh remote views live"
```

---

### Task 5: Document P8, prove the full phase, and mark it shipped

**Files:**

- Modify: `packages/cli/README.md`
- Modify: `packages/watch/README.md`
- Modify: `lazythad/README.md`
- Modify: `npm/lazythad/README.md`
- Modify: `docs/getting-started.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/plans/2026-07-09-post-p3-roadmap.md`

**Interfaces:**

- Consumes: the completed CLI and TUI behavior from Tasks 1–4.
- Produces: accurate user documentation and a roadmap `**Shipped:**` paragraph
  that states the observer-only, client-decrypted polling model.

- [ ] **Step 1: Update user-facing documentation**

Document these exact points:

- `thaddeus watch [symbol] [--kind <event>]... [--interval <duration>] [--json]`.
- The baseline is silent; text is line-oriented and JSON is JSONL.
- Filters follow a stable symbol id through signed renames.
- The watcher uses an in-memory mirror and never updates or cleans the working
  tree; users still run `thaddeus pull` explicitly.
- Transient errors retry and Ctrl-C exits cleanly.
- Lazythad refreshes every two seconds in the background, preserves selection,
  and keeps last-known-good data on errors.
- Polling uses existing public ciphertext pulls; semantic derivation remains
  local and decryption-bounded.

- [ ] **Step 2: Mark P8 shipped without overstating transport guarantees**

Add a `**Shipped:**` paragraph beneath P8 in the roadmap. State that this is
polling, not durable offline delivery, SSE, WebSockets, or server-side semantic
processing. Update the changelog with the same trust boundary.

Use this roadmap wording:

```markdown
**Shipped:** `thaddeus watch` polls the existing atomic pull route into an
isolated in-memory mirror and streams decryption-bounded semantic events, with
optional stable-symbol/event-kind filters and JSONL output. The silent baseline
and every later diff stay client-side; the command never changes checked-out
files or the durable working-copy store. Lazythad now refreshes in a
single-flight background worker while preserving selection and last-known-good
data. This is live polling, not durable offline delivery, SSE/WebSockets, or a
server-side plaintext semantic index.
```

Use a matching changelog bullet headed `P8 Watch / Subscriptions` and list the
CLI contract, stable remote rename reconciliation, retry/abort behavior, and
non-blocking two-second TUI refresh.

- [ ] **Step 3: Run the complete focused verification matrix**

Run from the repository root:

```bash
export AGENT=1
export PATH="$HOME/.proto/bin:$HOME/.cargo/bin:$PATH"
moon run graph:typecheck watch:typecheck cli:typecheck
moon run graph:test watch:test server:test client:test cli:test
(
  cd lazythad
  cargo fmt --check
  cargo test --locked
)
```

Expected: every task exits 0 and every test suite reports zero failures.

- [ ] **Step 4: Run the repository baseline and diff checks**

Run:

```bash
export AGENT=1
export PATH="$HOME/.proto/bin:$HOME/.cargo/bin:$PATH"
moon run root:format root:lint
git diff --check
git status --short
```

Expected: formatter succeeds, lint has zero errors, `git diff --check` has no
output, and status lists only the intended P8 files.

- [ ] **Step 5: Perform a bounded requirements review**

Read the approved design and check off every goal, non-goal, CLI contract item,
error/concurrency rule, and test claim against the final diff and command
output. Reject any implementation that mutates the durable working-copy store,
writes semantic data server-side, overlaps polls, contaminates JSON stdout with
diagnostics, or blocks lazythad's terminal loop on automatic refresh.

- [ ] **Step 6: Commit the completed P8 phase**

```bash
git add CHANGELOG.md docs/getting-started.md docs/plans/2026-07-09-post-p3-roadmap.md lazythad/README.md npm/lazythad/README.md packages/cli/README.md packages/watch/README.md
git -c user.name="Codex" -c user.email="codex@openai.com" commit -m "docs: mark P8 watch subscriptions shipped"
```

- [ ] **Step 7: Verify the final committed state**

Run:

```bash
git status --short
git log -6 --oneline
```

Expected: the working tree is clean and the P8 commits appear in task order.
