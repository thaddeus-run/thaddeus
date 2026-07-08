# Persistence — Durable Store + OpLog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Thaddeus repo survive a process restart — a pluggable durable
`Backend` (filesystem + in-memory), an optional `backend` on `Store`/`OpLog`
(hot-cache write-through + static `open`/`load`, synchronous reads untouched),
and `Platform.createDurable`/`openDurable` — proven by a "commit → land →
discard → reopen → still there" test.

**Architecture:** Persistence is **additive**: `Store` and `OpLog` gain an
optional `Backend` (a tiny async key→bytes KV defined in `@thaddeus.run/store`).
With no backend they behave exactly as today. With one, every mutation
write-throughs to the backend and a static async loader rebuilds the in-memory
hot cache; all synchronous reads keep hitting the cache, so nothing goes async
upward (the code.store "in-memory writes, cold storage" split). A new
`@thaddeus.run/persist` package supplies `MemoryBackend`, `FileBackend`, and
`scoped`. `Platform` composes a scoped backend-backed `Store`+`OpLog` into a
`Repo`.

**Tech Stack:** TypeScript (ESM, `type: module`), Bun test runner, moon, tsdown.
`FileBackend` uses `node:fs/promises` only (no new deps). A generic JSON+base64
record codec lives in `store` (uses Bun/Node `Buffer`).

## Global Constraints

- **Spec:** `docs/specs/2026-06-25-thaddeus-persistence-design.md` is the source
  of truth.
- **Additive & opt-in (rigid).** A `Backend` is optional everywhere.
  `new MemoryStore()` and `new OpLog(store)` with no backend behave
  byte-for-byte as today — the existing suites are the regression guard. No
  existing public signature changes meaning (only new optional params / new
  methods).
- **Hot cache + write-through; sync reads stay sync (rigid).** Mutations
  (already `async`) do the in-memory update then `await backend.put(...)`.
  `caps`, `rawObject`, `current`, `verify`, `materialize`, `heads`, `conflicts`,
  `ops`, `view`, `fork`, `publicView` MUST remain synchronous.
- **Content-addressed = write-once; pointers = last-write-wins (rigid).** Keys:
  `obj/<id>`, `op/<id>` (write-once); `current/<plaintextId>`,
  `cap/<plaintextId>`, `pending/<plaintextId>`, `view/<name>`, `embargo/<id>`
  (pointers). On load, a content-addressed blob whose bytes don't hash to its id
  is **skipped** (torn- write safety). `FileBackend` writes via temp-file +
  atomic `rename`.
- **Freeze-on-store.** `EncryptedObject` and `Op` records are `Object.freeze`d
  when cached (on mutation) and when decoded on load. (Known caveat: freeze does
  not stop `Uint8Array` index writes; the decode-fresh wire path is the stronger
  guarantee.)
- **Load order.** `OpLog.load` runs AFTER `Store.open` over the same scope (ops
  reference content the store must already hold). `Platform.openDurable`
  enforces it.
- **`Backend` lives in `@thaddeus.run/store`** (the lowest package) and is
  re-exported; `@thaddeus.run/persist` implements it and depends on `store` for
  the type + `node:fs` only.
- **Deferred (do not build):** the server/network, a Git gateway, signed-record
  logs persistence (provenance/reputation/agent), SQLite/S3 backends,
  compaction/GC, multi-process concurrency/locking/WAL, throughput benchmarking.
- **Tooling:** `bun` only (never npm/pnpm/npx); `moon run <project>:<task>`;
  `AGENT=1` for tests; Conventional Commits 1.0.0; trailing newlines;
  `isolatedDeclarations: true`. No `Math.random`. `Date.now()` is allowed in
  package code (already used by `store`); tests stay deterministic by asserting
  structural facts.
- **Verification baseline after code changes:** `moon run root:format root:lint`
  plus the affected `moonx <project>:typecheck` and `moonx <project>:test`.

---

### Task 1: The `Backend` seam + the record codec + `@thaddeus.run/persist`

Add the `Backend` interface and a generic record codec to `@thaddeus.run/store`,
and scaffold `@thaddeus.run/persist` with `MemoryBackend`, `FileBackend`, and
`scoped`. No `Store`/`OpLog` changes yet.

**Files:**

- Create: `packages/store/src/backend.ts`
- Modify: `packages/store/src/index.ts` (export `Backend`, `encodeRecord`,
  `decodeRecord`)
- Test: `packages/store/test/codec.test.ts`
- Create: `packages/persist/package.json`, `moon.yml`, `tsconfig.json`,
  `tsdown.config.ts`, `README.md`, `LICENSE.md` (copy of
  `packages/log/LICENSE.md`)
- Create: `packages/persist/src/memory.ts`, `src/file.ts`, `src/scoped.ts`,
  `src/index.ts`
- Test: `packages/persist/test/backend.test.ts`

**Interfaces:**

- Produces:
  - `interface Backend { put(key: string, bytes: Uint8Array): Promise<void>; get(key: string): Promise<Uint8Array | undefined>; list(prefix: string): Promise<readonly string[]>; delete(key: string): Promise<void>; }`
  - `function encodeRecord(value: unknown): Uint8Array`
  - `function decodeRecord(bytes: Uint8Array): unknown`
  - `class MemoryBackend implements Backend`
  - `class FileBackend implements Backend` (`constructor(root: string)`)
  - `function scoped(backend: Backend, prefix: string): Backend`

- [ ] **Step 1: Write the failing codec test**

`packages/store/test/codec.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { decodeRecord, encodeRecord } from '../src/backend';

describe('record codec', () => {
  test('round-trips plain JSON values', () => {
    const v = { a: 1, b: ['x', 'y'], c: null };
    expect(decodeRecord(encodeRecord(v))).toEqual(v);
  });

  test('round-trips Uint8Array fields', () => {
    const v = { id: 'z', sig: new Uint8Array([0, 1, 254, 255]) };
    const out = decodeRecord(encodeRecord(v)) as typeof v;
    expect(out.id).toBe('z');
    expect(out.sig).toBeInstanceOf(Uint8Array);
    expect([...out.sig]).toEqual([0, 1, 254, 255]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`AGENT=1 moon run store:test`): cannot
      resolve `../src/backend`.

- [ ] **Step 3: Write `packages/store/src/backend.ts`**

```ts
// The durable cold tier: a namespaced key → bytes store. Implementations live
// in @thaddeus.run/persist (MemoryBackend, FileBackend). Keys are strings like
// `obj/<id>`, `op/<id>`, `view/<name>`. Async — used only behind already-async
// store/log mutations and the static loaders; synchronous reads never touch it.
export interface Backend {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  list(prefix: string): Promise<readonly string[]>;
  delete(key: string): Promise<void>;
}

// A versioned JSON record codec. Records carry Uint8Array fields (nonce,
// ciphertext, sig), so a plain Uint8Array is encoded as {"$u8": base64} and
// decoded back. Deterministic; a leading version field lets a future binary
// encoding supersede it behind the unchanged Backend.
export function encodeRecord(value: unknown): Uint8Array {
  const json = JSON.stringify({ v: 'tplv1', d: value }, (_k, v) =>
    v instanceof Uint8Array ? { $u8: Buffer.from(v).toString('base64') } : v
  );
  return new TextEncoder().encode(json);
}

