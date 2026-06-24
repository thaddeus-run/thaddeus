# Pillar 05 — Virtual FS (the working copy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@thaddeus.run/fs` — a copy-on-write `Workspace` over the
`@thaddeus.run/log` operation log: a pinned, forked-view working copy with
`read`/`list`/`grep`/`write`/`rm`/`status`/`commit`/`fork`, and reroute the
north-star's first step to originate in a `Workspace` (staying 5 pass / 0 todo).

**Architecture:** A new package with one source module, `workspace.ts`. A
`Workspace` opens a **private, zero-copy forked view** of the op-log
(`OpLog.fork`); because `OpLog.append` never moves a view, that base is pinned
against peers for free. Reads (`read`/`list`/`grep`) project
`OpLog.materialize(view, reader)` layered under an in-memory **edit overlay**;
edits (`write`/`rm`) mutate only the overlay; `commit` folds the overlay into
signed ops via `OpLog.write`/`OpLog.remove`. `read`/`grep` are
**decryption-bounded** (a `store.get` that raises `AccessDenied` ⇒ `null`/skip).
It consumes `store` for the `AccessDenied` value and imports `OpLog`/`Op` and
`Identity` as types only.

**Tech Stack:** TypeScript (ESM, `type: module`), Bun test runner, moon task
runner, tsdown bundler. No new runtime dependencies and **no crypto of its own**
— all signing/encryption is delegated to `log`/`store`/`identity`.

## Global Constraints

- **Spec:** `docs/specs/2026-06-24-thaddeus-pillar-05-virtual-fs-design.md` is
  the source of truth for this plan.
- **Private forked view (rigid).** A workspace binds to its own view via
  `log.fork(privateView, source)` and never edits a shared view in place. This
  is what gives isolation between workspaces and the pinned base.
- **Pinned base (rigid).** Reads project `materialize(privateView, reader)`; the
  view advances **only** by this workspace's own `commit`. Peer ops never shift
  it (P03 `append()` does not move views). No snapshot cache.
- **`commit` is a non-blocking append.** Ops parent at the workspace's pinned
  heads; `commit` never rebases, blocks, or rejects. Convergence/conflicts are
  P03's job at land time, not P05's.
- **Edits stage in a COW overlay.** `write`/`rm` are synchronous and touch no
  crypto/store/log. Signing + `store.put` happen only in `commit`.
- **Decryption-bounded reads (fail soft).** `read` returns `null` on
  absent/`AccessDenied`; `grep` skips undecryptable objects. Neither throws on a
  denied read. `list` is **not** bounded — paths (op metadata) are cleartext, so
  `list` shows a path even when its content is undecryptable.
- **Deferred (out of scope, do not build):** landing/merge onto a shared view,
  3-way content merge, `sync()` of the pinned base, `mv`/`mkdir`, a search
  index, workspace-view GC, persistence/network. Spike: in-memory, single
  process.
- **Tooling:** use `bun` (never npm/pnpm/npx). Run tasks through moon:
  `moon run <project>:<task>`. Export `AGENT=1` for AI-friendly test output.
  Preserve trailing newlines. Commit messages follow Conventional Commits 1.0.0.
- **Naming:** package is `@thaddeus.run/fs` (neutral, product-agnostic); primary
  export `Workspace`. The vision file uses "Strata"; package names never use
  `strata-`.
- **Verification baseline after code changes:** `moon run root:format root:lint`
  plus the affected `moonx fs:typecheck` and `moonx fs:test`.

---

### Task 1: Scaffold `@thaddeus.run/fs` and the `Workspace` read/edit core

