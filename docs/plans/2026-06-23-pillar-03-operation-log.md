# Pillar 03 — Operation Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@thaddeus.run/log` — signed, CRDT-ordered `Op` records on a DAG
that converge deterministically, project to a file tree via last-writer-wins per
path, dissolve branches into zero-copy named views, and gate an embargoed op's
metadata through the P02 membrane.

**Architecture:** The source of truth becomes an append-only log of signed
operations; snapshots are a derived projection (`materialize()`). An `Op` splits
into cleartext metadata (path, parents-DAG, Lamport clock, author) any peer can
order/merge without decryption, and a capability-gated payload (a
`@thaddeus.run/store` `Ref`) only grantees read. A view is just
`{ name, heads }`. An embargoed op publishes only an opaque ordering token to
the public mirror; its real metadata is a second capability-gated store object
released at T via `store.scheduleReveal`/`reveal`.

**Tech Stack:** TypeScript, Bun (test runner), moon (task runner), tsdown
(build), `@noble/hashes/blake3` (op id), `@thaddeus.run/identity` (ed25519
sign/verify), `@thaddeus.run/store` (capability-gated payload + membrane). Spec:
`docs/specs/2026-06-23-thaddeus-pillar-03-operation-log-design.md`.

## Global Constraints

- **Runtime/tooling:** Bun only — never `npm`/`pnpm`/`npx`. Run tasks through
  moon: `moonx <project>:<task>` (alias for `moon run`). Set `export AGENT=1` at
  the start of every shell so Bun emits AI-friendly test output.
- **Focused test runs** use Bun directly from the package dir, e.g.
  `cd packages/log && AGENT=1 bun test test/oplog.test.ts`. Full gate per
  project: `moonx log:test`.
- **Dependencies** use the root `workspaces.catalog`; never add versions to
  package-level `package.json`. New cross-package deps use `workspace:*`.
- **Files end with a trailing newline.** Match the surrounding code's comment
  density and idiom (function-level comments explaining what/why for new
  helpers).
- **Commits** follow Conventional Commits 1.0.0. Every commit message ends with
  these two trailers (verbatim):
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5
  ```
  (Shown below as "+ standard trailers" to avoid repetition.)
- **Time values** are ISO-8601 strings (e.g. `2030-01-01T00:00:00.000Z`);
  compare via `Date.parse(...)` (ms). The embargo path reuses the store's
  injected-clock `now?` exactly as P02 does.
- **Identity API** (from `@thaddeus.run/identity`): `Identity.create()`,
  `identity.did`, `identity.sign(bytes): Uint8Array`, `identity.toPublic()`;
  `PublicIdentity.fromDid(did).verify(bytes, sig): boolean`; `await ready()`
  before use.
- **Store API** (from `@thaddeus.run/store`, public only):
  `Ref = { id: string; plaintext_id: string }`;
  `store.put(bytes, owner): Promise<Ref>`;
  `store.get(ref, reader, now?): Promise<Uint8Array>`;
  `store.scheduleReveal(ref, at, by): Promise<void>`;
  `store.reveal(ref, now?): Promise<boolean>`;
  `store.caps(plaintextId): readonly Capability[]` (served caps only).
- **Verification baseline** after code changes:
  `moon run root:format root:lint`, plus affected `moonx log:typecheck` and
  `moonx log:test`.
- **Scope:** the op log + the metadata-gating _seam_ only. NOT in scope: 3-way
  content merge, convergence over sealed metadata, repository-as-slice,
  persistence/network, vector clocks, symbol-level ops. In-memory, single
  process.
- **Branch:** work on a fresh `feat/pillar-03-operation-log` off `origin/main`.

---

## File Structure

**New package `@thaddeus.run/log`**

- Create `packages/log/package.json` — scope `@thaddeus.run/log`, deps
  `@noble/hashes`, `@thaddeus.run/identity`, `@thaddeus.run/store`.
- Create `packages/log/moon.yml`, `packages/log/tsconfig.json`,
  `packages/log/tsdown.config.ts` — copied from `packages/store` (the
  publishable-library preset).
- Create `packages/log/LICENSE.md`, `packages/log/README.md`.
- Create `packages/log/src/op.ts` — `Op`, `PublicOp`, `Conflict` types;
  `canonicalOp`, `opId`, `signOp`, `verifyOp`.
- Create `packages/log/src/oplog.ts` — the `OpLog` class (views, write/remove,
  append, materialize, conflicts, embargo).
- Create `packages/log/src/index.ts` — public exports.
- Create `packages/log/test/op.test.ts`, `packages/log/test/oplog.test.ts`.

**Demo + integration + docs**

- Create `examples/oplog/{package.json,moon.yml,tsconfig.json,src/oplog.ts}` —
  convergence + embargoed-op CLI.
- Modify `integration/test/one-edit-end-to-end.test.ts` — swap the P03
  `test.todo` for a real assertion.
- Modify `ARCHITECTURE.md` — `Op` row → `@thaddeus.run/log`; Pillar 03 row
  `planned → built`.
- Modify `CHANGELOG.md` — add the op log under `[Unreleased] → Added`; update
  the Deferred ledger.

---

### Task 1: Package scaffold `@thaddeus.run/log`

**Files:**

- Create: `packages/log/package.json`, `packages/log/moon.yml`,
  `packages/log/tsconfig.json`, `packages/log/tsdown.config.ts`,
  `packages/log/LICENSE.md`, `packages/log/README.md`,
  `packages/log/src/index.ts`

**Interfaces:**

- Produces: an empty, buildable package `@thaddeus.run/log` exporting nothing
  yet.

- [ ] **Step 1: Create the package manifest**

Create `packages/log/package.json`:

```json
{
  "name": "@thaddeus.run/log",
  "version": "0.0.0",
  "description": "An operation log — signed, CRDT-ordered operations on a DAG; snapshots are a derived projection, branches dissolve into zero-copy named views.",
  "keywords": ["crdt", "operation-log", "did", "strata", "substrate"],
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
    "directory": "packages/log"
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
    "prepublishOnly": "moon run log:prepublish"
  },
  "dependencies": {
    "@noble/hashes": "catalog:",
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/store": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "catalog:",
    "@typescript/native-preview": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:"
  }
}
```

- [ ] **Step 2: Copy the library presets**

Create `packages/log/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