export function decodeRecord(bytes: Uint8Array): unknown {
  const parsed = JSON.parse(new TextDecoder().decode(bytes), (_k, v) =>
    v !== null &&
    typeof v === 'object' &&
    typeof (v as { $u8?: unknown }).$u8 === 'string'
      ? new Uint8Array(Buffer.from((v as { $u8: string }).$u8, 'base64'))
      : v
  ) as { v: string; d: unknown };
  if (parsed.v !== 'tplv1') {
    throw new TypeError(`unknown record version: ${parsed.v}`);
  }
  return parsed.d;
}
```

> **`Buffer` note:** `Buffer` is a Bun/Node global available at runtime and
> typed via `@types/bun` (already in this package's `types`). If a typecheck
> flags it, it's a toolchain types issue, not a logic one — do not swap to a
> hand-rolled base64; the global is present under Bun.

- [ ] **Step 4: Export from `packages/store/src/index.ts`** — add:

```ts
export type { Backend } from './backend';
export { decodeRecord, encodeRecord } from './backend';
```

- [ ] **Step 5: Run the codec test — expect PASS**
      (`AGENT=1 moon run store:test`).

- [ ] **Step 6: Scaffold the persist package config**

`packages/persist/package.json`:

```json
{
  "name": "@thaddeus.run/persist",
  "version": "0.0.0",
  "description": "Durable backends for the Thaddeus substrate: a pluggable key→bytes Backend with filesystem and in-memory implementations (the code.store cold tier).",
  "keywords": ["persistence", "storage", "backend", "Thaddeus", "substrate"],
  "homepage": "https://thaddeus.run",
  "bugs": { "url": "https://github.com/thaddeus-run/thaddeus/issues" },
  "license": "Apache-2.0",
  "author": { "name": "thaddeus.run", "url": "https://thaddeus.run" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/thaddeus-run/thaddeus.git",
    "directory": "packages/persist"
  },
  "files": ["dist", "LICENSE.md", "README.md"],
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "publishConfig": { "access": "public" },
  "scripts": { "prepublishOnly": "moon run persist:prepublish" },
  "devDependencies": {
    "@thaddeus.run/store": "workspace:*",
    "@types/bun": "catalog:",
    "@typescript/native-preview": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:"
  }
}
```

> **Dependency note:** `@thaddeus.run/store` is a **devDependency** — `persist`
> only needs the `Backend` **type** (`implements Backend`); at runtime it uses
> `node:fs` and `Map` only, no `store` value.

`packages/persist/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

language: 'typescript'
layer: 'library'
tags: ['tsdown', 'publishable']
```

`packages/persist/tsconfig.json`:

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

`packages/persist/tsdown.config.ts`:

```ts
import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig([
  {
    entry: ['src/**/*.ts'],
    tsconfig: './tsconfig.json',
    clean: true,
    dts: { sourcemap: true, tsgo: true },
    unbundle: true,
    platform: 'neutral',
  },
]);

export default config;
```

`packages/persist/README.md`:

```markdown
# @thaddeus.run/persist

Durable backends for **Thaddeus** (working name) — the cold tier behind the
in-memory hot cache.

A `Backend` is a tiny async key→bytes store (`@thaddeus.run/store`).
`FileBackend` writes each key to a percent-encoded file (atomic temp+rename);
`MemoryBackend` is a `Map` for fast deterministic tests;
`scoped(backend, prefix)` namespaces a backend so one store can hold many repos.
Give one to a `Store`/`OpLog` (or `Platform.createDurable`/`openDurable`) and a
repo survives a restart.

> **Status: spike.** Single process, durable not concurrent. No SQLite/S3
> backend, no compaction, no server (see the persistence design spec).
```

- [ ] **Step 7: Copy the license** —
      `cp packages/log/LICENSE.md packages/persist/LICENSE.md`

- [ ] **Step 8: Write the failing backend test**

`packages/persist/test/backend.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { FileBackend } from '../src/file';
import { MemoryBackend } from '../src/memory';
import { scoped } from '../src/scoped';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-persist-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

for (const [name, make] of [
  ['MemoryBackend', () => new MemoryBackend()],
  ['FileBackend', () => new FileBackend(mkdtempSync(join(tmp, 'b-')))],
] as const) {
  describe(`${name} — Backend contract`, () => {
    test('put/get round-trips; absent get is undefined; delete is idempotent', async () => {
      const b = make();
      expect(await b.get('obj/x')).toBeUndefined();
      await b.put('obj/x', enc('hello'));
      expect(dec((await b.get('obj/x'))!)).toBe('hello');
      await b.delete('obj/x');
      expect(await b.get('obj/x')).toBeUndefined();
      await b.delete('obj/x'); // no throw
    });

    test('list returns keys under a prefix; keys with slashes round-trip', async () => {
      const b = make();
      await b.put('view/main', enc('m'));
      await b.put('view/ws/main/0', enc('w'));
      await b.put('op/abc', enc('o'));
      expect([...(await b.list('view/'))].sort()).toEqual([
        'view/main',
        'view/ws/main/0',
      ]);
      expect(dec((await b.get('view/ws/main/0'))!)).toBe('w');
    });

    test('put overwrites an existing key', async () => {
      const b = make();
      await b.put('current/p', enc('a'));
      await b.put('current/p', enc('b'));
      expect(dec((await b.get('current/p'))!)).toBe('b');
    });
  });
}

