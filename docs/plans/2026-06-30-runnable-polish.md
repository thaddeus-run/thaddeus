# Runnable polish — `thaddeus serve` + atomic pull + rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Thaddeus cleanly runnable — a `thaddeus serve` command, a
race-free atomic `GET /pull`, and the forward-facing Thaddeus→Thaddeus rename.

**Architecture:** `serve` is a thin, testable `startServer()` (wrapping the
existing `createServer` + `Bun.serve`) plus a blocking CLI command. The atomic
pull adds `view`+`heads` to the pull response (additive) and collapses
`Client.clone` to a single request. The rename is a mechanical text sweep over
forward-facing files only. No new substrate.

**Tech Stack:** TypeScript (ESM), Bun (`Bun.serve`, `bun:test`), moon, tsdown.
Reuses `server`/`persist`/`platform`/`client`. No new third-party deps.

## Global Constraints

- **Spec:** `docs/specs/2026-06-30-thaddeus-runnable-polish-design.md` is the
  source of truth.
- **No new substrate; additive only.** The server's only change is two derived
  fields (`view`, `heads`) on the pull response — existing readers (which take
  `{ops, objects, caps}`) are unaffected. No new records, no crypto.
- **`serve` lives in the CLI**, factored as a testable
  `startServer(opts): RunningServer` that does NOT block; the `serve` command
  blocks (awaits forever) and wires `SIGINT → stop() → exit 0`.
  `@thaddeus.run/server` moves from a devDependency to a runtime dependency of
  `@thaddeus.run/cli`.
- **`Client.clone` makes ONE request** (`GET /pull`), reading `heads` from the
  response — no separate `/views` call. The `GET /views/:view` endpoint stays.
- **Rename forward-facing only:** the 8 package `README.md`s +
  `ARCHITECTURE.md` + `AGENTS.md` (naming section) + `CHANGELOG.md` + the CLI
  README usage. `docs/specs` and `docs/plans` are NOT touched (dated artifacts).
- **Tooling:** `bun` only (never npm/pnpm/npx); `moon run <project>:<task>`;
  `AGENT=1` for tests; Conventional Commits 1.0.0; trailing newlines;
  `isolatedDeclarations: true`. Port-binding tests run with `CI=`. No
  `Math.random`. No dynamic `import()` in shipped src. The repo forbids
  `.rejects.toThrow()` (use the `expectRejects` helper if needed).
- **Verification baseline:** `moon run root:format root:lint` + affected
  `moonx <project>:typecheck` and `moonx <project>:test`.

---

### Task 1: `thaddeus serve` (`startServer` + the command)

**Files:**

- Modify: `packages/cli/package.json` (move `@thaddeus.run/server` to
  `dependencies`)
- Create: `packages/cli/src/serve.ts`
- Modify: `packages/cli/src/run.ts` (the `serve` case + USAGE line),
  `src/index.ts` (export `startServer` + types)
- Test: `packages/cli/test/serve.test.ts`

**Interfaces:**

- Consumes: `createServer` (server), `FileBackend` (persist), `LandPolicy` type
  (platform), `Bun.serve`.
- Produces:
  - `interface ServeOptions { dataDir: string; port?: number; policy?: LandPolicy }`
  - `interface RunningServer { url: string; port: number; stop(): Promise<void> }`
  - `function startServer(opts: ServeOptions): RunningServer`

- [ ] **Step 1: Promote the server dep** — in `packages/cli/package.json`, move
      `"@thaddeus.run/server": "workspace:*"` from `devDependencies` into
      `dependencies` (alphabetical: after `@thaddeus.run/persist`, before
      `@thaddeus.run/platform`). Then `bun install`.

- [ ] **Step 2: Write the failing test**