language: 'typescript'
layer: 'library'
tags: ['tsdown', 'publishable']
```

Create `packages/log/tsconfig.json`:

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

Create `packages/log/tsdown.config.ts`:

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

Copy the license verbatim from the store package:

```bash
cp packages/store/LICENSE.md packages/log/LICENSE.md
```

Create `packages/log/README.md`:

```markdown
# @thaddeus.run/log

The operation log for **Strata** (working name) — Pillar 03.

Signed, CRDT-ordered `Op` records on a DAG. The log is the source of truth; file
snapshots are a derived projection (`materialize()`). Branches dissolve into
zero-copy named views. An embargoed op publishes only an opaque ordering token
to the public mirror; its metadata releases at a chosen time T via the
`@thaddeus.run/store` membrane.

> **Status: spike.** In-memory, single process. Content merge, convergence over
> sealed metadata, and symbol-level ops are deferred (see the design spec).
```

- [ ] **Step 3: Create the empty entrypoint**

Create `packages/log/src/index.ts`:

```ts
export {};
```

- [ ] **Step 4: Install and build**

Run: `bun install` Expected: completes; `@thaddeus.run/log` is linked.

Run: `AGENT=1 moonx log:build` Expected: builds clean (empty `dist`).

- [ ] **Step 5: Commit**

```bash
git add packages/log
git commit -m "feat(log): scaffold @thaddeus.run/log package"   # + standard trailers
```

---

### Task 2: The `Op` record — canonical bytes, id, sign, verify

**Files:**

- Create: `packages/log/src/op.ts`
- Modify: `packages/log/src/index.ts`
- Test: `packages/log/test/op.test.ts`

**Interfaces:**

- Produces:
  - `interface Op { id; path; parents; lamport; author; payload: Ref | null; sig }`
    (exact fields below).
  - `canonicalOp(fields): Uint8Array` — deterministic encoding over
    `(path, parents, lamport, author, payload)`; `parents` sorted so the id is
    stable regardless of head order.
  - `opId(fields): string` — `blake3` hex of the canonical bytes.
  - `signOp(fields, author: Identity): Op` — builds the full signed record.
  - `verifyOp(op: Op): boolean` — id integrity AND signature valid.

- [ ] **Step 1: Write the failing test**

Create `packages/log/test/op.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { signOp, verifyOp } from '../src/op';

beforeAll(async () => {
  await ready();
});