describe('scoped', () => {
  test('prefixes keys and isolates namespaces', async () => {
    const base = new MemoryBackend();
    const a = scoped(base, 'repo/a/');
    const b = scoped(base, 'repo/b/');
    await a.put('view/main', enc('A'));
    await b.put('view/main', enc('B'));
    expect(dec((await a.get('view/main'))!)).toBe('A');
    expect(dec((await b.get('view/main'))!)).toBe('B');
    expect([...(await a.list('view/'))]).toEqual(['view/main']);
  });
});
```

- [ ] **Step 9: Run it — expect FAIL** (`bun install` first so the symlink
      resolves; then `AGENT=1 moon run persist:test`): cannot resolve
      `../src/*`.

- [ ] **Step 10: Write the backends**

`packages/persist/src/memory.ts`:

```ts
import type { Backend } from '@thaddeus.run/store';

// In-memory backend for fast, deterministic tests. Copies bytes in and out so a
// caller cannot mutate stored blobs through a held reference.
export class MemoryBackend implements Backend {
  readonly #map: Map<string, Uint8Array> = new Map();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.#map.set(key, new Uint8Array(bytes));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const v = this.#map.get(key);
    return v === undefined ? undefined : new Uint8Array(v);
  }

  async list(prefix: string): Promise<readonly string[]> {
    return [...this.#map.keys()].filter((k) => k.startsWith(prefix));
  }

  async delete(key: string): Promise<void> {
    this.#map.delete(key);
  }
}
```

`packages/persist/src/file.ts`:

```ts
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import type { Backend } from '@thaddeus.run/store';

// Filesystem backend: each key → one percent-encoded file under `root`. Writes
// are temp-file + atomic rename, so a crash never yields a half-written file.
// Zero dependencies beyond node:fs. Flat directory (dir sharding is a later
// optimization); keys never contain a literal '%' collision because encodeKey is
// a bijection.
export class FileBackend implements Backend {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const path = this.#path(key);
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.#path(key)));
    } catch {
      return undefined; // ENOENT (and any read error) → absent
    }
  }

  async list(prefix: string): Promise<readonly string[]> {
    let names: string[];
    try {
      names = await readdir(this.#root);
    } catch {
      return [];
    }
    return names
      .filter((n) => !n.includes('.tmp-'))
      .map(decodeKey)
      .filter((k) => k.startsWith(prefix));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.#path(key));
    } catch {
      // already absent — idempotent
    }
  }

  #path(key: string): string {
    return join(this.#root, encodeKey(key));
  }
}

// Encode an arbitrary key into one safe, flat filename (percent-encode every
// char that isn't filename-safe, including '/'). Bijective, so decodeKey
// recovers the original key exactly.
function encodeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, (c) => {
    const hex = c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    return `%${hex}`;
  });
}

function decodeKey(name: string): string {
  return name.replace(/%([0-9A-F]{2})/g, (_m, h: string) =>
    String.fromCharCode(Number.parseInt(h, 16))
  );
}
```

`packages/persist/src/scoped.ts`:

```ts
import type { Backend } from '@thaddeus.run/store';

// Namespace a backend so one store can hold many repos: every key is prefixed on
// the way in and stripped on the way out. `list(prefix)` lists within the scope.
export function scoped(backend: Backend, prefix: string): Backend {
  return {
    put: (key, bytes) => backend.put(prefix + key, bytes),
    get: (key) => backend.get(prefix + key),
    delete: (key) => backend.delete(prefix + key),
    list: async (p) =>
      (await backend.list(prefix + p)).map((k) => k.slice(prefix.length)),
  };
}
```

`packages/persist/src/index.ts`:

```ts
export { FileBackend } from './file';
export { MemoryBackend } from './memory';
export { scoped } from './scoped';
```

- [ ] **Step 11: Run the backend test — expect PASS**
      (`AGENT=1 moon run persist:test`).

- [ ] **Step 12: Typecheck + build both** —
      `moon run store:typecheck store:build persist:typecheck persist:build`
      Expected: succeed.

- [ ] **Step 13: Commit**

```bash
git add packages/store packages/persist bun.lock
git commit -m "feat(persist): the durable Backend seam + memory/file backends

Add the Backend interface + a versioned JSON+base64 record codec to
@thaddeus.run/store, and a new @thaddeus.run/persist with MemoryBackend,
FileBackend (atomic temp+rename, percent-encoded keys), and scoped(). The
cold tier behind the in-memory hot cache; no Store/OpLog changes yet.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 2: `Store` durable mode — optional backend, write-through, `open`, freeze

Give `MemoryStore` an optional `Backend`: write-through on every mutation, a
static async `open(backend)` that rebuilds the hot cache, and freeze-on-store.
No backend ⇒ unchanged.

**Files:**

- Modify: `packages/store/src/store.ts`
- Test: `packages/store/test/durable-store.test.ts`

**Interfaces:**

- Consumes: `Backend`, `encodeRecord`, `decodeRecord` from `./backend`.
- Produces: `new MemoryStore(backend?: Backend)`;
  `static MemoryStore.open(backend: Backend): Promise<MemoryStore>`.

- [ ] **Step 1: Write the failing test**

`packages/store/test/durable-store.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import type { Backend } from '../src/backend';
import { MemoryStore } from '../src/store';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// A minimal in-test backend (avoids depending on @thaddeus.run/persist here).
function memoryBackend(): Backend {
  const m = new Map<string, Uint8Array>();
  return {
    put: async (k, b) => void m.set(k, new Uint8Array(b)),
    get: async (k) => {
      const v = m.get(k);
      return v === undefined ? undefined : new Uint8Array(v);
    },
    list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
    delete: async (k) => void m.delete(k),
  };
}

describe('MemoryStore — durable mode', () => {
  test('write-through then reopen: objects + a grant survive', async () => {
    const backend = memoryBackend();
    const owner = Identity.create();
    const reader = Identity.create();

    const a = new MemoryStore(backend);
    const ref = await a.put(enc('fn refresh() {}'), owner);
    await a.grant(ref, reader.toPublic(), owner);

    // Discard `a`; rebuild purely from the backend.
    const b = await MemoryStore.open(backend);
    expect(dec(await b.get(ref, owner))).toBe('fn refresh() {}');
    expect(dec(await b.get(ref, reader))).toBe('fn refresh() {}'); // grant survived
    expect(b.verify(ref.id)).toBe(true);
  });

  test('a cached object is frozen (freeze-on-store)', async () => {
    const backend = memoryBackend();
    const owner = Identity.create();
    const a = new MemoryStore(backend);
    const ref = await a.put(enc('x'), owner);
    expect(Object.isFrozen(a.rawObject(ref.id))).toBe(true);
    const b = await MemoryStore.open(backend);
    expect(Object.isFrozen(b.rawObject(ref.id))).toBe(true);
  });

  test('a torn object blob (id mismatch) is skipped on load', async () => {
    const backend = memoryBackend();
    const owner = Identity.create();
    const a = new MemoryStore(backend);
    const ref = await a.put(enc('x'), owner);
    // Corrupt the stored blob under its key (simulate a torn write).
    await backend.put(
      `obj/${ref.id}`,
      enc(
        '{"v":"tplv1","d":{"id":"' +
          ref.id +
          '","plaintext_id":"' +
          ref.plaintext_id +
          '","alg":"x","nonce":{"$u8":""},"ciphertext":{"$u8":""}}}'
      )
    );
    const b = await MemoryStore.open(backend);
    expect(b.rawObject(ref.id)).toBeUndefined(); // skipped, not trusted
  });

  test('no backend ⇒ unchanged behavior', async () => {
    const owner = Identity.create();
    const s = new MemoryStore();
    const ref = await s.put(enc('y'), owner);
    expect(dec(await s.get(ref, owner))).toBe('y');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`AGENT=1 moon run store:test`):
      `MemoryStore.open is not a function` / constructor ignores backend.

- [ ] **Step 3: Edit `packages/store/src/store.ts`**

Add the import (top, after the existing imports):

```ts
import { type Backend, decodeRecord, encodeRecord } from './backend';
```

Add the field + constructor + load to the `MemoryStore` class (place the field
beside the other `#` fields, and the constructor/`open` right after them):

```ts
  readonly #backend: Backend | undefined;

  constructor(backend?: Backend) {
    this.#backend = backend;
  }

  // Rebuild a hot cache from a backend. A content-addressed object whose bytes
  // don't hash to its id is skipped (torn-write safety). Frozen on load.
  static async open(backend: Backend): Promise<MemoryStore> {
    const store = new MemoryStore(backend);
    for (const key of await backend.list('obj/')) {
      const bytes = await backend.get(key);
      if (bytes === undefined) {
        continue;
      }
      const o = decodeRecord(bytes) as EncryptedObject;
      if (address(o.ciphertext) !== o.id) {
        continue; // torn or tampered — never surface as truth
      }
      store.#objects.set(o.id, Object.freeze(o));
    }
    for (const key of await backend.list('current/')) {
      const bytes = await backend.get(key);
      if (bytes !== undefined) {
        store.#current.set(key.slice('current/'.length), decodeRecord(bytes) as string);
      }
    }
    for (const key of await backend.list('cap/')) {
      const bytes = await backend.get(key);
      if (bytes !== undefined) {
        store.#caps.set(key.slice('cap/'.length), decodeRecord(bytes) as Capability[]);
      }
    }
    for (const key of await backend.list('pending/')) {
      const bytes = await backend.get(key);
      if (bytes !== undefined) {
        store.#pending.set(key.slice('pending/'.length), decodeRecord(bytes) as Capability[]);
      }
    }
    return store;
  }

  // Write-through helper: no-op without a backend.
  async #persist(key: string, value: unknown): Promise<void> {
    if (this.#backend !== undefined) {
      await this.#backend.put(key, encodeRecord(value));
    }
  }
```

Now thread write-through + freeze into the mutations. Replace each method body
as shown.

`put` — freeze the object, persist obj/current/cap:

```ts
  async put(plaintext: Uint8Array, owner: Identity): Promise<Ref> {
    const contentKey = newContentKey();
    const object = Object.freeze(encrypt(plaintext, contentKey));
    this.#objects.set(object.id, object);
    this.#current.set(object.plaintext_id, object.id);
    this.#caps.set(object.plaintext_id, [
      issueCapability({
        object: object.plaintext_id,
        contentKey,
        grantee: owner.toPublic(),
        grantedBy: owner,
      }),
    ]);
    await this.#persist(`obj/${object.id}`, object);
    await this.#persist(`current/${object.plaintext_id}`, object.id);
    await this.#persist(`cap/${object.plaintext_id}`, this.#caps.get(object.plaintext_id));
    return { id: object.id, plaintext_id: object.plaintext_id };
  }
```

`get` — persist if a due reveal was released by the read:

```ts
  async get(ref: Ref, reader: Identity, now?: string): Promise<Uint8Array> {
    const nowMs = this.#resolveNow(now);
    if (this.#releaseDue(ref.plaintext_id, nowMs)) {
      await this.#persist(`cap/${ref.plaintext_id}`, this.#caps.get(ref.plaintext_id) ?? []);
      await this.#persist(`pending/${ref.plaintext_id}`, this.#pending.get(ref.plaintext_id) ?? []);
    }
    return decrypt(
      this.#currentObject(ref.plaintext_id),
      this.#contentKeyVia(ref.plaintext_id, reader, nowMs)
    );
  }
```

`grant` — persist caps:

```ts
  async grant(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void> {
    const contentKey = this.#contentKeyVia(ref.plaintext_id, by, Date.now());
    const caps = this.#caps.get(ref.plaintext_id) ?? [];
    caps.push(
      issueCapability({ object: ref.plaintext_id, contentKey, grantee, grantedBy: by })
    );
    this.#caps.set(ref.plaintext_id, caps);
    await this.#persist(`cap/${ref.plaintext_id}`, caps);
  }
```

`revoke` — freeze rotated object, persist obj/current/cap/pending (append the
four `#persist` lines at the end of the existing method, and freeze `rotated`):

```ts
const newKey = newContentKey();
const rotated = Object.freeze(encrypt(plaintext, newKey));
this.#objects.set(rotated.id, rotated);
this.#current.set(ref.plaintext_id, rotated.id);
```

...and at the very end of `revoke`, after the two
`this.#pending.set`/`this.#caps.set` calls:

```ts
await this.#persist(`obj/${rotated.id}`, rotated);
await this.#persist(`current/${ref.plaintext_id}`, rotated.id);
await this.#persist(
  `cap/${ref.plaintext_id}`,
  this.#caps.get(ref.plaintext_id) ?? []
);
await this.#persist(
  `pending/${ref.plaintext_id}`,
  this.#pending.get(ref.plaintext_id) ?? []
);
```

`scheduleReveal` — persist pending (append at the end):

```ts
await this.#persist(
  `pending/${ref.plaintext_id}`,
  this.#pending.get(ref.plaintext_id) ?? []
);
```

`reveal` — persist when released:

```ts
  async reveal(ref: Ref, now?: string): Promise<boolean> {
    const nowMs = this.#resolveNow(now);
    const released = this.#releaseDue(ref.plaintext_id, nowMs);
    if (released) {
      await this.#persist(`cap/${ref.plaintext_id}`, this.#caps.get(ref.plaintext_id) ?? []);
      await this.#persist(`pending/${ref.plaintext_id}`, this.#pending.get(ref.plaintext_id) ?? []);
    }
    return released;
  }
```

> **Note:** the class doc comment says "Spike — not durable". Update it to:
> "In-memory hot cache; durable when constructed with a `Backend` (write-through
>
> - `MemoryStore.open`). Spike — single process, not concurrency-safe."

- [ ] **Step 4: Run the test — expect PASS** (`AGENT=1 moon run store:test`):
      durable + codec + existing store tests all green.

- [ ] **Step 5: Typecheck + build** — `moon run store:typecheck store:build`.

- [ ] **Step 6: Commit**

```bash
git add packages/store
git commit -m "feat(store): optional durable backend (write-through + open + freeze)

MemoryStore takes an optional Backend: every mutation write-throughs
(obj/current/cap/pending), MemoryStore.open(backend) rebuilds the hot
cache (skipping torn content-addressed blobs), and cached objects are
frozen. No backend ⇒ byte-for-byte today's behavior. Sync reads unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 3: `OpLog` durable mode — optional backend, write-through, `repoint`, `load`

Give `OpLog` an optional `Backend`: write-through on `write`/`remove`/`append`,
a new async `repoint(name, heads)` for durable view re-points (sync `view` stays
for throwaway/seed), a static async `load(store, backend)`, and freeze-on-store.
No backend ⇒ unchanged.

**Files:**

- Modify: `packages/log/src/oplog.ts`
- Modify: `packages/log/package.json` (add `@thaddeus.run/store` is already a
  dep? — it imports `Store`/`Ref` types today; keep as-is, just add `Backend`,
  `encodeRecord`, `decodeRecord` to the existing `@thaddeus.run/store` import)
- Test: `packages/log/test/durable-log.test.ts`

**Interfaces:**

- Consumes: `Backend`, `encodeRecord`, `decodeRecord`, `Store` from
  `@thaddeus.run/store`.
- Produces: `new OpLog(store, backend?)`; `repoint(name, heads): Promise<void>`;
  `static OpLog.load(store: Store, backend: Backend): Promise<OpLog>`.

- [ ] **Step 1: Write the failing test**

`packages/log/test/durable-log.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import type { Backend } from '@thaddeus.run/store';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { OpLog } from '../src/oplog';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function memoryBackend(): Backend {
  const m = new Map<string, Uint8Array>();
  return {
    put: async (k, b) => void m.set(k, new Uint8Array(b)),
    get: async (k) => {
      const v = m.get(k);
      return v === undefined ? undefined : new Uint8Array(v);
    },
    list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
    delete: async (k) => void m.delete(k),
  };
}

describe('OpLog — durable mode', () => {
  test('write-through then reload: ops + views survive', async () => {
    const backend = memoryBackend();
    const author = Identity.create();

    const store = new MemoryStore(backend);
    const log = new OpLog(store, backend);
    const op = await log.write('main', 'src/a.rs', enc('fn a() {}'), author);

    // Discard log+store; rebuild from the backend (store first, then log).
    const store2 = await MemoryStore.open(backend);
    const log2 = await OpLog.load(store2, backend);
    expect(log2.heads('main')).toEqual([op.id]);
    expect(log2.materialize('main').get('src/a.rs')?.op.id).toBe(op.id);
    expect(log2.verify(op.id)).toBe(true);
  });

  test('repoint persists a shared view re-point', async () => {
    const backend = memoryBackend();
    const author = Identity.create();
    const store = new MemoryStore(backend);
    const log = new OpLog(store, backend);
    const op = await log.write('feature', 'x.rs', enc('x'), author);
    await log.repoint('main', [op.id]);

    const log2 = await OpLog.load(await MemoryStore.open(backend), backend);
    expect(log2.heads('main')).toEqual([op.id]);
  });

  test('no backend ⇒ unchanged behavior', async () => {
    const author = Identity.create();
    const log = new OpLog(new MemoryStore());
    const op = await log.write('main', 'a', enc('a'), author);
    expect(log.heads('main')).toEqual([op.id]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`AGENT=1 moon run log:test`):
      `OpLog.load is not a function` / `repoint` missing.

- [ ] **Step 3: Edit `packages/log/src/oplog.ts`**

Extend the `@thaddeus.run/store` import to include the new names:

```ts
import {
  type Backend,
  decodeRecord,
  encodeRecord,
  type Ref,
  type Store,
} from '@thaddeus.run/store';
```

Add a backend field + constructor (replace the existing `constructor(store)`),
keeping `#store` as-is:

```ts
  readonly #backend: Backend | undefined;

  constructor(store: Store, backend?: Backend) {
    this.#store = store;
    this.#backend = backend;
  }

  // Rebuild the op-DAG + views + embargo from a backend. Call AFTER
  // MemoryStore.open over the same scope (ops reference content the store holds).
  static async load(store: Store, backend: Backend): Promise<OpLog> {
    const log = new OpLog(store, backend);
    for (const key of await backend.list('op/')) {
      const bytes = await backend.get(key);
      if (bytes === undefined) {
        continue;
      }
      const op = decodeRecord(bytes) as Op;
      if (!verifyOp(op)) {
        continue; // torn or tampered — never surface as truth
      }
      log.#ops.set(op.id, Object.freeze(op));
    }
    for (const key of await backend.list('view/')) {
      const bytes = await backend.get(key);
      if (bytes !== undefined) {
        log.#views.set(key.slice('view/'.length), decodeRecord(bytes) as string[]);
      }
    }
    for (const key of await backend.list('embargo/')) {
      const bytes = await backend.get(key);
      if (bytes !== undefined) {
        log.#embargo.set(
          key.slice('embargo/'.length),
          decodeRecord(bytes) as { metaRef: Ref; token: string; revealed: boolean }
        );
      }
    }
    return log;
  }

  // Durable view re-point: in-memory set + write-through. Use this (not view())
  // for re-points that must survive a restart (e.g. landing onto `main`).
  // Without a backend it is exactly view().
  async repoint(name: string, heads: readonly string[]): Promise<void> {
    this.#views.set(name, [...heads]);
    if (this.#backend !== undefined) {
      await this.#backend.put(`view/${name}`, encodeRecord([...heads]));
    }
  }

  // Write-through for an op + its view (no-op without a backend).
  async #persistCommit(view: string, op: Op): Promise<void> {
    if (this.#backend !== undefined) {
      await this.#backend.put(`op/${op.id}`, encodeRecord(op));
      await this.#backend.put(`view/${view}`, encodeRecord(this.#views.get(view) ?? []));
    }
  }
```

Freeze ops on commit: in `#commit`, change `this.#ops.set(op.id, op)` to
`this.#ops.set(op.id, Object.freeze(op))`. (This is sync and applies to both
in-memory and durable; freezing a fresh signed op is safe.)

Thread write-through into the async public mutations:

`write` — after `this.#commit(view, op)`:

```ts
this.#commit(view, op);
await this.#persistCommit(view, op);
return op;
```

`remove` — it delegates to `#appendLocal` (sync). Change `remove` to persist:

```ts
  async remove(view: string, path: string, author: Identity): Promise<Op> {
    const op = this.#appendLocal(view, path, null, author);
    await this.#persistCommit(view, op);
    return op;
  }
```

`append` (peer ingest) — persist the op (no view advance). It is currently sync;
make it async-persist while keeping it callable as before (callers `await` it or
ignore the promise — but to stay safe, keep its return type `void` and fire the
persist). To preserve the synchronous in-memory contract AND persist, keep
`append` synchronous for the in-memory set and add a separate awaited persist in
the durable callers is overkill here; instead make `append` return
`Promise<void>` only when needed. **Decision for this spike:** leave `append`
synchronous and in-memory only (peer ingest is not exercised by the durable
north-star); document that durably persisting peer-ingested ops is deferred with
federation (the wire that delivers them isn't built). Add a one-line comment on
`append`:

```ts
  // NOTE: append (peer ingest) is in-memory only; durably persisting
  // peer-delivered ops lands with the federation wire (deferred). Local writes
  // (write/remove) and re-points (repoint) are the persisted paths.
  append(op: Op): void {
```

`#embargoOp` — persist the embargo entry. After
`this.#embargo.set(op.id, {...})`:

```ts
this.#embargo.set(op.id, { metaRef, token, revealed: false });
if (this.#backend !== undefined) {
  await this.#backend.put(
    `embargo/${op.id}`,
    encodeRecord({ metaRef, token, revealed: false })
  );
}
```

`reveal` — persist the updated embargo entry. After `e.revealed = true;`:

```ts
e.revealed = true;
if (this.#backend !== undefined) {
  await this.#backend.put(`embargo/${opId}`, encodeRecord(e));
}
```

> **Note:** update the `OpLog` class doc comment ("Spike — not durable…") to
> note it is durable when constructed with a `Backend`.

- [ ] **Step 4: Run the test — expect PASS** (`AGENT=1 moon run log:test`):
      durable + all existing log tests green.

- [ ] **Step 5: Typecheck + build** — `moon run log:typecheck log:build`.

- [ ] **Step 6: Commit**

```bash
git add packages/log
git commit -m "feat(log): optional durable backend (write-through + load + repoint)

OpLog takes an optional Backend: write/remove/embargo/reveal write through
(op/view/embargo), repoint() durably re-points a shared view, and
OpLog.load(store, backend) rebuilds the DAG+views (skipping torn ops, after
the store is open). Ops frozen on commit. No backend ⇒ unchanged; sync
reads unchanged. Peer-ingest persistence deferred with federation.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 4: `Platform.createDurable`/`openDurable` + land uses `repoint`

Add async durable open to `Platform`, and switch `Repo.land`'s real re-point
from `view` to `repoint` so a landing persists (a no-op-extra without a
backend).

**Files:**

- Modify: `packages/platform/src/platform.ts`
- Modify: `packages/platform/package.json` (add `@thaddeus.run/store` `Backend`
  type — `store` is already a dep; just import the type)
- Test: `packages/platform/test/durable.test.ts`

**Interfaces:**

- Consumes: `Backend` from `@thaddeus.run/store`; `MemoryStore.open`,
  `OpLog.load`.
- Produces: `Platform.createDurable(name, backend): Promise<Repo>`;
  `Platform.openDurable(name, backend): Promise<Repo>`.

- [ ] **Step 1: Write the failing test (the headline: survives a restart)**

`packages/platform/test/durable.test.ts`:

```ts
import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import type { Backend } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { blockOnConflict } from '../src/policy';
import { Platform } from '../src/platform';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

function memoryBackend(): Backend {
  const m = new Map<string, Uint8Array>();
  return {
    put: async (k, b) => void m.set(k, new Uint8Array(b)),
    get: async (k) => {
      const v = m.get(k);
      return v === undefined ? undefined : new Uint8Array(v);
    },
    list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
    delete: async (k) => void m.delete(k),
  };
}

describe('Platform — durable repos', () => {
  test('a repo survives a restart: commit → land → discard → reopen', async () => {
    const backend = memoryBackend();
    const dev = Identity.create();

    const a = await new Platform().createDurable('acme/web', backend);
    const ws = Workspace.open(a.log, a.store, {
      source: 'main',
      reader: dev,
      name: 'feat',
    });
    ws.write('src/auth.rs', enc('fn refresh() {}'));
    await ws.commit(dev);
    const result = await a.land({
      from: 'feat',
      into: 'main',
      author: dev,
      policy: blockOnConflict,
    });
    expect(result.landed).toBe(true);

    // "restart": discard `a`; reopen from the same backend.
    const b = await new Platform().openDurable('acme/web', backend);
    expect(b.log.materialize('main').has('src/auth.rs')).toBe(true);
    const ref = b.log.materialize('main', dev).get('src/auth.rs')?.ref;
    expect(ref).not.toBeNull();
    if (ref != null) {
      expect(dec(await b.store.get(ref, dev))).toBe('fn refresh() {}');
    }
  });

  test('two durable repos in one backend stay isolated', async () => {
    const backend = memoryBackend();
    const dev = Identity.create();
    const a = await new Platform().createDurable('a', backend);
    const wsa = Workspace.open(a.log, a.store, {
      source: 'main',
      reader: dev,
      name: 'f',
    });
    wsa.write('a.rs', enc('a'));
    await wsa.commit(dev);
    await a.land({ from: 'f', author: dev, policy: blockOnConflict });

    const b = await new Platform().openDurable('b', backend); // never written
    expect(b.log.materialize('main').size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`AGENT=1 moon run platform:test`):
      `createDurable is not a function`.

- [ ] **Step 3: Edit `packages/platform/src/platform.ts`**

Add imports (extend the existing store/log imports):

```ts
import type { Backend } from '@thaddeus.run/store';
```

(The file already imports `OpLog as OpLogClass` and `MemoryStore`; use
`MemoryStore.open` and `OpLogClass.load`. The `scoped` namespacing is done with
a tiny inline prefixer so `platform` need not depend on `persist`.)

In `Repo.land`, change the allow-path re-point from `view` to `repoint` (await):

```ts
// The single re-point that IS the landing (durable when the log is backed).
await this.log.repoint(into, mergedHeads);
return { landed: true, into, heads: [...mergedHeads], conflicts };
```

(The dry-run `this.log.view(tmp, mergedHeads)` stays `view` — throwaway, never
persisted.)

Add the two async methods + a private scoper to the `Platform` class:

```ts
  // Fresh durable scope: a backend-backed Store+OpLog, seeds `main`, registers.
  async createDurable(name: string, backend: Backend): Promise<Repo> {
    const existing = this.#repos.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const scoped = scope(backend, `repo/${name}/`);
    const store = new MemoryStore(scoped);
    const log = new OpLogClass(store, scoped);
    log.view('main', []); // empty seed; absence on reload also reads as empty
    const repo = new Repo(name, log, store);
    this.#repos.set(name, repo);
    return repo;
  }

  // Re-open a durable scope: Store.open then OpLog.load (order matters), rebuilt.
  async openDurable(name: string, backend: Backend): Promise<Repo> {
    const scoped = scope(backend, `repo/${name}/`);
    const store = await MemoryStore.open(scoped);
    const log = await OpLogClass.load(store, scoped);
    const repo = new Repo(name, log, store);
    this.#repos.set(name, repo);
    return repo;
  }
```

Add the module-scope scoper (above the `Platform` class, beside `mergeHeads`):

```ts
// Namespace a backend so each scope's keys live under `repo/<name>/`. Inlined so
// platform need not depend on @thaddeus.run/persist (any Backend works).
function scope(backend: Backend, prefix: string): Backend {
  return {
    put: (key, bytes) => backend.put(prefix + key, bytes),
    get: (key) => backend.get(prefix + key),
    delete: (key) => backend.delete(prefix + key),
    list: async (p) =>
      (await backend.list(prefix + p)).map((k) => k.slice(prefix.length)),
  };
}
```

- [ ] **Step 4: Run the test — expect PASS** (`AGENT=1 moon run platform:test`):
      durable survives-restart + isolation + all existing platform tests green
      (the `view→repoint` change is behavior-identical without a backend).

- [ ] **Step 5: Typecheck + build** —
      `moon run platform:typecheck platform:build`.

- [ ] **Step 6: Commit**

```bash
git add packages/platform
git commit -m "feat(platform): createDurable/openDurable — a repo survives a restart

Platform gains async createDurable/openDurable that compose a scoped,
backend-backed Store+OpLog into a Repo (Store.open then OpLog.load).
Repo.land now re-points via OpLog.repoint so a landing persists
(behavior-identical without a backend). Headline test: commit → land →
discard → reopen → still there.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 5: North-star — a durable repo survives a reopen (+ FileBackend)

Prove the whole stack persists: extend the north-star with a durable
survives-restart assertion (`MemoryBackend`, deterministic), and add a
`FileBackend` survives-restart test in `persist` (real fs).

**Files:**

- Modify: `integration/package.json` (add `@thaddeus.run/persist` dep)
- Modify: `integration/test/one-edit-end-to-end.test.ts` (import + one new test)
- Test: `packages/persist/test/survives-restart.test.ts`

**Interfaces:**

- Consumes: `MemoryBackend`, `FileBackend` from `@thaddeus.run/persist`;
  `Platform`, `Workspace`, `Identity`, `blockOnConflict`.

- [ ] **Step 1: Add the integration dep** — edit `integration/package.json`
      `dependencies`, alphabetical (`persist` sorts after `log`, before
      `platform`):

```json
    "@thaddeus.run/log": "workspace:*",
    "@thaddeus.run/persist": "workspace:*",
    "@thaddeus.run/platform": "workspace:*",
```

- [ ] **Step 2: `bun install`** Expected: resolves.

- [ ] **Step 3: Add the import** to
      `integration/test/one-edit-end-to-end.test.ts` (after the
      `@thaddeus.run/log` import; formatter will sort):

```ts
import { MemoryBackend } from '@thaddeus.run/persist';
```

- [ ] **Step 4: Add the north-star durable test** (after the P09 test, same
      `describe`):

```ts
test('persistence: a landed edit survives an openDurable reopen', async () => {
  const backend = new MemoryBackend();
  const dev = Identity.create();

  const a = await new Platform().createDurable('acme/web', backend);
  const ws = Workspace.open(a.log, a.store, {
    source: 'main',
    reader: dev,
    name: 'feat',
  });
  ws.write('src/auth.rs', new TextEncoder().encode('fn refresh() {}'));
  await ws.commit(dev);
  expect(
    (
      await a.land({
        from: 'feat',
        into: 'main',
        author: dev,
        policy: blockOnConflict,
      })
    ).landed
  ).toBe(true);

  // Reopen from the same backend — history + content survive.
  const b = await new Platform().openDurable('acme/web', backend);
  expect(b.log.materialize('main').has('src/auth.rs')).toBe(true);
  const ref = b.log.materialize('main', dev).get('src/auth.rs')?.ref;
  expect(ref).not.toBeNull();
  if (ref != null) {
    expect(new TextDecoder().decode(await b.store.get(ref, dev))).toBe(
      'fn refresh() {}'
    );
  }
});
```

- [ ] **Step 5: Run the north-star — expect 8 pass / 0 todo**
      (`AGENT=1 moon run integration:test`).

- [ ] **Step 6: Write the FileBackend survives-restart test**

`packages/persist/test/survives-restart.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '@thaddeus.run/store';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { FileBackend } from '../src/file';
import { scoped } from '../src/scoped';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-restart-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('FileBackend — survives a restart on real fs', () => {
  test('write + repoint, then reload Store+OpLog from disk', async () => {
    const root = mkdtempSync(join(tmp, 'repo-'));
    const dev = Identity.create();

    const b1 = scoped(new FileBackend(root), 'repo/x/');
    const s1 = new MemoryStore(b1);
    const l1 = new OpLog(s1, b1);
    const op = await l1.write('main', 'src/a.rs', enc('fn a() {}'), dev);

    // Fresh backend over the SAME dir; rebuild store then log.
    const b2 = scoped(new FileBackend(root), 'repo/x/');
    const s2 = await MemoryStore.open(b2);
    const l2 = await OpLog.load(s2, b2);
    expect(l2.heads('main')).toEqual([op.id]);
    const ref = l2.materialize('main', dev).get('src/a.rs')?.ref;
    expect(ref).not.toBeNull();
    if (ref != null) {
      expect(dec(await s2.get(ref, dev))).toBe('fn a() {}');
    }
  });
});
```

- [ ] **Step 7: Run it — expect PASS** (`AGENT=1 moon run persist:test`).

- [ ] **Step 8: Commit**

```bash
git add integration packages/persist
git commit -m "test: a durable repo survives a reopen (north-star + FileBackend)

North-star gains a persistence assertion (MemoryBackend, deterministic):
a landed edit survives Platform.openDurable (8 pass / 0 todo). persist adds
a FileBackend survives-restart test on a real temp dir.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 6: The persistence demo (`examples/persist/`)

A runnable CLI over a `FileBackend` in a temp dir: durable edit → restart →
cold-tier-is-ciphertext.

**Files:**

- Create: `examples/persist/package.json`, `moon.yml`, `tsconfig.json`,
  `src/persist.ts`

**Interfaces:**

- Consumes: `FileBackend` from `@thaddeus.run/persist`; `Platform`; `Workspace`;
  `Identity`, `ready`; `blockOnConflict`.

- [ ] **Step 1: Config files** (mirror `examples/platform/`)

`examples/persist/package.json`:

```json
{
  "name": "@thaddeus.run/example-persist",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@thaddeus.run/fs": "workspace:*",
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/persist": "workspace:*",
    "@thaddeus.run/platform": "workspace:*"
  },
  "devDependencies": { "@types/bun": "catalog:" }
}
```

`examples/persist/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

id: 'example-persist'
language: 'typescript'
layer: 'application'

tasks:
  test:
    args: '--pass-with-no-tests'
  demo:
    command: 'bun src/persist.ts'
    deps:
      - '^:build'
    options:
      cache: false
      runInCI: 'skip'
```

`examples/persist/tsconfig.json`:

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

`examples/persist/src/persist.ts`:

```ts
// Persistence demo (@thaddeus.run/persist).
// Run: CI= moon run example-persist:demo
//
// Three acts: (1) a durable edit lands; (2) "restart" — reopen from the same
// directory and the history + content are still there; (3) the cold tier is
// ciphertext, not plaintext.

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { FileBackend } from '@thaddeus.run/persist';
import { blockOnConflict, Platform } from '@thaddeus.run/platform';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const rule = (): void => console.log('—'.repeat(60));

await ready();
const root = mkdtempSync(join(tmpdir(), 'thaddeus-demo-'));
const dev = Identity.create();

// Act 1 — durable edit.
const a = await new Platform().createDurable('acme/web', new FileBackend(root));
const ws = Workspace.open(a.log, a.store, {
  source: 'main',
  reader: dev,
  name: 'feat',
});
ws.write('src/auth.rs', enc('fn refresh() {}'));
await ws.commit(dev);
const landed = await a.land({
  from: 'feat',
  into: 'main',
  author: dev,
  policy: blockOnConflict,
});
rule();
console.log('1. a durable edit lands — written through to disk:');
console.log('   landed:', landed.landed, '| backend dir:', root);
console.log('   files on disk:', readdirSync(root).length);

// Act 2 — restart.
const b = await new Platform().openDurable('acme/web', new FileBackend(root));
const ref = b.log.materialize('main', dev).get('src/auth.rs')?.ref;
rule();
console.log(
  '2. restart — reopen from the same dir, history + content survive:'
);
console.log(
  '   main has src/auth.rs:',
  b.log.materialize('main').has('src/auth.rs')
);
console.log(
  '   content:',
  ref == null ? '(missing)' : dec(await b.store.get(ref, dev))
);

// Act 3 — the cold tier is ciphertext.
const objFile = readdirSync(root).find((n) => n.includes('obj%2F'));
rule();
console.log('3. the cold tier is ciphertext, not plaintext:');
if (objFile != null) {
  const raw = dec(readFileSync(join(root, objFile)));
  console.log(
    '   raw object on disk contains "fn refresh":',
    raw.includes('fn refresh')
  );
}

rule();
console.log(
  'Acceptance: a repo survives a restart; durable bytes are ciphertext.'
);
```

- [ ] **Step 3: Install + run** —
      `bun install && CI= moon run example-persist:demo` Expected: Act 1
      `landed: true` + a non-zero file count; Act 2
      `main has     src/auth.rs: true` and `content: fn refresh() {}`; Act 3
      `contains "fn     refresh": false` (it's encrypted).

- [ ] **Step 4: Typecheck** — `moon run example-persist:typecheck` Expected:
      PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/persist
git commit -m "docs(persist): runnable demo — durable edit, restart, ciphertext cold tier

examples/persist: a durable edit lands to a FileBackend dir; reopening from
the same dir restores history + content; and a raw on-disk object is shown
to be ciphertext, not plaintext.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 7: Update the convergence docs (ARCHITECTURE + CHANGELOG)

**Files:**

- Modify: `ARCHITECTURE.md`
- Modify: `CHANGELOG.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: `ARCHITECTURE.md`** — after the Status/traceability table, add a
      short subsection:

```markdown
## Persistence (infrastructure, not a pillar)

The substrate is now optionally **durable** behind a pluggable `Backend`
(`@thaddeus.run/persist`: `FileBackend`, `MemoryBackend`). `Store` and `OpLog`
take an optional backend (hot-cache write-through + static `open`/`load`); with
none, behavior is unchanged. `Platform.createDurable`/`openDurable` compose a
backend-backed repo, so **a repo survives a process restart** — the code.store
"in-memory writes, cold storage" split. Server/network and a Git gateway are the
next steps toward runnable; signed-record-log persistence and SQLite/S3 backends
are deferred.
```

- [ ] **Step 2: `CHANGELOG.md` — Added** (after the `@thaddeus.run/agent`
      bullet):

```markdown
- `@thaddeus.run/persist` + durable `Store`/`OpLog` — persistence: a pluggable
  `Backend` (key→bytes; `FileBackend` atomic temp+rename, `MemoryBackend`,
  `scoped`) defined in `@thaddeus.run/store`. `Store` and `OpLog` take an
  optional backend — every mutation write-throughs (content-addressed `obj`/`op`
  write- once; `view`/`cap`/`current`/`pending`/`embargo` pointers),
  `MemoryStore.open` / `OpLog.load` rebuild the hot cache (torn blobs skipped),
  records are frozen on store, and **synchronous reads are unchanged** (no async
  ripple). `Platform.createDurable`/`openDurable` make a repo **survive a
  restart** (8 pass / 0 todo). Realizes the code.store hot/cold split and the
  deferred freeze-on-store immutability fix.
```

- [ ] **Step 3: `CHANGELOG.md` — Deferred edits.** Replace the scope-cut bullet
      **"Persistence backends, federation, agent reputation/economy — beyond the
      in-memory spike."** with:

```markdown
- **Persistence backends (Store + OpLog) — shipped** as `@thaddeus.run/persist`
  (filesystem + in-memory). Still deferred: **signed-record-log persistence**
  (provenance/reputation/agent), **SQLite/S3 backends**, **compaction/GC**, and
  **multi-process concurrency/locking/WAL** (durable, not concurrent).
```

      And update the **"Record deep immutability (P03/P04)"** research bullet by
      appending: _"Freeze-on-store now ships at the persistence boundary
      (EncryptedObject/Op frozen on store + decoded fresh on load); the
      `Uint8Array`-index caveat remains, and a fully immutable wire encoding is
      still the end state."_

      And append a scope-cut bullet:

```markdown
- **Server / network API and Git gateway (persistence→runnable).** Persistence
  is in-process durability; serving it over a wire (the API-first remote) and a
  Git-compatible gateway are the next steps toward a runnable system.
```

- [ ] **Step 4: Format** — `moon run root:format`.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: record the persistence layer (durable Store+OpLog)

ARCHITECTURE gains a Persistence section; CHANGELOG moves 'persistence
backends' to Added (Store+OpLog shipped via @thaddeus.run/persist), notes
freeze-on-store now ships at the boundary, and ledgers the remaining
deferrals (record-log persistence, SQLite/S3, compaction, concurrency,
server/gateway).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 8: Full-workspace verification

**Files:** none (verification only).

- [ ] **Step 1: Build the whole workspace** — `moon run :build` Expected: every
      package builds incl. `@thaddeus.run/persist`. (Pre-existing/unrelated:
      `apps/landing` `missing_outputs`, untouched.)

- [ ] **Step 2: Format + lint** — `moon run root:format root:lint` Expected: 0
      errors (pre-existing `require-await` warnings only; the new always-async
      backend methods may add a couple — acceptable, they match the `Backend`
      interface contract).

- [ ] **Step 3: Typecheck affected** —
      `moon run store:typecheck log:typecheck platform:typecheck persist:typecheck integration:typecheck example-persist:typecheck`
      Expected: all PASS.

- [ ] **Step 4: Affected tests** —
      `AGENT=1 moon run store:test log:test platform:test persist:test integration:test`
      Expected: all green; integration 8 pass / 0 todo.

- [ ] **Step 5: Full suite** — `AGENT=1 moon run :test` Expected: 0 failures
      across identity/store/log/provenance/fs/platform/reputation/agent/persist/
      integration (the no-backend regression keeps every existing suite green).

- [ ] **Step 6: Demo once more** — `CI= moon run example-persist:demo` Expected:
      the three acts print as in Task 6 Step 3.

- [ ] **Step 7: Final commit (only if format/lint produced changes)**

```bash
git add -A
git commit -m "chore(persist): repo-wide format/lint pass for persistence

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

(If `git status` is clean after Step 2, skip this commit.)

---

## Notes for the implementer

- **The whole point is durability without an async ripple.** Mutations are
  already `async`, so write-through `await`s fit inside them; the static
  `open`/`load` are async; but every **synchronous read** (`materialize`,
  `caps`, `heads`, …) keeps reading the hot in-memory cache. If you find
  yourself making `materialize` or `view` async, stop — use `repoint` for the
  durable re-point instead, and keep `view` sync.
- **No-backend is the regression guard.** With no `Backend`, `MemoryStore` and
  `OpLog` must behave byte-for-byte as before — that's why every existing suite
  must stay green at each step. The `#persist`/`#persistCommit` helpers are
  no-ops without a backend.
- **Content-addressed blobs are torn-safe; pointers are not.** On load, an
  `obj/`/`op/` blob whose bytes don't hash to its id is skipped. A pointer
  (`view/`/`current/`) is trusted as last-write-wins (atomic rename makes a torn
  pointer impossible on `FileBackend`).
- **Load order: store, then log.** `OpLog.load` materializes against the store's
  refs; `Platform.openDurable` calls `MemoryStore.open` first. Don't reorder.
- **`Backend` lives in `store`; `persist` only implements it.** `persist`'s only
  `@thaddeus.run` dependency is the `Backend` **type** (devDependency).
- **`bun install` after every `package.json` change** (Tasks 1, 5, 6).
- **Determinism:** tests use fresh identities and assert structural facts
  (round-trips, frozen, heads, materialized paths) — never key bytes. The
  `FileBackend` tests use `mkdtempSync` and clean up in `afterAll`.

```

```