`packages/cli/test/serve.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ready } from '@thaddeus.run/identity';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { run } from '../src/run';
import { startServer } from '../src/serve';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-serve-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('startServer', () => {
  test('serves over a real port and stops cleanly', async () => {
    const s = startServer({
      dataDir: mkdtempSync(join(tmp, 'data-')),
      port: 0,
    });
    expect(s.url).toContain('http://localhost:');
    const res = await fetch(`${s.url}/repos`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repos: [] });
    await s.stop();
  });

  test('a full CLI flow works against a live served port', async () => {
    const s = startServer({ dataDir: mkdtempSync(join(tmp, 'srv-')), port: 0 });
    try {
      const home = mkdtempSync(join(tmp, 'home-'));
      const e = (cwd: string) => ({ cwd, home, out: () => {} });
      expect(await run(['init'], e(home))).toBe(0);
      expect(await run(['create', s.url, 'proj'], e(home))).toBe(0);
      const a = mkdtempSync(join(tmp, 'a-'));
      expect(await run(['clone', s.url, 'proj', a], e(a))).toBe(0);
      writeFileSync(join(a, 'readme.md'), '# hi');
      expect(await run(['push'], e(a))).toBe(0);
      const b = mkdtempSync(join(tmp, 'b-'));
      expect(await run(['clone', s.url, 'proj', b], e(b))).toBe(0);
      expect(readFileSync(join(b, 'readme.md'), 'utf8')).toBe('# hi');
    } finally {
      await s.stop();
    }
  });
});
```

- [ ] **Step 3: Run it — expect FAIL** (`CI= AGENT=1 moon run cli:test`): cannot
      resolve `../src/serve`.

- [ ] **Step 4: Write `packages/cli/src/serve.ts`**

```ts
import type { LandPolicy } from '@thaddeus.run/platform';
import { FileBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';

// Options for a local Thaddeus server.
export interface ServeOptions {
  dataDir: string; // FileBackend root (the durable cold tier)
  port?: number; // default 4000; pass 0 for an OS-assigned port (tests)
  policy?: LandPolicy; // default blockOnConflict (createServer's default)
}

// A running server handle.
export interface RunningServer {
  url: string; // http://localhost:<port>
  port: number; // the resolved (possibly OS-assigned) port
  stop(): Promise<void>; // release the port
}

// Start a durable Thaddeus server over a FileBackend at `dataDir`. Does NOT
// block — returns a handle. The CLI `serve` command awaits indefinitely; tests
// call this directly, fetch against `url`, then `stop()`.
export function startServer(opts: ServeOptions): RunningServer {
  const srv = createServer({
    backend: new FileBackend(opts.dataDir),
    policy: opts.policy,
  });
  const http = Bun.serve({ port: opts.port ?? 4000, fetch: srv.fetch });
  return {
    url: `http://localhost:${http.port}`,
    port: http.port,
    stop: async (): Promise<void> => {
      await http.stop(true);
    },
  };
}
```

> Confirm `createServer`'s config accepts `policy?: LandPolicy | undefined` (it
> does — `ServerConfig.policy` is optional). Passing `policy: undefined` makes
> it use its default `blockOnConflict`.

- [ ] **Step 5: Add the `serve` case + export**

In `packages/cli/src/run.ts`, add the import (with the other `./` imports):

```ts
import { startServer } from './serve';
```

Add the `serve` case to the `switch` (before `case 'help'`):

```ts
      case 'serve': {
        const { values } = parseArgs({
          args: [...rest],
          options: { port: { type: 'string' }, data: { type: 'string' } },
          allowPositionals: true,
        });
        const dataDir = values.data ?? join(env.cwd, 'thaddeus-data');
        const port = values.port !== undefined ? Number(values.port) : 4000;
        const server = startServer({ dataDir, port });
        out(`thaddeus serving on ${server.url} (data: ${dataDir})`);
        process.on('SIGINT', () => {
          void server.stop().then(() => process.exit(0));
        });
        await new Promise<never>(() => {}); // block until interrupted
        return 0; // unreachable
      }
```

Add a `serve` line to the `USAGE` string (after `land`):

```
  serve  [--port 4000] [--data ./thaddeus-data]   run a server