describe('Op record', () => {
  test('signOp produces a verifiable, id-bound record', () => {
    const author = Identity.create();
    const ref = { id: 'objid', plaintext_id: 'ptid' };
    const op = signOp(
      { path: 'a.ts', parents: [], lamport: 0, payload: ref },
      author
    );
    expect(op.author).toBe(author.did);
    expect(op.id.length).toBeGreaterThan(0);
    expect(verifyOp(op)).toBe(true);
  });

  test('tampering with any field breaks verification', () => {
    const author = Identity.create();
    const op = signOp(
      { path: 'a.ts', parents: [], lamport: 0, payload: null },
      author
    );
    expect(verifyOp({ ...op, path: 'b.ts' })).toBe(false);
    expect(verifyOp({ ...op, lamport: 1 })).toBe(false);
    expect(verifyOp({ ...op, id: `${op.id}0` })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/log && AGENT=1 bun test test/op.test.ts` Expected: FAIL —
cannot resolve `../src/op`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/log/src/op.ts`:

```ts
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { Identity, PublicIdentity } from '@thaddeus.run/identity';
import type { Ref } from '@thaddeus.run/store';

// A signed operation — the unit that replaces the commit. View-agnostic: an op
// is a DAG node, never stamped with a branch. Metadata (path, parents, lamport,
// author) is cleartext so any peer can order and merge it WITHOUT decryption;
// the payload is a capability-gated store Ref only grantees can read. A null
// payload is a delete tombstone.
export interface Op {
  readonly id: string;
  readonly path: string;
  readonly parents: readonly string[];
  readonly lamport: number;
  readonly author: string;
  readonly payload: Ref | null;
  readonly sig: Uint8Array;
}

// The signable fields, before id/sig are computed.
export interface OpFields {
  readonly path: string;
  readonly parents: readonly string[];
  readonly lamport: number;
  readonly payload: Ref | null;
}

// Deterministic bytes for id + signature. `parents` is sorted so the id does
// not depend on head-enumeration order; payload encodes as its Ref pair or null.
export function canonicalOp(fields: OpFields, author: string): Uint8Array {
  const payload =
    fields.payload === null
      ? null
      : [fields.payload.id, fields.payload.plaintext_id];
  return new TextEncoder().encode(
    JSON.stringify([
      fields.path,
      [...fields.parents].sort(),
      fields.lamport,
      author,
      payload,
    ])
  );
}

export function opId(fields: OpFields, author: string): string {
  return bytesToHex(blake3(canonicalOp(fields, author)));
}

// Build the full signed record. id = blake3(canonical); sig = author over the
// same canonical bytes, so id and signature bind the identical tuple.
export function signOp(fields: OpFields, author: Identity): Op {
  const bytes = canonicalOp(fields, author.did);
  return {
    id: bytesToHex(blake3(bytes)),
    path: fields.path,
    parents: fields.parents,
    lamport: fields.lamport,
    author: author.did,
    payload: fields.payload,
    sig: author.sign(bytes),
  };
}

// Valid iff the id matches the canonical bytes AND the signature verifies under
// the author's did:key. Either mismatch ⇒ false (no throw).
export function verifyOp(op: Op): boolean {
  const bytes = canonicalOp(op, op.author);
  if (bytesToHex(blake3(bytes)) !== op.id) {
    return false;
  }
  return PublicIdentity.fromDid(op.author).verify(bytes, op.sig);
}
```

Replace `packages/log/src/index.ts`:

```ts
export { canonicalOp, opId, signOp, verifyOp } from './op';
export type { Op, OpFields } from './op';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/log && AGENT=1 bun test test/op.test.ts` Expected: PASS — both
tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/log/src/op.ts packages/log/src/index.ts packages/log/test/op.test.ts
git commit -m "feat(log): signed Op record with id-bound canonical signature"   # + standard trailers
```

---

### Task 3: `OpLog` — write, ops(), Lamport clock

**Files:**

- Create: `packages/log/src/oplog.ts`
- Modify: `packages/log/src/index.ts`
- Test: `packages/log/test/oplog.test.ts`

**Interfaces:**

- Consumes: `signOp`, `verifyOp`, `Op` (Task 2); `Store`, `Ref` from
  `@thaddeus.run/store`.
- Produces:
  - `class OpLog { constructor(store: Store) }`
  - `write(view: string, path: string, bytes: Uint8Array, author: Identity): Promise<Op>`
    — `store.put`s the bytes, appends an op extending `view`'s heads, advances
    the view. Root op `lamport = 0`; else `1 + max(parents.lamport)`.
  - `ops(): readonly Op[]` — all ops in deterministic `(lamport, id)` order.
  - `heads(view?: string): readonly string[]` — a view's heads, or (no view) the
    global frontier (sink ops).

- [ ] **Step 1: Write the failing test**

Create `packages/log/test/oplog.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { OpLog } from '../src/oplog';
import { verifyOp } from '../src/op';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('OpLog write + clock', () => {
  test('write records a signed op; lamport starts at 0 then increments', async () => {
    const log = new OpLog(new MemoryStore());
    const author = Identity.create();

    const a = await log.write('main', 'a.ts', enc('one'), author);
    expect(verifyOp(a)).toBe(true);
    expect(a.parents).toEqual([]);
    expect(a.lamport).toBe(0);

    const b = await log.write('main', 'a.ts', enc('two'), author);
    expect(b.parents).toEqual([a.id]);
    expect(b.lamport).toBe(1);

    // ops() is sorted by (lamport, id): a (0) before b (1).
    expect(log.ops().map((o) => o.id)).toEqual([a.id, b.id]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/log && AGENT=1 bun test test/oplog.test.ts` Expected: FAIL —
cannot resolve `../src/oplog`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/log/src/oplog.ts`:

```ts
import type { Identity } from '@thaddeus.run/identity';
import type { Ref, Store } from '@thaddeus.run/store';

import { type Op, signOp } from './op';

// In-memory operation log. The source of truth is the signed-op DAG; file
// snapshots are derived by materialize(). Spike — not durable, not concurrency
// safe, single process.
export class OpLog {
  readonly #store: Store;
  readonly #ops: Map<string, Op> = new Map();
  readonly #views: Map<string, string[]> = new Map();

  constructor(store: Store) {
    this.#store = store;
  }

  // Record an edit: store the bytes as a capability-gated object, then append a
  // signed op extending `view`'s heads and advance the view to the new op.
  async write(
    view: string,
    path: string,
    bytes: Uint8Array,
    author: Identity
  ): Promise<Op> {
    const ref = await this.#store.put(bytes, author);
    return this.#appendLocal(view, path, ref, author);
  }

  // The shared builder for write/remove: compute lamport from the view's heads,
  // sign, store, advance the view.
  #appendLocal(
    view: string,
    path: string,
    payload: Ref | null,
    author: Identity
  ): Op {
    const parents = this.heads(view);
    const lamport = this.#nextLamport(parents);
    const op = signOp({ path, parents, lamport, payload }, author);
    this.#ops.set(op.id, op);
    this.#views.set(view, [op.id]);
    return op;
  }

  // Root op (no parents) is lamport 0; otherwise 1 + max(parents.lamport).
  #nextLamport(parents: readonly string[]): number {
    if (parents.length === 0) {
      return 0;
    }
    return (
      1 + Math.max(...parents.map((id) => this.#ops.get(id)?.lamport ?? 0))
    );
  }

  // A view's heads, or — with no view — the global frontier: every op that is
  // no other known op's parent (the DAG's sink nodes), deterministic given the
  // op set.
  heads(view?: string): readonly string[] {
    if (view !== undefined) {
      return this.#views.get(view) ?? [];
    }
    const parented = new Set<string>();
    for (const op of this.#ops.values()) {
      for (const p of op.parents) {
        parented.add(p);
      }
    }
    return [...this.#ops.keys()].filter((id) => !parented.has(id));
  }

  // All ops in a deterministic total order: by lamport, then id as a tiebreak.
  ops(): readonly Op[] {
    return [...this.#ops.values()].sort(
      (x, y) =>
        x.lamport - y.lamport || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
    );
  }
}
```

Add to `packages/log/src/index.ts`:

```ts
export { OpLog } from './oplog';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/log && AGENT=1 bun test test/oplog.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/log/src/oplog.ts packages/log/src/index.ts packages/log/test/oplog.test.ts
git commit -m "feat(log): OpLog.write with Lamport clock and deterministic ops()"   # + standard trailers
```

---

### Task 4: `materialize()` — cleartext-only LWW-per-path projection

**Files:**

- Modify: `packages/log/src/oplog.ts`
- Test: `packages/log/test/oplog.test.ts`

**Interfaces:**

- Consumes: `heads`, `ops`, `#ops` (Task 3).
- Produces:
  `materialize(view?: string): Map<string, { ref: Ref | null; op: Op }>` — walks
  the ancestor-closure of the view's heads (or the global frontier) in
  `(lamport, id)` order and applies last-writer-wins per path. Uses cleartext
  metadata ONLY — never decrypts; content is read separately via
  `store.get(ref, reader)`.

- [ ] **Step 1: Write the failing test**

Add to `packages/log/test/oplog.test.ts` (it already imports `MemoryStore`,
`Identity`, `OpLog`, `enc`):

```ts
describe('OpLog materialize (LWW per path, cleartext only)', () => {
  test('latest write per path wins; content reads back via the store', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();

    await log.write('main', 'a.ts', enc('a1'), author);
    await log.write('main', 'b.ts', enc('b1'), author);
    const a2 = await log.write('main', 'a.ts', enc('a2'), author);

    const tree = log.materialize('main');
    // Structure resolved from metadata alone — no decryption in materialize.
    expect([...tree.keys()].sort()).toEqual(['a.ts', 'b.ts']);
    expect(tree.get('a.ts')?.op.id).toBe(a2.id); // latest write wins

    // Content comes from a separate, capability-checked store.get.
    const ref = tree.get('a.ts')!.ref!;
    expect(new TextDecoder().decode(await store.get(ref, author))).toBe('a2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/log && AGENT=1 bun test test/oplog.test.ts -t 'LWW per path'`
Expected: FAIL — `log.materialize is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `packages/log/src/oplog.ts`, add these methods to `OpLog` (after `ops()`):

```ts
  // Project the log to a path → { ref, op } tree by LWW over the ancestor-
  // closure of the view's heads. Cleartext metadata only — the map holds Refs,
  // never plaintext, so it cannot leak a payload; read content via store.get.
  materialize(view?: string): Map<string, { ref: Ref | null; op: Op }> {
    const reachable = this.#ancestorClosure(this.heads(view));
    const ordered = this.ops().filter((o) => reachable.has(o.id));
    const tree = new Map<string, { ref: Ref | null; op: Op }>();
    for (const op of ordered) {
      if (op.payload === null) {
        tree.delete(op.path); // tombstone
      } else {
        tree.set(op.path, { ref: op.payload, op });
      }
    }
    return tree;
  }

  // Every op reachable from `heads` by walking parents (inclusive of heads).
  #ancestorClosure(heads: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...heads];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const op = this.#ops.get(id);
      if (op !== undefined) {
        stack.push(...op.parents);
      }
    }
    return seen;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/log && AGENT=1 bun test test/oplog.test.ts` Expected: PASS —
all OpLog tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/log/src/oplog.ts packages/log/test/oplog.test.ts
git commit -m "feat(log): materialize — cleartext LWW-per-path projection"   # + standard trailers
```

---

### Task 5: Named views — fork (zero-copy), view, and view-agnostic ops

**Files:**

- Modify: `packages/log/src/oplog.ts`
- Test: `packages/log/test/oplog.test.ts`

**Interfaces:**

- Produces:
  - `view(name: string, heads?: readonly string[]): void` — create or re-point a
    named view (no heads ⇒ empty).
  - `fork(name: string, fromView: string): void` — a new view whose heads start
    equal to `fromView`'s heads (copies a head-set, not ops).
  - Confirms an op is view-agnostic: the same op participates identically in any
    view whose heads reach it.

- [ ] **Step 1: Write the failing test**

Add to `packages/log/test/oplog.test.ts`:

```ts
describe('OpLog named views (branches dissolve)', () => {
  test('fork is zero-copy; views diverge; an op is shared across views', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();

    const base = await log.write('main', 'a.ts', enc('a1'), author);
    log.fork('feature', 'main'); // copies only the head-set
    expect(log.heads('feature')).toEqual([base.id]);

    // Advancing feature does not touch main.
    await log.write('feature', 'a.ts', enc('a2'), author);
    expect(log.heads('main')).toEqual([base.id]);

    // The base op is shared: both views materialize it at the same path,
    // and there is no `view` field on the op influencing the projection.
    expect('view' in base).toBe(false);
    expect(log.materialize('main').get('a.ts')?.op.id).toBe(base.id);
    expect(log.materialize('feature').get('a.ts')?.op.id).not.toBe(base.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`cd packages/log && AGENT=1 bun test test/oplog.test.ts -t 'branches dissolve'`
Expected: FAIL — `log.fork is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `packages/log/src/oplog.ts`, add to `OpLog` (after `heads`):

```ts
  // Create or re-point a named view. A view is just a name over a head-set —
  // not a copy of the tree.
  view(name: string, heads: readonly string[] = []): void {
    this.#views.set(name, [...heads]);
  }

  // Zero-copy branch: a new view whose heads start equal to fromView's heads.
  // Copies a handful of ids, never ops — so every agent can have its own view
  // for free (P6).
  fork(name: string, fromView: string): void {
    this.#views.set(name, [...this.heads(fromView)]);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/log && AGENT=1 bun test test/oplog.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/log/src/oplog.ts packages/log/test/oplog.test.ts
git commit -m "feat(log): zero-copy named views (fork/view)"   # + standard trailers
```

---

### Task 6: `append()` peer-ingest + CRDT order-independence

**Files:**

- Modify: `packages/log/src/oplog.ts`
- Test: `packages/log/test/oplog.test.ts`

**Interfaces:**

- Consumes: `verifyOp` (Task 2), `materialize` (Task 4).
- Produces: `append(op: Op): void` — ingest a signed op from a peer (verify,
  link into the DAG, idempotent on id; does not move any view). The CRDT
  property: ingesting the same op set in any order yields an identical
  `materialize()`.

- [ ] **Step 1: Write the failing test**

Add to `packages/log/test/oplog.test.ts`:

```ts
describe('OpLog append (convergence)', () => {
  test('order-independent: same ops in any ingest order → identical projection', async () => {
    const store = new MemoryStore();
    const author = Identity.create();

    // Author three ops in one log over the global frontier.
    const src = new OpLog(store);
    await src.write('main', 'a.ts', enc('a1'), author);
    await src.write('main', 'b.ts', enc('b1'), author);
    await src.write('main', 'a.ts', enc('a2'), author);
    const all = src.ops();

    const project = (log: OpLog): string[] =>
      [...log.materialize().entries()]
        .map(([path, { op }]) => `${path}=${op.id}`)
        .sort();

    // Ingest forwards and reversed into two fresh logs; projections must match.
    const fwd = new OpLog(store);
    for (const op of all) fwd.append(op);
    const rev = new OpLog(store);
    for (const op of [...all].reverse()) rev.append(op);

    expect(project(fwd)).toEqual(project(rev));
    expect(project(fwd)).toEqual(project(src));
  });

  test('append rejects an op whose signature does not verify', async () => {
    const log = new OpLog(store);
    const author = Identity.create();
    const op = await new OpLog(store).write('main', 'a.ts', enc('x'), author);
    expect(() => log.append({ ...op, path: 'tampered.ts' })).toThrow();
  });
});
```

Note: the second test references a `store` in the describe scope — add
`const store = new MemoryStore();` at the top of this `describe` block, before
the two tests, and have the first test use that shared `store` instead of its
own.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/log && AGENT=1 bun test test/oplog.test.ts -t 'convergence'`
Expected: FAIL — `log.append is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `packages/log/src/oplog.ts`, import `verifyOp` (extend the existing `./op`
import) and add `append`:

```ts
import { type Op, signOp, verifyOp } from './op';
```

```ts
  // Ingest a signed op from a peer — the convergence entry point. Verifies the
  // signature/id, links it into the DAG, idempotent on op id. Views are NOT
  // moved: peer ops land in the graph; a view advances only on write/re-point.
  append(op: Op): void {
    if (!verifyOp(op)) {
      throw new Error(`refusing unverifiable op ${op.id}`);
    }
    if (!this.#ops.has(op.id)) {
      this.#ops.set(op.id, op);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/log && AGENT=1 bun test test/oplog.test.ts` Expected: PASS —
convergence + rejection tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/log/src/oplog.ts packages/log/test/oplog.test.ts
git commit -m "feat(log): append peer ops; order-independent convergence"   # + standard trailers
```

---

### Task 7: `conflicts()` + delete tombstones (`remove`)

**Files:**

- Modify: `packages/log/src/oplog.ts`
- Test: `packages/log/test/oplog.test.ts`

**Interfaces:**

- Consumes: `#ancestorClosure`, `materialize` (Task 4); `#appendLocal` (Task 3).
- Produces:
  - `conflicts(view?: string): readonly Conflict[]` where
    `interface Conflict { path: string; ops: readonly string[]; winner: string }`
    — two ops on the same path that are concurrent (neither is the other's
    ancestor); `winner` is the `(lamport, id)` LWW winner.
  - `remove(view: string, path: string, author: Identity): Promise<Op>` —
    appends a `payload: null` tombstone op; `materialize` drops the path.

- [ ] **Step 1: Write the failing test**

Add to `packages/log/test/oplog.test.ts` (and export `Conflict` is verified by
the type import):

```ts
import type { Conflict } from '../src/oplog';

describe('OpLog conflicts + tombstones', () => {
  test('concurrent same-path writes are surfaced; LWW picks the winner', async () => {
    const store = new MemoryStore();
    const author = Identity.create();

    // Two independent logs author concurrent ops on the same path (both root,
    // no shared parent), then we converge them.
    const l1 = new OpLog(store);
    const x = await l1.write('main', 'a.ts', enc('x'), author);
    const l2 = new OpLog(store);
    const y = await l2.write('main', 'a.ts', enc('y'), author);

    const log = new OpLog(store);
    log.append(x);
    log.append(y);

    const c: readonly Conflict[] = log.conflicts();
    expect(c).toHaveLength(1);
    expect(c[0]!.path).toBe('a.ts');
    expect([...c[0]!.ops].sort()).toEqual([x.id, y.id].sort());
    // Deterministic winner = higher (lamport, id); both lamport 0 so max id.
    const expectedWinner = x.id > y.id ? x.id : y.id;
    expect(c[0]!.winner).toBe(expectedWinner);
    expect(log.materialize().get('a.ts')?.op.id).toBe(expectedWinner);
  });

  test('remove writes a tombstone that drops the path', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    await log.write('main', 'a.ts', enc('a1'), author);
    await log.remove('main', 'a.ts', author);
    expect(log.materialize('main').has('a.ts')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`cd packages/log && AGENT=1 bun test test/oplog.test.ts -t 'conflicts + tombstones'`
Expected: FAIL — `log.conflicts is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `packages/log/src/oplog.ts`, add the `Conflict` type (top of file, after
imports) and the methods:

```ts
// Two concurrent ops on the same path — neither is the other's ancestor. LWW
// still yields a deterministic winner; content merge is deferred (spec §11).
export interface Conflict {
  readonly path: string;
  readonly ops: readonly string[];
  readonly winner: string;
}
```

```ts
  // Record a delete: a payload:null tombstone op extending the view's heads.
  async remove(view: string, path: string, author: Identity): Promise<Op> {
    return this.#appendLocal(view, path, null, author);
  }

  // Surface same-path collisions among concurrent ops in a view's reachable set.
  // Two ops conflict when they share a path and neither is the other's ancestor.
  conflicts(view?: string): readonly Conflict[] {
    const reachable = this.#ancestorClosure(this.heads(view));
    const ordered = this.ops().filter((o) => reachable.has(o.id));
    const byPath = new Map<string, Op[]>();
    for (const op of ordered) {
      byPath.set(op.path, [...(byPath.get(op.path) ?? []), op]);
    }
    const out: Conflict[] = [];
    for (const [path, ops] of byPath) {
      const concurrent = ops.filter((a) =>
        ops.some((b) => a.id !== b.id && !this.#isAncestor(a.id, b.id))
      );
      if (concurrent.length > 1) {
        // The LWW winner is the last in (lamport, id) order — `ordered` already
        // sorts that way, so the max-index concurrent op wins.
        const winner = concurrent[concurrent.length - 1]!;
        out.push({ path, ops: concurrent.map((o) => o.id), winner: winner.id });
      }
    }
    return out;
  }

  // True if `ancestor` is in the ancestor-closure of `of` (or equal).
  #isAncestor(ancestor: string, of: string): boolean {
    return this.#ancestorClosure([of]).has(ancestor);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/log && AGENT=1 bun test test/oplog.test.ts` Expected: PASS.
Also export the type — add to `packages/log/src/index.ts`:

```ts
export type { Conflict } from './oplog';
```

- [ ] **Step 5: Commit**

```bash
git add packages/log/src/oplog.ts packages/log/src/index.ts packages/log/test/oplog.test.ts
git commit -m "feat(log): conflicts() concurrency detection + delete tombstones"   # + standard trailers
```

---

### Task 8: The embargo seam — opaque token, sealed metadata, timed reveal

**Files:**

- Modify: `packages/log/src/oplog.ts`
- Modify: `packages/log/src/index.ts`
- Test: `packages/log/test/oplog.test.ts`

**Interfaces:**

- Consumes: `store.put`, `store.scheduleReveal`, `store.reveal`, `store.caps`;
  `materialize` (Task 4).
- Produces:
  - `write(view, path, bytes, author, opts?: { embargoUntil?: string }): Promise<Op>`
    — gains the options bag. With `embargoUntil`, the op's metadata is sealed as
    a second store object and a reveal is scheduled.
  - `materialize(view?, as?: Identity)` — gains an optional reader. Without `as`
    (the public/mirror view) an embargoed-unrevealed op is _unplaced_; with `as`
    holding the metadata cap it is placed.
  - `publicView(opId: string): PublicOp` where
    `type PublicOp = { kind: 'open'; op: Op } | { kind: 'embargoed'; id: string; ordering_token: string; sealed_meta: Ref }`.
  - `reveal(opId: string, now?: string): Promise<boolean>` — fires the membrane
    key-release; after it, the op is placed by public `materialize`.

- [ ] **Step 1: Write the failing test**

Add to `packages/log/test/oplog.test.ts`:

```ts
import type { PublicOp } from '../src/oplog';

describe('OpLog embargo seam (P02 metadata-gating)', () => {
  const T = '2030-01-01T00:00:00.000Z';
  const beforeT = '2026-06-23T00:00:00.000Z';

  test('public sees only an opaque token; reveal at T places the op', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const maintainer = Identity.create();

    const op = await log.write('main', 'src/auth.ts', enc('fix'), maintainer, {
      embargoUntil: T,
    });

    // Public mirror view: opaque token only — no path/author/timing.
    const pv: PublicOp = log.publicView(op.id);
    expect(pv.kind).toBe('embargoed');
    if (pv.kind === 'embargoed') {
      expect(pv.ordering_token.length).toBeGreaterThan(0);
      expect(JSON.stringify(pv)).not.toContain('src/auth.ts');
    }

    // Public materialize (no reader) does NOT place the embargoed op...
    expect(log.materialize('main').has('src/auth.ts')).toBe(false);
    // ...but the maintainer, who holds the metadata cap, does see it placed.
    expect(log.materialize('main', maintainer).has('src/auth.ts')).toBe(true);

    // Before T the sealed metadata is unreadable by the public reveal trigger.
    expect(await log.reveal(op.id, beforeT)).toBe(false);
    expect(log.materialize('main').has('src/auth.ts')).toBe(false);

    // At T the key-release fires; the op lands publicly.
    expect(await log.reveal(op.id, T)).toBe(true);
    expect(log.publicView(op.id).kind).toBe('open');
    expect(log.materialize('main').get('src/auth.ts')?.op.id).toBe(op.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/log && AGENT=1 bun test test/oplog.test.ts -t 'embargo seam'`
Expected: FAIL — `write` rejects the 5th argument /
`log.publicView is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `packages/log/src/oplog.ts`:

(a) Add the `PublicOp` type (after `Conflict`):

```ts
// What a public mirror sees for an op. An embargoed op exposes only an opaque
// ordering token (enough to place it in sequence, naming nothing) plus a pointer
// to its capability-gated metadata, released at T via the membrane.
export type PublicOp =
  | { readonly kind: 'open'; readonly op: Op }
  | {
      readonly kind: 'embargoed';
      readonly id: string;
      readonly ordering_token: string;
      readonly sealed_meta: Ref;
    };
```

(b) Add the embargo registry field next to `#views`:

```ts
  readonly #embargo: Map<
    string,
    { metaRef: Ref; token: string; revealed: boolean }
  > = new Map();
```

(c) Add the `blake3`/`bytesToHex` imports at the top for the token:

```ts
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
```

(d) Replace `write` to accept the options bag and seal metadata when embargoed:

```ts
  async write(
    view: string,
    path: string,
    bytes: Uint8Array,
    author: Identity,
    opts?: { embargoUntil?: string }
  ): Promise<Op> {
    const ref = await this.#store.put(bytes, author);
    const op = this.#appendLocal(view, path, ref, author);
    if (opts?.embargoUntil !== undefined) {
      await this.#embargoOp(op, opts.embargoUntil, author);
    }
    return op;
  }

  // Seal an op's metadata as a second capability-gated object and schedule its
  // reveal at T. Only an opaque token + the sealed-meta pointer go public.
  async #embargoOp(op: Op, at: string, by: Identity): Promise<void> {
    const meta = new TextEncoder().encode(
      JSON.stringify({ ...op, sig: bytesToHex(op.sig) })
    );
    const metaRef = await this.#store.put(meta, by);
    await this.#store.scheduleReveal(metaRef, at, by);
    const token = bytesToHex(blake3(new TextEncoder().encode(`token:${op.id}`)));
    this.#embargo.set(op.id, { metaRef, token, revealed: false });
  }
```

(e) Update `materialize` to take an optional reader and gate embargoed ops:

```ts
  materialize(
    view?: string,
    as?: Identity
  ): Map<string, { ref: Ref | null; op: Op }> {
    const reachable = this.#ancestorClosure(this.heads(view));
    const ordered = this.ops().filter(
      (o) => reachable.has(o.id) && this.#placeable(o, as)
    );
    const tree = new Map<string, { ref: Ref | null; op: Op }>();
    for (const op of ordered) {
      if (op.payload === null) {
        tree.delete(op.path);
      } else {
        tree.set(op.path, { ref: op.payload, op });
      }
    }
    return tree;
  }

  // An op is placeable if it is not embargoed/unrevealed, or if `as` holds a
  // served capability for its sealed metadata (checked synchronously via caps).
  #placeable(op: Op, as?: Identity): boolean {
    const e = this.#embargo.get(op.id);
    if (e === undefined || e.revealed) {
      return true;
    }
    if (as === undefined) {
      return false;
    }
    return this.#store
      .caps(e.metaRef.plaintext_id)
      .some((c) => c.grantee === as.did);
  }
```

(f) Add `publicView` and `reveal`:

```ts
  // The mirror's view of an op: the full op once open, else an opaque token.
  publicView(opId: string): PublicOp {
    const op = this.#ops.get(opId);
    if (op === undefined) {
      throw new Error(`unknown op ${opId}`);
    }
    const e = this.#embargo.get(opId);
    if (e === undefined || e.revealed) {
      return { kind: 'open', op };
    }
    return {
      kind: 'embargoed',
      id: op.id,
      ordering_token: e.token,
      sealed_meta: e.metaRef,
    };
  }

  // Fire the membrane key-release for an embargoed op at/after T. Returns true
  // if the metadata was released — after which public materialize places the op.
  async reveal(opId: string, now?: string): Promise<boolean> {
    const e = this.#embargo.get(opId);
    if (e === undefined) {
      return false;
    }
    const released = await this.#store.reveal(e.metaRef, now);
    if (released) {
      e.revealed = true;
    }
    return released;
  }
```

(g) Export the type — add to `packages/log/src/index.ts`:

```ts
export type { PublicOp } from './oplog';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/log && AGENT=1 bun test test/oplog.test.ts` Expected: PASS —
all OpLog tests including the embargo seam.

Also confirm the package builds and typechecks: Run:
`AGENT=1 moonx log:typecheck log:build` Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/log/src/oplog.ts packages/log/src/index.ts packages/log/test/oplog.test.ts
git commit -m "feat(log): embargo seam — opaque token, sealed metadata, timed reveal"   # + standard trailers
```

---

### Task 9: Operation-log CLI demo

**Files:**

- Create: `examples/oplog/package.json`, `examples/oplog/moon.yml`,
  `examples/oplog/tsconfig.json`, `examples/oplog/src/oplog.ts`

**Interfaces:**

- Consumes: `OpLog` from `@thaddeus.run/log`; `MemoryStore`, `publicIdentity`
  from `@thaddeus.run/store`; `Identity`, `ready` from `@thaddeus.run/identity`.

- [ ] **Step 1: Create the package scaffold**

Create `examples/oplog/package.json`:

```json
{
  "name": "@thaddeus.run/example-oplog",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/log": "workspace:*",
    "@thaddeus.run/store": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "catalog:"
  }
}
```

Create `examples/oplog/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

language: 'typescript'
layer: 'application'

tasks:
  # No test suite yet; keep `moon run :test` green repo-wide.
  test:
    args: '--pass-with-no-tests'

  # Build-graph-connected, so CI-skipped; run in agent shells with a CI= prefix.
  demo:
    command: 'bun src/oplog.ts'
    deps:
      - '^:build'
    options:
      cache: false
      runInCI: 'skip'
```

Create `examples/oplog/tsconfig.json`:

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

- [ ] **Step 2: Write the demo script**

Create `examples/oplog/src/oplog.ts`:

```ts
// Operation-log demo for @thaddeus.run/log (Pillar 03).
// Run: CI= moon run oplog:demo
//
// Two acts: (1) convergence + zero-copy views; (2) an embargoed op whose public
// view is only an opaque ordering token until a scheduled reveal at T.

import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const rule = (): void => console.log('—'.repeat(60));

await ready();
const store = new MemoryStore();
const author = Identity.create();
const log = new OpLog(store);

// Act 1 — convergence + views.
const a = await log.write('main', 'a.ts', enc('a1'), author);
await log.write('main', 'b.ts', enc('b1'), author);
await log.write('main', 'a.ts', enc('a2'), author);
console.log('1. main materializes to:', [...log.materialize('main').keys()]);

log.fork('feature', 'main');
await log.write('feature', 'a.ts', enc('a3'), author);
console.log(
  '2. fork is zero-copy; main head still:',
  log.heads('main'),
  '(base',
  `${a.id.slice(0, 8)}…)`
);

// Order independence: replay the same ops reversed into a fresh log.
const replay = new OpLog(store);
for (const op of [...log.ops()].reverse()) replay.append(op);
const key = (l: OpLog): string =>
  [...l.materialize().entries()]
    .map(([p, { op }]) => `${p}=${op.id.slice(0, 6)}`)
    .sort()
    .join(',');
console.log('3. order-independent projection:', key(log) === key(replay));
rule();

// Act 2 — embargoed op.
const T = '2030-01-01T00:00:00.000Z';
const beforeT = '2026-06-23T00:00:00.000Z';
const fix = await log.write(
  'main',
  'src/auth.ts',
  enc('constant-time compare'),
  author,
  {
    embargoUntil: T,
  }
);
console.log(
  '4. public view of the fix:',
  JSON.stringify(log.publicView(fix.id))
);
console.log(
  '   public materialize places src/auth.ts?',
  log.materialize('main').has('src/auth.ts')
);
console.log('5. reveal before T:', await log.reveal(fix.id, beforeT));
console.log('   reveal at T:', await log.reveal(fix.id, T));
console.log(
  '   public materialize places src/auth.ts now?',
  log.materialize('main').has('src/auth.ts')
);
rule();
console.log(
  'the log is the truth · views are pointers · an embargoed op leaks only a token until T'
);
```

- [ ] **Step 3: Register the workspace package**

Run: `bun install` Expected: completes; `@thaddeus.run/example-oplog` is linked.

- [ ] **Step 4: Run the demo**

Run: `AGENT=1 CI= moon run oplog:demo` Expected: step 1 lists `a.ts,b.ts`; step
3 prints `true`; step 4 prints an `embargoed` public view with an
`ordering_token` and no `src/auth.ts`; step 5 prints `false` then `true`, and
the final placement check prints `true`.

- [ ] **Step 5: Commit**

```bash
git add examples/oplog
git commit -m "feat(examples): operation-log CLI demo (convergence + embargo)"   # + standard trailers
```

---

### Task 10: North-star integration swap (P03 stub → real)

**Files:**

- Modify: `integration/test/one-edit-end-to-end.test.ts` (the P03 `test.todo`
  ~line 40; keep the P04 todo)
- Modify: `integration/package.json` (add `@thaddeus.run/log` dep)

**Interfaces:**

- Consumes: `OpLog` from `@thaddeus.run/log`; `MemoryStore` (already imported);
  `Identity` (already imported).

- [ ] **Step 1: Add the log dependency to integration**

In `integration/package.json`, add to `dependencies` (alongside the existing
`@thaddeus.run/*` entries):

```json
    "@thaddeus.run/log": "workspace:*"
```

Run: `bun install` Expected: completes; integration resolves
`@thaddeus.run/log`.

- [ ] **Step 2: Update imports and replace the P03 todo**

In `integration/test/one-edit-end-to-end.test.ts`, add the log import near the
other imports:

```ts
import { OpLog } from '@thaddeus.run/log';
```

Replace these two lines (the P03 `// @ts-expect-error` comment and its
`test.todo`):

```ts
// @ts-expect-error bun-types@1.3.12 requires a fn arg, but the runtime supports label-only todo
test.todo('P03: the edit is recorded as a signed Op in the operation log');
```

with:

```ts
test('P03: the edit is recorded as a signed Op in the operation log', async () => {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const author = Identity.create();

  const op = await log.write(
    'main',
    'src/auth.rs',
    new TextEncoder().encode('fn refresh() {}'),
    author
  );

  // The edit is a signed op in the log, and materialize places it at its path
  // using cleartext metadata only.
  expect(op.author).toBe(author.did);
  const placed = log.materialize('main').get('src/auth.rs');
  expect(placed?.op.id).toBe(op.id);
  // Content reads back through the capability-checked store.
  expect(new TextDecoder().decode(await store.get(placed!.ref!, author))).toBe(
    'fn refresh() {}'
  );
});
```

Leave the P04 `// @ts-expect-error` + `test.todo` line unchanged.

- [ ] **Step 3: Run the integration test**

Run: `AGENT=1 moonx integration:test` Expected: PASS — `4 pass, 1 todo, 0 fail`
(was `3 pass, 2 todo` after P02).

- [ ] **Step 4: Commit**

```bash
git add integration/test/one-edit-end-to-end.test.ts integration/package.json
git commit -m "test(integration): north-star P03 operation log now runs for real"   # + standard trailers
```

---

### Task 11: Docs — flip status, changelog, ledger

**Files:**

- Modify: `ARCHITECTURE.md` (the `Op` shared-primitive row ~line 15; the Pillar
  03 row ~line 40)
- Modify: `CHANGELOG.md` (`[Unreleased] → Added`; the Deferred ledger)

**Interfaces:** none (docs only).

- [ ] **Step 1: Flip the Op primitive + Pillar 03 rows in ARCHITECTURE.md**

In `ARCHITECTURE.md`, replace the `Op` shared-primitive row:

```
| Op (operation log entry)              | _(planned)_              | P03 · P04 · P08 · P10                                   |
```

with:

```
| Op (operation log entry)              | `@thaddeus.run/log`      | P03 · P04 · P08 · P10                                   |
```

And replace the Pillar 03 status row:

```
| 03 Operation log                      | _(planned)_          | planned | P5 P6 P12        |
```

with:

```
| 03 Operation log                      | `log`                | built   | P5 P6 P12        |
```

- [ ] **Step 2: Add the op log to the changelog Added section**

In `CHANGELOG.md`, under `## [Unreleased] → ### Added`, append:

```
- `@thaddeus.run/log` — the operation log (Pillar 03): signed, CRDT-ordered
  `Op` records on a DAG; deterministic `(lamport, id)` ordering; `materialize`
  projects to a path→Ref tree by LWW per path using cleartext metadata only;
  zero-copy named views (`fork`/`view`); `append` peer-ingest converges
  order-independently; `conflicts` surfaces concurrent same-path ops; delete
  tombstones. Wires the **P02 metadata-gating seam**: an embargoed op publishes
  only an opaque ordering token; its metadata is sealed and released at T via
  the membrane.
```

- [ ] **Step 3: Update the Deferred ledger**

In `CHANGELOG.md`, under `### Scope-cut`, remove the now-shipped line:

```
- **P03 operation log** — signed, CRDT-ordered `Op` records (the source of
  truth).
```

Under the **Research** bucket, update the metadata-gating item to reflect the
seam shipping — replace:

```
- **Metadata-gating for embargoed changes (P02).** Sealing the payload is not
  enough: path, symbol, author, and timing leak the vulnerability. True gating
  publishes only an opaque, capability-gated ordering token until T. Blocked on
  P03's `Op` record, and on the core tension — fast CRDT convergence wants
  cleartext metadata, a real embargo wants it sealed (brief, Part VI frontier).
```

with:

```
- **Convergence over sealed metadata (P02/P03).** The metadata-gating *seam*
  shipped: an embargoed op publishes only an opaque ordering token and seals its
  metadata until T (`@thaddeus.run/log`). Still open: how peers who cannot read
  an embargoed op's metadata do content-aware placement during the embargo —
  fast CRDT convergence wants cleartext metadata, a real embargo wants it sealed
  (brief, Part VI frontier).
```

Add these new lines under `### Scope-cut` (deferred, no open unknowns):

```
- **P03 content merge** — 3-way text/content merge for concurrent same-path ops;
  today LWW picks a deterministic winner and `conflicts()` surfaces the rest.
- **Rename/move as a first-class op (P08)** — currently two unlinked path-ops.
- **Symbol-level addressing (P08)** — `Op.path` generalizes to a symbol id.
- **Repository-as-capability-scoped-slice (P05)** — the repo dissolution half of
  Pillar 03's "branches and the repository dissolve."
- **Vector/interval clocks** — Lamport + DAG suffice for the spike's ordering.
```

- [ ] **Step 4: Verify the full baseline**

Run:

```bash
AGENT=1 moon run root:format root:lint
AGENT=1 moonx log:test integration:test
AGENT=1 moonx log:typecheck integration:typecheck
```

Expected: format/lint clean; `log` tests green (op + oplog suites),
`integration: 4 pass 1 todo`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: mark Pillar 03 operation log built; changelog + ledger update"   # + standard trailers
```

---

## Self-Review

**1. Spec coverage** (spec §3 deliverables / §6 API / §7 data model / §10
acceptance / §12 docs):

- New package `@thaddeus.run/log` → Task 1. ✔
- `Op` record (id-bound canonical sig, `payload: Ref | null`) → Task 2. ✔
- `write` + Lamport (root 0; 1+max) + `ops()` deterministic order → Task 3
  (acceptance 1, 2, 9). ✔
- `materialize` cleartext-only LWW per path → Task 4 (acceptance 3). ✔
- Named views `view`/`fork`/`heads`, zero-copy, view-agnostic op → Task 5
  (acceptance 6, 11). ✔
- `append` peer-ingest, order-independent convergence → Task 6 (acceptance 4). ✔
- `conflicts()` + delete tombstone (`remove`) → Task 7 (acceptance 5, 12). ✔
- Embargo seam: `write({embargoUntil})`, `publicView` opaque token, `reveal`,
  `materialize(view, as)`, reveal→placement transition → Task 8 (acceptance 7,
  8, 10). ✔
- `examples/oplog/` demo → Task 9. ✔
- North-star P03 swap → Task 10 (acceptance 13). ✔
- `ARCHITECTURE.md` + `CHANGELOG.md` (Added + ledger: content-merge, rename,
  symbol, repo-slice, vector clocks, convergence-over-sealed-metadata) →
  Task 11. ✔

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows
full code; every command has expected output. ✔

**3. Type consistency:**

- `Op` fields (`id, path, parents, lamport, author, payload: Ref | null, sig`)
  are identical in Task 2's definition and every consumer. ✔
- `OpFields` (`path, parents, lamport, payload`) feeds
  `canonicalOp`/`opId`/`signOp` consistently; `canonicalOp(fields, author)` and
  `signOp(fields, author)` agree on the canonical tuple. ✔
- `materialize` return type `Map<string, { ref: Ref | null; op: Op }>` is
  identical in Tasks 4 and 8; the `as?: Identity` parameter is added in Task 8
  without changing the return type. ✔
- `Conflict` (`path, ops, winner`) defined in Task 7, exported, consumed in the
  same task's test. ✔
- `PublicOp` union (`open`/`embargoed`) defined and exported in Task 8, consumed
  in its test and the demo. ✔
- `heads(view?)`, `view(name, heads?)`, `fork(name, fromView)`, `append(op)`,
  `reveal(opId, now?)`, `publicView(opId)`, `remove(view, path, author)`,
  `write(view, path, bytes, author, opts?)` signatures match across definitions,
  tests, demo, and integration. ✔
- Store calls (`put`, `get`, `scheduleReveal`, `reveal`, `caps`) match the
  Global Constraints API block. ✔

> Note: Task 6's first test shares a `store` declared at the top of its
> `describe` (called out in the step). The `#isAncestor`/`#ancestorClosure`
> helpers are defined in Tasks 4/7 and reused by `conflicts`; `materialize` and
> `conflicts` both filter `ops()` by the reachable set so a view's projection
> and its conflict list always agree.