Create the package skeleton (copying `packages/provenance`'s exact config shape)
and the `Workspace` class with `open`, the COW overlay (`write`/`rm`/`status`),
and the layered reads (`read`/`list`). `commit`, `grep`, and `fork` arrive in
Tasks 2–4.

**Files:**

- Create: `packages/fs/package.json`
- Create: `packages/fs/moon.yml`
- Create: `packages/fs/tsconfig.json`
- Create: `packages/fs/tsdown.config.ts`
- Create: `packages/fs/README.md`
- Create: `packages/fs/LICENSE.md` (copy of `packages/log/LICENSE.md`)
- Create: `packages/fs/src/workspace.ts`
- Create: `packages/fs/src/index.ts`
- Test: `packages/fs/test/workspace.test.ts`

**Interfaces:**

- Consumes: `Identity` (type) from `@thaddeus.run/identity`; `OpLog`, `Op`
  (types) from `@thaddeus.run/log`; `AccessDenied` (value), `Ref`, `Store`
  (types) from `@thaddeus.run/store`.
- Produces (later tasks rely on these exact signatures):
  - `interface Change { readonly path: string; readonly change: 'write' | 'rm'; }`
  - `interface Match { readonly path: string; readonly line: number; readonly text: string; }`
  - `class Workspace` with:
    - `static open(log: OpLog, store: Store, opts: { source: string; reader: Identity; name?: string }): Workspace`
    - `read(path: string): Promise<Uint8Array | null>`
    - `list(prefix?: string): Promise<readonly string[]>`
    - `write(path: string, bytes: Uint8Array): void`
    - `rm(path: string): void`
    - `status(): readonly Change[]`
    - (Task 2) `commit(author: Identity): Promise<readonly Op[]>`
    - (Task 3) `grep(pattern: string | RegExp): Promise<readonly Match[]>`
    - (Task 4) `fork(opts?: { reader?: Identity; name?: string }): Workspace`

- [ ] **Step 1: Create the package config files**

`packages/fs/package.json`:

```json
{
  "name": "@thaddeus.run/fs",
  "version": "0.0.0",
  "description": "A virtual, API-first filesystem — a copy-on-write Workspace over the operation log, with pinned forked-view reads, overlay staging, commit, and decryption-bounded grep. Pillar 05.",
  "keywords": [
    "filesystem",
    "workspace",
    "operation-log",
    "strata",
    "substrate"
  ],
  "homepage": "https://thaddeus.run",
  "bugs": {
    "url": "https://github.com/thaddeus-run/thaddeus/issues"
  },
  "license": "Apache-2.0",
  "author": {
    "name": "thaddeus.run",
    "url": "https://thaddeus.run"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/thaddeus-run/thaddeus.git",
    "directory": "packages/fs"
  },
  "files": ["dist", "LICENSE.md", "README.md"],
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "prepublishOnly": "moon run fs:prepublish"
  },
  "dependencies": {
    "@thaddeus.run/store": "workspace:*"
  },
  "devDependencies": {
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/log": "workspace:*",
    "@types/bun": "catalog:",
    "@typescript/native-preview": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:"
  }
}
```

> **Dependency note:** `@thaddeus.run/store` is a runtime dependency because the
> code uses the `AccessDenied` **value** (`instanceof`). `log` and `identity`
> are imported as **types only**, so they are devDependencies — the same split
> `packages/provenance` uses for its type-only `@thaddeus.run/log` import.

`packages/fs/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

language: 'typescript'
layer: 'library'
tags: ['tsdown', 'publishable']
```

`packages/fs/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.options.json",
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx",
    "src/**/*.json",
    "test/**/*.ts",
    "tsdown.config.ts"
  ],
  "exclude": ["node_modules", "dist"],
  "compilerOptions": {
    "isolatedDeclarations": true,
    "allowJs": false,
    "checkJs": false,
    "emitDeclarationOnly": true,
    "outDir": "dist",
    "lib": ["ES2023"],
    "types": ["@types/bun"],
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "rootDir": "."
  }
}
```

`packages/fs/tsdown.config.ts`:

```ts
import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig([
  {
    entry: ['src/**/*.ts'],
    tsconfig: './tsconfig.json',
    clean: true,
    dts: {
      sourcemap: true,
      tsgo: true,
    },
    unbundle: true,
    platform: 'neutral',
  },
]);

export default config;
```

`packages/fs/README.md`:

```markdown
# @thaddeus.run/fs

The virtual filesystem for **Strata** (working name) — Pillar 05.

A `Workspace` is a copy-on-write working copy over a `@thaddeus.run/log`
operation log — the worktree-killer. It opens a private, zero-copy forked view
(pinned: peer ops never shift it), projects reads (`read`/`list`/`grep`) from
that view, stages edits (`write`/`rm`) in an in-memory overlay, and folds them
into signed ops on `commit`. `fork()` branches a working copy in O(1).
`read`/`grep` are decryption-bounded: you can only search what your identity is
allowed to read.

> **Status: spike.** In-memory, single process. Landing/merge onto a shared
> view, `sync()` of the pinned base, 3-way content merge, and `mv`/rename are
> deferred (see the design spec).
```

- [ ] **Step 2: Copy the license**

```bash
cp packages/log/LICENSE.md packages/fs/LICENSE.md
```

- [ ] **Step 3: Install so workspace symlinks resolve**

Run: `bun install` Expected: completes without error;
`node_modules/@thaddeus.run/fs` symlink is created.

- [ ] **Step 4: Write the failing test**

`packages/fs/test/workspace.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Workspace } from '../src/workspace';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('Workspace — open, edit overlay, reads', () => {
  test('a staged write is readable, listed, and shown in status before any commit', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });

    ws.write('src/a.rs', enc('fn a() {}'));
    expect(dec((await ws.read('src/a.rs'))!)).toBe('fn a() {}');
    expect(await ws.list()).toEqual(['src/a.rs']);
    expect(ws.status()).toEqual([{ path: 'src/a.rs', change: 'write' }]);
  });

  test('read returns null for an absent path', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    expect(await ws.read('nope.rs')).toBeNull();
  });

  test('reads project the pinned base (a pre-seeded op); an overlay write shadows it', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    // Seed the source view BEFORE opening — this is the base the workspace forks.
    await log.write('main', 'src/auth.rs', enc('fn old() {}'), author);

    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    expect(dec((await ws.read('src/auth.rs'))!)).toBe('fn old() {}');
    expect(await ws.list()).toContain('src/auth.rs');

    ws.write('src/auth.rs', enc('fn new() {}'));
    expect(dec((await ws.read('src/auth.rs'))!)).toBe('fn new() {}');
  });

  test('rm stages a tombstone: read null, gone from list, status shows rm', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    await log.write('main', 'src/auth.rs', enc('fn old() {}'), author);
    const ws = Workspace.open(log, store, { source: 'main', reader: author });

    ws.rm('src/auth.rs');
    expect(await ws.read('src/auth.rs')).toBeNull();
    expect(await ws.list()).not.toContain('src/auth.rs');
    expect(ws.status()).toEqual([{ path: 'src/auth.rs', change: 'rm' }]);
  });

  test('list filters by prefix and returns a sorted, deterministic order', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    ws.write('src/b.rs', enc('b'));
    ws.write('src/a.rs', enc('a'));
    ws.write('docs/x.md', enc('x'));
    expect(await ws.list('src/')).toEqual(['src/a.rs', 'src/b.rs']);
    expect(await ws.list()).toEqual(['docs/x.md', 'src/a.rs', 'src/b.rs']);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `AGENT=1 moon run fs:test` Expected: FAIL — cannot resolve
`../src/workspace` (module not yet created).

- [ ] **Step 6: Write the `Workspace` core**

`packages/fs/src/workspace.ts`:

```ts
import type { Identity } from '@thaddeus.run/identity';
import type { Op, OpLog } from '@thaddeus.run/log';
import { AccessDenied, type Ref, type Store } from '@thaddeus.run/store';

// A change staged in the copy-on-write overlay, not yet committed to the log.
type Staged =
  | { readonly kind: 'write'; readonly bytes: Uint8Array }
  | { readonly kind: 'tombstone' };

// What `status()` reports for a path with an uncommitted edit.
export interface Change {
  readonly path: string;
  readonly change: 'write' | 'rm';
}

// A grep hit: the path, the 1-based line number, and the matching line text.
export interface Match {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

// Process-local counter for unique private view names. There is no real
// filesystem and no global registry, so a monotonic integer suffices.
let workspaceSeq = 0;

// A copy-on-write working copy over a P03 op-log. Reads project a private,
// pinned forked view; edits stage in an in-memory overlay; commit folds the
// overlay into signed ops on that view. Spike — in-memory, single process, not
// durable, not concurrency-safe.
export class Workspace {
  readonly #log: OpLog;
  readonly #store: Store;
  readonly #reader: Identity;
  readonly #view: string;
  readonly #overlay: Map<string, Staged>;

  private constructor(
    log: OpLog,
    store: Store,
    reader: Identity,
    view: string,
    overlay: Map<string, Staged>
  ) {
    this.#log = log;
    this.#store = store;
    this.#reader = reader;
    this.#view = view;
    this.#overlay = overlay;
  }

  // Open a workspace over `source`. Forks a private zero-copy view at source's
  // current heads; because OpLog.append never moves a view, that base is pinned
  // against concurrent peers. `reader` bounds what reads/grep can decrypt.
  static open(
    log: OpLog,
    store: Store,
    opts: { source: string; reader: Identity; name?: string }
  ): Workspace {
    const view = opts.name ?? `ws/${opts.source}/${workspaceSeq++}`;
    log.fork(view, opts.source);
    return new Workspace(log, store, opts.reader, view, new Map());
  }

  // Decrypted bytes at `path`, or null if absent, staged-removed, or the reader
  // cannot decrypt it. Resolution order: overlay tombstone → overlay write →
  // base (materialize + store.get). Never throws on a denied read.
  async read(path: string): Promise<Uint8Array | null> {
    const staged = this.#overlay.get(path);
    if (staged !== undefined) {
      return staged.kind === 'write' ? staged.bytes : null;
    }
    const entry = this.#log.materialize(this.#view, this.#reader).get(path);
    if (entry === undefined || entry.ref === null) {
      return null;
    }
    return this.#read(entry.ref);
  }

  // store.get wrapped to fail soft: a denied/undecryptable object reads as null.
  async #read(ref: Ref): Promise<Uint8Array | null> {
    try {
      return await this.#store.get(ref, this.#reader);
    } catch (e) {
      if (e instanceof AccessDenied) {
        return null;
      }
      throw e;
    }
  }

  // Paths visible in the workspace: base paths ∪ staged writes, minus staged
  // tombstones, under an optional prefix, in sorted order. Not decryption-bounded
  // — a path whose content the reader cannot decrypt still appears (P03 keeps
  // paths cleartext); read() of it returns null and grep() skips it.
  async list(prefix = ''): Promise<readonly string[]> {
    const paths = new Set<string>(
      this.#log.materialize(this.#view, this.#reader).keys()
    );
    for (const [path, staged] of this.#overlay) {
      if (staged.kind === 'write') {
        paths.add(path);
      } else {
        paths.delete(path);
      }
    }
    return [...paths].filter((p) => p.startsWith(prefix)).sort();
  }

  // Stage a write into the overlay. Synchronous, isolated, unsigned.
  write(path: string, bytes: Uint8Array): void {
    this.#overlay.set(path, { kind: 'write', bytes });
  }

  // Stage a tombstone into the overlay. read/list/grep treat the path as absent.
  rm(path: string): void {
    this.#overlay.set(path, { kind: 'tombstone' });
  }

  // Uncommitted edits vs the base, in deterministic path order.
  status(): readonly Change[] {
    return [...this.#overlay.entries()]
      .map(
        ([path, s]): Change => ({
          path,
          change: s.kind === 'write' ? 'write' : 'rm',
        })
      )
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}
```

`packages/fs/src/index.ts`:

```ts
export { Workspace } from './workspace';
export type { Change, Match } from './workspace';
```

> **Note:** `Op` and `Match` are imported/declared now but only used by later
> tasks (`commit`, `grep`). The `Op` import is type-only; if the linter flags it
> as unused before Task 2, that is expected and Task 2 resolves it. To keep Task
> 1 self-contained and lint-clean, you may omit the `Op` import here and add it
> in Task 2 Step 3 — both are fine.

- [ ] **Step 7: Run the test to verify it passes**

Run: `AGENT=1 moon run fs:test` Expected: PASS — all five core tests green.

- [ ] **Step 8: Typecheck and build**

Run: `moon run fs:typecheck && moon run fs:build` Expected: both succeed;
`packages/fs/dist/index.js` and `index.d.ts` exist.

- [ ] **Step 9: Commit**

```bash
git add packages/fs bun.lock
git commit -m "feat(fs): Workspace read/edit core over a pinned forked view (Pillar 05)

New package @thaddeus.run/fs. Workspace.open forks a private zero-copy
view of the op-log (pinned: peer ops never shift it). read/list project
materialize() layered under a copy-on-write overlay; write/rm stage into
the overlay; status reports uncommitted edits. read fails soft on a
denied decrypt.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 2: `commit` — fold the overlay into signed ops

Add `commit`: each staged write becomes an `OpLog.write`, each tombstone an
`OpLog.remove`, on the workspace's private view. Pin the parents to the
workspace's heads and prove peers cannot shift the base.

**Files:**

- Modify: `packages/fs/src/workspace.ts` (add `commit`; add the `Op` import if
  omitted in Task 1)
- Test: `packages/fs/test/commit.test.ts`

**Interfaces:**

- Consumes: `Op`, `OpLog` (types) from `@thaddeus.run/log`; `Identity` (type)
  from `@thaddeus.run/identity`.
- Produces: `commit(author: Identity): Promise<readonly Op[]>` on `Workspace`.

- [ ] **Step 1: Write the failing test**

`packages/fs/test/commit.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Workspace } from '../src/workspace';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('Workspace — commit', () => {
  test('commit folds the overlay into ops, clears it, and the edits read back', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });

    ws.write('src/a.rs', enc('fn a() {}'));
    ws.write('src/b.rs', enc('fn b() {}'));
    const ops = await ws.commit(author);

    expect(ops).toHaveLength(2);
    expect(ws.status()).toEqual([]); // overlay cleared
    expect(dec((await ws.read('src/a.rs'))!)).toBe('fn a() {}');
    expect(dec((await ws.read('src/b.rs'))!)).toBe('fn b() {}');
  });

  test('an empty overlay commits to nothing', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    expect(await ws.commit(author)).toEqual([]);
  });

  test('commit ops parent at the pinned base, not on concurrent peer ops', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const peer = Identity.create();
    const base = await log.write('main', 'src/a.rs', enc('a0'), author);

    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    // A peer advances `main` AFTER the workspace opened.
    await log.write('main', 'src/a.rs', enc('a-peer'), peer);

    ws.write('src/a.rs', enc('a-mine'));
    const [op] = await ws.commit(author);
    expect(op!.parents).toEqual([base.id]);
  });

  test('pinned base: a peer write to the source after open does not change reads', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const peer = Identity.create();
    await log.write('main', 'src/a.rs', enc('a0'), author);

    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    await log.write('main', 'src/a.rs', enc('a-peer'), peer);

    expect(dec((await ws.read('src/a.rs'))!)).toBe('a0');
  });

  test('rm commits a tombstone op; the path is gone from the committed view', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    ws.write('src/a.rs', enc('a'));
    await ws.commit(author);

    ws.rm('src/a.rs');
    const [tomb] = await ws.commit(author);
    expect(tomb!.payload).toBeNull(); // payload:null tombstone
    expect(await ws.read('src/a.rs')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENT=1 moon run fs:test` Expected: FAIL — `ws.commit is not a function`.

- [ ] **Step 3: Add `commit` to the class**

In `packages/fs/src/workspace.ts`, ensure the `log` import includes `Op`:

```ts
import type { Op, OpLog } from '@thaddeus.run/log';
```

Add this method to the `Workspace` class (after `status`):

```ts
  // Fold the overlay into signed ops on the private view, in deterministic path
  // order: each staged write → log.write, each tombstone → log.remove. Each
  // log.write/log.remove advances the private view's heads, so a batch chains
  // correctly. Ops parent at the workspace's pinned heads (never on concurrent
  // peer ops). Returns the ops created, then clears the overlay; an empty
  // overlay returns []. This is the only path that signs or touches the store.
  async commit(author: Identity): Promise<readonly Op[]> {
    const ops: Op[] = [];
    for (const path of [...this.#overlay.keys()].sort()) {
      const staged = this.#overlay.get(path);
      if (staged === undefined) {
        continue;
      }
      if (staged.kind === 'write') {
        ops.push(await this.#log.write(this.#view, path, staged.bytes, author));
      } else {
        ops.push(await this.#log.remove(this.#view, path, author));
      }
    }
    this.#overlay.clear();
    return ops;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `AGENT=1 moon run fs:test` Expected: PASS — Task 1 + commit tests green.

- [ ] **Step 5: Typecheck and build**

Run: `moon run fs:typecheck && moon run fs:build` Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add packages/fs
git commit -m "feat(fs): Workspace.commit folds the overlay into signed ops

commit() turns each staged write into log.write and each tombstone into
log.remove on the private view, returns the ops, and clears the overlay.
Ops parent at the workspace's pinned heads, so concurrent peer edits stay
genuinely concurrent — convergence is the log's job, not the workspace's.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 3: `grep` — decryption-bounded content search

Add `grep`: a linear scan over every readable path (base the reader can
decrypt + staged writes as plaintext), skipping objects it cannot decrypt.

**Files:**

- Modify: `packages/fs/src/workspace.ts` (add `grep` + an `escapeRegExp` helper)
- Test: `packages/fs/test/grep.test.ts`

**Interfaces:**

- Consumes: `Match` (already declared in `workspace.ts`).
- Produces: `grep(pattern: string | RegExp): Promise<readonly Match[]>` on
  `Workspace`.

- [ ] **Step 1: Write the failing test**

`packages/fs/test/grep.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Workspace } from '../src/workspace';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('Workspace — grep (decryption-bounded)', () => {
  test('grep matches committed and staged content; 1-based lines, sorted by path then line', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    ws.write('src/auth.rs', enc('fn login() {}\nfn refresh() {}\n'));
    await ws.commit(author);
    ws.write('src/new.rs', enc('fn refresh_token() {}'));

    expect(await ws.grep('refresh')).toEqual([
      { path: 'src/auth.rs', line: 2, text: 'fn refresh() {}' },
      { path: 'src/new.rs', line: 1, text: 'fn refresh_token() {}' },
    ]);
  });

  test('grep skips base objects the reader cannot decrypt; read returns null', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const owner = Identity.create();
    const reader = Identity.create();
    // Owner writes a secret to `main` WITHOUT granting the reader.
    await log.write('main', 'secret.txt', enc('refresh THE SECRET'), owner);

    const ws = Workspace.open(log, store, { source: 'main', reader });
    // The path is visible (cleartext metadata) but its content is undecryptable.
    expect(await ws.list()).toContain('secret.txt');
    expect(await ws.read('secret.txt')).toBeNull();
    expect(await ws.grep('refresh')).toEqual([]); // skipped, not errored

    // A staged plaintext write IS searched.
    ws.write('mine.txt', enc('refresh mine'));
    expect(await ws.grep('refresh')).toEqual([
      { path: 'mine.txt', line: 1, text: 'refresh mine' },
    ]);
  });

  test('grep accepts a RegExp', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    ws.write('a.txt', enc('foo123bar'));
    expect(await ws.grep(/\d+/)).toEqual([
      { path: 'a.txt', line: 1, text: 'foo123bar' },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENT=1 moon run fs:test` Expected: FAIL — `ws.grep is not a function`.

- [ ] **Step 3: Add `grep` and the helper**

In `packages/fs/src/workspace.ts`, add this module-scope helper above the
`Workspace` class (after the `workspaceSeq` declaration is fine too):

```ts
// Escape a literal string so it can be used as a RegExp source.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

Add this method to the `Workspace` class (after `commit`):

```ts
  // Lines matching `pattern` across every readable path: base objects the reader
  // can decrypt plus staged overlay writes (as plaintext). Objects that cannot
  // be decrypted are silently skipped (read() returns null). Deterministic order
  // (by path via list(), then line). Linear scan, no index — a spike.
  async grep(pattern: string | RegExp): Promise<readonly Match[]> {
    // Build a non-global matcher so per-line test() carries no lastIndex state.
    const re =
      typeof pattern === 'string'
        ? new RegExp(escapeRegExp(pattern))
        : new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
    const matches: Match[] = [];
    for (const path of await this.list()) {
      const bytes = await this.read(path);
      if (bytes === null) {
        continue; // undecryptable or absent — skip, never error
      }
      const lines = new TextDecoder().decode(bytes).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i];
        if (text !== undefined && re.test(text)) {
          matches.push({ path, line: i + 1, text });
        }
      }
    }
    return matches;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `AGENT=1 moon run fs:test` Expected: PASS — grep tests green.

- [ ] **Step 5: Typecheck and build**

Run: `moon run fs:typecheck && moon run fs:build` Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add packages/fs
git commit -m "feat(fs): decryption-bounded Workspace.grep

grep scans every readable path — base objects the reader can decrypt plus
staged overlay writes as plaintext — and silently skips what it cannot
decrypt. You can only search what you are allowed to read. Linear scan,
no index (spike).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 4: `fork` — the cheap copy-on-write branch

Add `fork`: a fresh private view branched at this workspace's current heads,
plus a shallow copy of the overlay so in-flight edits carry over.

**Files:**

- Modify: `packages/fs/src/workspace.ts` (add `fork`)
- Test: `packages/fs/test/fork.test.ts`

**Interfaces:**

- Produces: `fork(opts?: { reader?: Identity; name?: string }): Workspace` on
  `Workspace`.

- [ ] **Step 1: Write the failing test**

`packages/fs/test/fork.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Workspace } from '../src/workspace';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('Workspace — fork (cheap COW branch)', () => {
  test('forked workspaces diverge: committed edits do not cross', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const a = Workspace.open(log, store, { source: 'main', reader: author });
    a.write('shared.rs', enc('base'));
    await a.commit(author);

    const b = a.fork();
    a.write('shared.rs', enc('from-a'));
    await a.commit(author);
    b.write('shared.rs', enc('from-b'));
    await b.commit(author);

    expect(dec((await a.read('shared.rs'))!)).toBe('from-a');
    expect(dec((await b.read('shared.rs'))!)).toBe('from-b');
  });

  test('fork carries in-flight (uncommitted) staged edits, then diverges', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const a = Workspace.open(log, store, { source: 'main', reader: author });
    a.write('draft.rs', enc('wip')); // staged, NOT committed

    const b = a.fork();
    expect(dec((await b.read('draft.rs'))!)).toBe('wip'); // carried over

    b.write('draft.rs', enc('b-wip'));
    expect(dec((await a.read('draft.rs'))!)).toBe('wip');
    expect(dec((await b.read('draft.rs'))!)).toBe('b-wip');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENT=1 moon run fs:test` Expected: FAIL — `a.fork is not a function`.

- [ ] **Step 3: Add `fork` to the class**

Add this method to the `Workspace` class (after `grep`):

```ts
  // Branch this workspace: a fresh private view forked at this workspace's
  // current (committed) heads, plus a shallow copy of the overlay so in-flight
  // staged edits carry over. Staged entries are immutable, so the shallow copy
  // is safe. O(head-set + overlay) — never copies the tree.
  fork(opts?: { reader?: Identity; name?: string }): Workspace {
    const view = opts?.name ?? `ws/${this.#view}/${workspaceSeq++}`;
    this.#log.fork(view, this.#view);
    return new Workspace(
      this.#log,
      this.#store,
      opts?.reader ?? this.#reader,
      view,
      new Map(this.#overlay)
    );
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `AGENT=1 moon run fs:test` Expected: PASS — fork tests green (full fs
suite: Tasks 1–4).

- [ ] **Step 5: Typecheck and build**

Run: `moon run fs:typecheck && moon run fs:build` Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add packages/fs
git commit -m "feat(fs): Workspace.fork — the cheap copy-on-write branch

fork() branches a working copy in O(1): a fresh forked view at this
workspace's heads plus a shallow overlay copy, so in-flight staged edits
carry over and then diverge. The worktree-killer headline.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 5: Reroute the north-star's first step through a `Workspace`

Change the seeded one-edit flow so the edit **originates in a `Workspace`**,
producing the `Op` the rest of the flow already consumes. The flow stays 5 pass
/ 0 todo.

**Files:**

- Modify: `integration/package.json` (add the `@thaddeus.run/fs` dependency)
- Modify: `integration/test/one-edit-end-to-end.test.ts` (add import; replace
  the `P05/P01` test body)

**Interfaces:**

- Consumes: `Workspace` from `@thaddeus.run/fs`; existing `Identity`, `OpLog`,
  `MemoryStore` already imported in the test.

- [ ] **Step 1: Add the dependency**

Edit `integration/package.json` `dependencies` to include the fs package (keep
alphabetical order — `fs` sorts before `identity`):

```json
  "dependencies": {
    "@thaddeus.run/fs": "workspace:*",
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/log": "workspace:*",
    "@thaddeus.run/provenance": "workspace:*",
    "@thaddeus.run/store": "workspace:*"
  },
```

- [ ] **Step 2: Install so the new workspace dep resolves**

Run: `bun install` Expected: completes without error.

- [ ] **Step 3: Add the import**

Edit the top of `integration/test/one-edit-end-to-end.test.ts`. Add, immediately
after the existing `import { OpLog } from '@thaddeus.run/log';` line:

```ts
import { Workspace } from '@thaddeus.run/fs';
```

(Resulting import block:)

```ts
import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import { MemoryStore, publicIdentity } from '@thaddeus.run/store';
```

> **Import order:** `oxlint`/`oxfmt` sort imports alphabetically by module path;
> `@thaddeus.run/fs` sorts first. If the formatter reorders the block on
> `root:format`, accept its order — the exact final order is the formatter's
> call.

- [ ] **Step 4: Replace the `P05/P01` test body**

In `integration/test/one-edit-end-to-end.test.ts`, replace this test:

```ts
test('P05/P01: write an object → stored as ciphertext a mirror can verify', async () => {
  const store = new MemoryStore();
  const author = Identity.create();
  const ref = await store.put(
    new TextEncoder().encode('fn refresh() {}'),
    author
  );
  expect(store.verify(ref.id)).toBe(true);
  expect(store.rawObject(ref.id)).toBeDefined();
});
```

with:

```ts
test('P05/P01: an edit originates in a Workspace → stored as ciphertext a mirror can verify', async () => {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const author = Identity.create();

  // The edit enters Strata through the virtual filesystem, not a hand-built op:
  // stage a write in a copy-on-write workspace, then commit it into the log.
  const ws = Workspace.open(log, store, { source: 'main', reader: author });
  ws.write('src/auth.rs', new TextEncoder().encode('fn refresh() {}'));
  const [op] = await ws.commit(author);

  // The commit produced a signed op whose payload is mirror-verifiable ciphertext.
  expect(op).toBeDefined();
  expect(op?.payload).not.toBeNull();
  if (op?.payload != null) {
    expect(store.verify(op.payload.id)).toBe(true);
    expect(store.rawObject(op.payload.id)).toBeDefined();
  }
});
```

- [ ] **Step 5: Run the north-star suite to verify it passes**

Run: `AGENT=1 moon run integration:test` Expected: PASS — 5 tests pass, 0 todo;
the first test now exercises `Workspace`.

- [ ] **Step 6: Commit**

```bash
git add integration
git commit -m "test(integration): the seeded edit now originates in a Workspace (P05)

Reroute the north-star's first step through @thaddeus.run/fs: stage a
write in a copy-on-write Workspace and commit it into the log, producing
the same signed Op the rest of the flow consumes. Edits enter Strata
through the virtual filesystem, not a hand-built op. Flow stays 5 pass /
0 todo.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 6: The workspace demo (`examples/workspace/`)

Add a runnable CLI demo (sibling to `examples/provenance/`) enacting the three
acts from spec §9: a working copy with no disk, cheap COW branches, and a
decryption-bounded grep.

**Files:**

- Create: `examples/workspace/package.json`
- Create: `examples/workspace/moon.yml`
- Create: `examples/workspace/tsconfig.json`
- Create: `examples/workspace/src/workspace.ts`

**Interfaces:**

- Consumes: `Identity`, `ready` from `@thaddeus.run/identity`; `OpLog` from
  `@thaddeus.run/log`; `Workspace` from `@thaddeus.run/fs`; `MemoryStore` from
  `@thaddeus.run/store`.

- [ ] **Step 1: Create the example config files**

`examples/workspace/package.json`:

```json
{
  "name": "@thaddeus.run/example-workspace",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@thaddeus.run/fs": "workspace:*",
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/log": "workspace:*",
    "@thaddeus.run/store": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "catalog:"
  }
}
```

`examples/workspace/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

id: 'example-workspace'
language: 'typescript'
layer: 'application'

tasks:
  # No test suite yet; keep `moon run :test` green repo-wide.
  test:
    args: '--pass-with-no-tests'

  # Build-graph-connected, so CI-skipped; run in agent shells with a CI= prefix.
  demo:
    command: 'bun src/workspace.ts'
    deps:
      - '^:build'
    options:
      cache: false
      runInCI: 'skip'
```

`examples/workspace/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.options.json",
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules"],
  "compilerOptions": {
    "noEmit": true,
    "lib": ["ES2023"],
    "types": ["@types/bun"],
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler"
  }
}
```

- [ ] **Step 2: Write the demo**

`examples/workspace/src/workspace.ts`:

```ts
// Virtual filesystem demo for @thaddeus.run/fs (Pillar 05).
// Run: CI= moon run example-workspace:demo
//
// Three acts: (1) a working copy with no disk — write/grep/commit through the
// API; (2) cheap copy-on-write branches via fork(); (3) grep stops at the
// capability boundary — an undecryptable file is invisible, not an error.

import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const rule = (): void => console.log('—'.repeat(60));

await ready();
const store = new MemoryStore();
const log = new OpLog(store);
const dev = Identity.create();

// Act 1 — a working copy with no disk.
const ws = Workspace.open(log, store, { source: 'main', reader: dev });
ws.write('src/auth.rs', enc('fn login() {}\nfn refresh() {}\n'));
rule();
console.log('1. edit with no checkout — staged, uncommitted:');
console.log('   list:        ', await ws.list());
console.log('   grep refresh:', await ws.grep('refresh'));
console.log('   status:      ', ws.status());
const ops = await ws.commit(dev);
console.log(`   commit → ${ops.length} op(s); status now:`, ws.status());

// Act 2 — cheap copy-on-write branches.
const branch = ws.fork();
ws.write('src/auth.rs', enc('fn refresh_v2() {}\n'));
await ws.commit(dev);
branch.write('src/auth.rs', enc('fn refresh_experimental() {}\n'));
await branch.commit(dev);
rule();
console.log('2. fork() → two divergent working copies, no tree copy:');
console.log('   main copy:  ', dec((await ws.read('src/auth.rs'))!).trim());
console.log('   forked copy:', dec((await branch.read('src/auth.rs'))!).trim());

// Act 3 — grep stops at the capability boundary.
const teammate = Identity.create();
// The teammate writes a secret to `main` WITHOUT granting `dev`.
await log.write('main', 'secrets.env', enc('API_KEY=refresh-me'), teammate);
const fresh = Workspace.open(log, store, { source: 'main', reader: dev });
rule();
console.log('3. grep is bounded by what you can decrypt:');
console.log(
  '   secrets.env in list (cleartext path):',
  (await fresh.list()).includes('secrets.env')
);
console.log('   dev reads secrets.env:', await fresh.read('secrets.env'));
console.log('   grep refresh hits:', await fresh.grep('refresh'));

rule();
console.log(
  'Acceptance: edits enter through the API, never a disk; fork is O(1);'
);
console.log('grep and read stop exactly at the capability boundary.');
```

- [ ] **Step 3: Install and run the demo**

Run: `bun install && CI= moon run example-workspace:demo` Expected: prints the
three acts; Act 1 shows a `refresh` grep hit and `commit → 1 op(s)` with empty
status; Act 2 shows the two copies differing (`fn refresh_v2()` vs
`fn refresh_experimental()`); Act 3 shows `secrets.env in list … true`,
`dev reads secrets.env: null`, and an empty `grep refresh hits: []`.

- [ ] **Step 4: Typecheck the example**

Run: `moon run example-workspace:typecheck` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/workspace
git commit -m "docs(fs): runnable demo — no-disk working copy, fork, bounded grep

examples/workspace enacts the three acts: edit/grep/commit with no
checkout, fork() into two divergent copies, and a grep that stops at the
capability boundary (an ungranted secret is listed but unreadable and
unsearchable).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 7: Update the convergence docs (ARCHITECTURE + CHANGELOG)

Flip the Pillar 05 row to built and record the release + deferred ledger
entries, per spec §12.

**Files:**

- Modify: `ARCHITECTURE.md` (Pillar 05 status row; `Op` shared-primitive row)
- Modify: `CHANGELOG.md` (`[Unreleased] → Added`; Deferred ledger)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `ARCHITECTURE.md` — status row**

In the **Status / traceability** table, change the Pillar 05 row from:

```
| 05 Virtual FS                         | _(planned)_          | planned | P6 P7 P8 P11     |
```

to:

```
| 05 Virtual FS                         | `fs`                 | built   | P6 P7 P8 P11     |
```

- [ ] **Step 2: Update `ARCHITECTURE.md` — shared-primitives row**

In the **Shared primitives** table, update the `Op (operation log entry)` row's
"Reused by" cell to include P05. Change:

```
| Op (operation log entry)              | `@thaddeus.run/log`      | P03 · P04 · P08 · P10                                   |
```

to:

```
| Op (operation log entry)              | `@thaddeus.run/log`      | P03 · P04 · P05 · P08 · P10                             |
```

(The column widths are reflowed by the formatter in Step 4 — don't hand-align.)

- [ ] **Step 3: Update `CHANGELOG.md`**

Under `## [Unreleased]` → `### Added`, after the existing
`@thaddeus.run/provenance` bullet, add:

```markdown
- `@thaddeus.run/fs` — the virtual filesystem (Pillar 05): a copy-on-write
  `Workspace` over the operation log. `open` forks a **private, pinned** view
  (peer ops never shift it); `read`/`list`/`grep` project that view layered
  under an in-memory edit overlay; `write`/`rm` stage into the overlay; `commit`
  folds it into signed ops via `log.write`/`log.remove`; `fork()` branches a
  working copy in O(1). `read`/`grep` are **decryption-bounded** — you can only
  search what your identity can decrypt. The north-star's seeded edit now
  originates in a `Workspace` (5 pass / 0 todo).
```

Then, in the **Deferred** ledger (place these alongside the existing scope-cut
entries; match the surrounding structure), add:

```markdown
- **Landing / merge onto a shared view (P05→P06/P10).** `commit` lands ops on
  the workspace's private view; re-pointing a shared view like `main` to include
  them (and the conflict resolution that implies) is platform/review territory.
- **`sync()` of the pinned base (P05).** A workspace's base does not advance to
  absorb newer source-view heads; the lifecycle this release is open → edit →
  commit → discard.
- **3-way content merge (P03/P05).** Concurrent same-path edits resolve by LWW
  and surface via `OpLog.conflicts()`; the FS adds no content merge.
- **`mv` / rename (P05→P08).** Path-level move is `rm` + `write`; semantic
  rename is the symbol-level op of Pillar 08.
- **Workspace-view GC and a grep index (P05).** Private views accumulate in the
  log's view map; `grep` is a linear scan. Both are spike non-goals.
```

- [ ] **Step 4: Format the docs**

Run: `moon run root:format` Expected: succeeds; Markdown tables/lists reflow
consistently (oxfmt may adjust spacing — that is fine).

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: mark Pillar 05 (virtual FS) built; changelog + deferred ledger

Flip the Pillar 05 row planned→built (@thaddeus.run/fs); add P05 to the Op
primitive's reuse list. Record the release under Added and ledger the
deferred items (landing/merge→P06/P10, sync(), 3-way content merge,
mv/rename→P08, view GC + grep index).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 8: Full-workspace verification

Run the repo-wide baseline so the new package, the integration reroute, the
demo, and the docs all land green together.

**Files:** none (verification only).

- [ ] **Step 1: Build the whole workspace**

Run: `moon run :build` Expected: every package builds, including
`@thaddeus.run/fs`. (This lets type-aware lint resolve the new package through
its `dist`.)

- [ ] **Step 2: Format and lint the repo**

Run: `moon run root:format root:lint` Expected: both succeed with no errors.

- [ ] **Step 3: Typecheck the affected projects**

Run: `moon run fs:typecheck integration:typecheck example-workspace:typecheck`
Expected: all PASS.

- [ ] **Step 4: Run the affected tests**

Run: `AGENT=1 moon run fs:test integration:test` Expected: all PASS — the fs
suite green (Tasks 1–4); integration 5 pass / 0 todo.

- [ ] **Step 5: Confirm nothing else regressed**

Run: `AGENT=1 moon run :test` Expected: the full repo test run is green.

- [ ] **Step 6: Run the demo once more end-to-end**

Run: `CI= moon run example-workspace:demo` Expected: the three acts print as in
Task 6 Step 3.

- [ ] **Step 7: Final commit (only if formatting/lint produced changes)**

```bash
git add -A
git commit -m "chore(fs): repo-wide format/lint pass for Pillar 05

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

(If `git status` is clean after Step 2, skip this commit.)

---

## Notes for the implementer

- **Why almost no new code:** the worktree-killer is mostly composition.
  `OpLog.fork` gives the zero-copy branch; `OpLog.append` never moving a view
  gives the pinned base; `OpLog.materialize` + `store.get` give reads;
  `OpLog.write`/`OpLog.remove` give commit. The only genuinely new code is the
  overlay, the read/grep layering, and the commit fold (spec §4.1).
- **The pinned base is structural, not cached.** A workspace reads
  `materialize(privateView, reader)` live; it is stable against peers because
  peer `append()` does not move `privateView`. Do not add a snapshot — the
  "pinned base" tests (Task 2) prove the structural property, and a cache would
  only let it drift.
- **`commit` parents at the pinned heads automatically.** `OpLog.write` parents
  at `heads(privateView)`; since only this workspace's commits advance that
  view, the first commit parents at the forked base. The Task 2 parents test
  pins this — if it fails, something is moving the private view (a bug).
- **Decryption-bounded vs. listed.** `read`/`grep` are bounded by `store.get`
  (catch `AccessDenied` → `null`/skip); `list` is **not** — paths are cleartext
  metadata, so a file you cannot read still appears in `list`. The Task 3 "skips
  base objects the reader cannot decrypt" test pins both halves.
- **`bun install` after every `package.json` change** (Tasks 1, 5, 6) so
  workspace symlinks resolve before you build or test.
- **`Op` import is type-only.** `@thaddeus.run/log` and `@thaddeus.run/identity`
  are devDependencies; only `@thaddeus.run/store` is a runtime dependency (the
  `AccessDenied` value). This mirrors `packages/provenance`.
- **Determinism:** tests use `Identity.create()` (fresh keys) but assert only on
  structural facts (bytes read back, parents, verified/undecryptable, sorted
  order), never on specific key bytes — so they are reproducible.

```

```