```

In `packages/cli/src/index.ts`, add:

```ts
export { type RunningServer, type ServeOptions, startServer } from './serve';
```

- [ ] **Step 6: Run the test — expect PASS** (`CI= AGENT=1 moon run cli:test`).

- [ ] **Step 7: Typecheck + build** — `moon run cli:typecheck cli:build`.

- [ ] **Step 8: Commit**

```bash
git add packages/cli bun.lock
git commit -m "feat(cli): thaddeus serve — run a durable server in one command

startServer(opts) wraps createServer + Bun.serve over a FileBackend and
returns a { url, port, stop } handle (testable, non-blocking). The `serve`
command (--port/--data) prints the URL, wires SIGINT->stop->exit, and blocks.
@thaddeus.run/server is now a runtime dep of the CLI.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 2: Atomic `GET /pull` (server) + single-read `clone` (client)

**Files:**

- Modify: `packages/server/src/server.ts` (the `pull` handler return)
- Test: `packages/server/test/read.test.ts` (assert view+heads)
- Modify: `packages/client/src/client.ts` (`clone` single read)
- Test: `packages/client/test/clone.test.ts` (assert one request, no `/views`)

**Interfaces:**

- Produces: pull response shape
  `{ view: string; heads: string[]; ops: string[]; objects: string[]; caps: string[] }`.
  `Client.clone` unchanged signature.

- [ ] **Step 1: Write the failing server test** — add to
      `packages/server/test/read.test.ts` (inside the existing `describe`):

```ts
test('pull returns view + heads alongside the bundle', async () => {
  const a = Identity.create();
  const srv = createServer({ backend: new MemoryBackend() });
  await srv.fetch(signedPost('/repos', { name: 'acme/web' }, a));
  const pull = await srv.fetch(
    new Request('http://t/repos/acme%2Fweb/pull?view=main')
  );
  const body = (await pull.json()) as {
    view: string;
    heads: string[];
    ops: string[];
  };
  expect(body.view).toBe('main');
  expect(body.heads).toEqual([]);
  expect(body.ops).toEqual([]);
});
```

> Match the existing helpers in `read.test.ts` (`signedPost`, `Identity`,
> `MemoryBackend`, `createServer`). If `read.test.ts` lacks `signedPost`, use
> the same inline signed-request helper the other server tests use, or create
> the repo via the existing pattern in that file.

- [ ] **Step 2: Run it — expect FAIL** (`AGENT=1 moon run server:test`):
      `body.view` is undefined.

- [ ] **Step 3: Make the pull response atomic** — in
      `packages/server/src/server.ts`, the `pull` handler's final return changes
      from:

```ts
return json(200, encodeBundle(ops, objects, caps));
```

to:

```ts
return json(200, {
  view,
  heads: [...repo.log.heads(view)],
  ...encodeBundle(ops, objects, caps),
});
```

- [ ] **Step 4: Run the server test — expect PASS**
      (`AGENT=1 moon run server:test`): the new test + all existing server tests
      (the e2e clone decodes the bundle from the same response — the extra
      fields don't break `decodeBundle`).

- [ ] **Step 5: Write the failing client test** — add to
      `packages/client/test/clone.test.ts`:

```ts
test('clone makes a single /pull request (no /views call)', async () => {
  const a = Identity.create();
  const srv = createServer({ backend: new MemoryBackend() });
  const paths: string[] = [];
  // Wrap the server fetch to record request paths.
  const recordingFetch = (req: Request): Promise<Response> => {
    paths.push(new URL(req.url).pathname);
    return srv.fetch(req);
  };
  const c = new Client('http://t', a, recordingFetch);
  await c.createRepo('r');
  paths.length = 0; // ignore the create
  const { heads } = await c.clone('r', new MemoryBackend());
  expect([...heads]).toEqual([]);
  const gets = paths.filter((p) => p.includes('/pull') || p.includes('/views'));
  expect(gets).toEqual(['/repos/r/pull']); // exactly one read, the pull
});
```

> Match the existing `clone.test.ts` imports (`Identity`, `ready`,
> `MemoryBackend`, `createServer`, `Client`).

- [ ] **Step 6: Run it — expect FAIL** (`AGENT=1 moon run client:test`): clone
      still calls `/views` first, so `gets` has two entries.

- [ ] **Step 7: Collapse `clone` to a single read** — in
      `packages/client/src/client.ts`, replace the two-fetch body of `clone`
      (the `viewRes`/`viewBody` + `pullRes`/`bundle` block) with a single read:

```ts
const enc = encodeURIComponent;
const res = await this.#fetch(
  new Request(`${this.#server}/repos/${enc(name)}/pull?view=${enc(view)}`)
);
const body = (await this.#ok(res)) as { heads: string[] } & Parameters<
  typeof decodeBundle
>[0];
const bundle = decodeBundle(body);

const repo = await new Platform().openDurable(name, backend);
for (const object of bundle.objects) {
  await repo.store.ingest(
    object,
    bundle.caps.filter((c) => c.object === object.plaintext_id)
  );
}
for (const op of bundle.ops) {
  await repo.log.ingest(op);
}
await repo.log.repoint(view, body.heads);
return { repo, heads: body.heads };
```

(Remove the now-unused `viewRes`/`viewBody` lines. The method signature and the
rest of the file are unchanged.)

- [ ] **Step 8: Run the client tests — expect PASS**
      (`AGENT=1 moon run client:test`): the one-request test + the existing
      empty-clone + the publish round-trip (clone still returns heads and
      materializes content).

- [ ] **Step 9: Typecheck** — `moon run server:typecheck client:typecheck`.

- [ ] **Step 10: Commit**

```bash
git add packages/server packages/client
git commit -m "feat(server,client): atomic pull — one request, race-free clone

GET /pull now returns { view, heads, ...bundle } (additive — existing readers
ignore the extra fields). Client.clone reads heads from the pull response in a
single request and drops the separate /views call, so a concurrent land can no
longer split the snapshot (closes the PR #12 clone TOCTOU).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 3: Strata → Thaddeus rename (forward-facing) + docs

**Files:**

- Modify:
  `packages/{reputation,platform,server,agent,provenance,log,fs,persist}/README.md`
- Modify: `packages/cli/README.md` (rename + the `serve` usage)
- Modify: `AGENTS.md` (naming section), `ARCHITECTURE.md`, `CHANGELOG.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Sweep the package READMEs** — in each of the 8 READMEs
      (`packages/reputation/README.md`, `packages/platform/README.md`,
      `packages/server/README.md`, `packages/agent/README.md`,
      `packages/provenance/README.md`, `packages/log/README.md`,
      `packages/fs/README.md`, `packages/persist/README.md`), replace every
      `Thaddeus (working name)` with `Thaddeus`, and every remaining standalone
      `Thaddeus` with `Thaddeus`. Read each file, apply the edits, and confirm
      the sentence still reads naturally (e.g. `for **Thaddeus**` →
      `for **Thaddeus**`).

- [ ] **Step 2: Update `AGENTS.md` naming** — find the `## Naming` section. It
      currently says Thaddeus is the working name that may be renamed. Replace
      that bullet/paragraph with:

```markdown
- **Thaddeus** is the product (and the company). The working name "Strata" is
  retired.
- Packages live under the `@thaddeus.run/*` npm scope with neutral,
  product-agnostic names (e.g. `store`, `identity`, `theme`) — so a future
  product rename never forces a package rename.
```

(Preserve any other naming guidance in that section; only the Thaddeus line
changes.)

- [ ] **Step 3: `ARCHITECTURE.md`** — replace `Thaddeus` → `Thaddeus`
      throughout, and in the "Client & CLI" section add a sentence that the
      server is now runnable in one command via **`thaddeus serve`**.

- [ ] **Step 4: `CHANGELOG.md`** — (a) replace `Thaddeus` → `Thaddeus` in the
      existing `[Unreleased]` entries; (b) add an Added bullet:

```markdown
- `thaddeus serve` + atomic pull — run a durable server in one command
  (`thaddeus serve [--port] [--data]`, over a `FileBackend`), and `GET /pull`
  now returns `{ view, heads, …bundle }` so `Client.clone` is a single race-free
  request (closing the clone read-read race). The product name **Thaddeus**
  replaces the working name "Strata" in forward-facing docs.
```

- [ ] **Step 5: `packages/cli/README.md`** — update the usage block so it starts
      with `thaddeus serve` (no hand-rolled launcher), matching the spec §9:

```
thaddeus serve --data ./srv-data &       # run a server
thaddeus init                            # create a self-owned identity
thaddeus create http://localhost:4000 me/notes
thaddeus clone http://localhost:4000 me/notes ~/notes
cd ~/notes && echo "# notes" > readme.md && thaddeus push
```

- [ ] **Step 6: Verify the rename is complete + scoped** —

```bash
grep -rI "Thaddeus" packages/*/README.md AGENTS.md ARCHITECTURE.md CHANGELOG.md
```

Expected: **no output** (zero matches). Then confirm history is untouched:

```bash
git status --short docs/   # expected: empty (no docs/specs or docs/plans changed)
```

- [ ] **Step 7: Format** — `moon run root:format`.

- [ ] **Step 8: Commit**

```bash
git add packages/*/README.md AGENTS.md ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: rename Thaddeus -> Thaddeus (forward-facing) + record serve/atomic-pull

The product is Thaddeus; the working name Thaddeus is retired in package
READMEs, AGENTS.md, ARCHITECTURE.md, and the CHANGELOG. CHANGELOG/ARCHITECTURE
note thaddeus serve and the atomic pull; the CLI README usage now starts with
thaddeus serve. Historical docs/specs + docs/plans are left as dated artifacts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 4: Full-workspace verification

**Files:** none (verification only).

- [ ] **Step 1: Build the whole workspace** — `moon run :build` Expected: every
      package builds. (Pre-existing/unrelated: `apps/landing` `missing_outputs`,
      untouched.)

- [ ] **Step 2: Format + lint** — `moon run root:format root:lint` Expected: 0
      errors (pre-existing warnings only).

- [ ] **Step 3: Typecheck affected** —
      `moon run cli:typecheck server:typecheck client:typecheck` Expected: all
      PASS.

- [ ] **Step 4: Affected tests** —
      `CI= AGENT=1 moon run cli:test server:test client:test` Expected: all
      green (serve flow, atomic pull, one-request clone).

- [ ] **Step 5: Full suite** — `CI= AGENT=1 moon run :test` Expected: 0 failures
      across the workspace (the changes are additive; nothing else touched).

- [ ] **Step 6: Confirm the rename** —
      `grep -rI "Thaddeus" packages/*/README.md AGENTS.md ARCHITECTURE.md CHANGELOG.md`
      Expected: no output; `git diff --name-only main -- docs/` shows only the
      new spec/plan, no historical-doc edits.

- [ ] **Step 7: Final commit (only if format/lint produced changes)**

```bash
git add -A
git commit -m "chore: repo-wide format/lint pass for runnable polish

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

(If `git status` is clean after Step 2, skip this commit.)

---

## Notes for the implementer

- **`startServer` does NOT block; the `serve` command does.** Keep the blocking
  (`await new Promise<never>(() => {})`) and the SIGINT handler in `run.ts`, not
  in `startServer` — that's what makes `startServer` testable. Tests drive
  `startServer` directly, never `run(['serve'])` (which would hang).
- **The pull change is additive.** Do not remove `ops`/`objects`/`caps` from the
  response or change `encodeBundle`; just spread it alongside `view`/`heads`.
  The server e2e clone and `decodeBundle` keep working unchanged.
- **`clone` reads `heads` from the pull body** — delete the `/views` fetch
  entirely; do not keep both. The standalone `GET /views/:view` server endpoint
  stays for other callers.
- **Rename is forward-facing only.** Never edit anything under `docs/specs` or
  `docs/plans`. The Step-6 grep must return nothing and `docs/` must show no
  changes.
- **Port-binding tests use `CI=`** and always `await stop()` (in a `finally`).
- **`bun install` after the package.json change** (Task 1).
