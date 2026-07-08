# Pillar 08 — Semantic Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@thaddeus.run/graph` — a `SymbolGraph` over a P05 `Workspace`
that projects symbols/definitions/references/call-edges from decryptable text,
addresses code by stable `Symbol.id`, and makes **rename a first-class signed
operation** (one `SymbolOp` rendered across every reference). Extend the
north-star with a structural-rename assertion.

**Architecture:** A new package with four source modules: `symbol.ts`
(projection types + the `Extractor` seam + `HeuristicExtractor`), `symbolop.ts`
(the signed `SymbolOp` record — the `Op`/`Provenance` pattern), `symboloplog.ts`
(the keep-and-verify registry — the `ProvenanceLog` pattern), and `graph.ts`
(the `SymbolLedger` + `SymbolGraph` read/rename surface). Reads re-extract from
`Workspace` text on each call (decryption-bounded for free); `rename` mints one
signed `SymbolOp` and renders it through `Workspace.write` + `commit`.

**Tech Stack:** TypeScript (ESM, `type: module`), Bun test runner, moon task
runner, tsdown bundler. One new runtime dependency posture identical to
`packages/provenance`: `@noble/hashes` (blake3) + `@thaddeus.run/identity`
(sign/verify) are runtime; `@thaddeus.run/fs` and `@thaddeus.run/log` are
**type-only** (dev) — `graph` never instantiates a `Workspace` or an `Op`, it
receives them.

## Global Constraints

- **Spec:** `docs/specs/2026-07-07-thaddeus-pillar-08-semantic-graph-design.md`
  is the source of truth for this plan.
- **Graph is a projection (rigid).** Symbols/defs/refs/edges are re-extracted
  from `Workspace` text on every read; nothing is stored or signed except
  `SymbolOp`. The capability boundary is inherited from `Workspace.read` (a
  `null` read ⇒ the symbol is invisible), never re-checked.
- **Identity in the ledger, not the bytes (rigid).** A `Symbol.id` is minted
  once at birth and retained across renames by the `SymbolLedger`. `rename`
  never mints a new id for an existing symbol.
- **Rename is one signed `SymbolOp`; text ops are its rendering (rigid).**
  `rename` mints exactly one `SymbolOp` and produces N ordinary P03 ops as its
  projection. `SymbolOp` follows the `op.ts`/`provenance.ts` signed-record
  discipline exactly (domain tag, `assertCanonical`, `id = blake3(canonical)`,
  fail-closed verify).
- **Single-language heuristic behind a seam (rigid seam, loose interior).**
  `Extractor` is the rigid interface; `HeuristicExtractor` is a spike. Text is
  the universal fallback.
- **Deferred (out of scope, do not build):** multi-language / real parser, scope
  & shadowing resolution, type edges, structural ops beyond `rename-symbol`,
  whole-program call graph, per-symbol capability scope, `SymbolOp` durability /
  federation, structural conflict-as-function (only the `from` staleness guard
  ships). Spike: in-memory, single process.
- **Tooling:** use `bun` (never npm/pnpm/npx). Run tasks through moon:
  `moon run <project>:<task>` (or `moonx`). Export `AGENT=1` for AI-friendly
  test output. Preserve trailing newlines. Commit messages follow Conventional
  Commits 1.0.0.
- **Naming:** package is `@thaddeus.run/graph` (neutral, product-agnostic);
  primary export `SymbolGraph`. The vision file uses "Thaddeus"; package names
  never use `Thaddeus-`.
- **Verification baseline after code changes:** `moon run root:format root:lint`
  plus the affected `moonx graph:typecheck` and `moonx graph:test`.

---

### Task 1: Scaffold `@thaddeus.run/graph`; projection types + `HeuristicExtractor`

Create the package skeleton (copying `packages/provenance`'s exact config shape)
and `src/symbol.ts`: the `Symbol`/`Definition`/`Reference`/`Edge` types, the
`Extractor` interface, and the `HeuristicExtractor`.

**Files:**

- Create: `packages/graph/package.json`
- Create: `packages/graph/moon.yml`
- Create: `packages/graph/tsconfig.json`
- Create: `packages/graph/tsdown.config.ts`
- Create: `packages/graph/README.md`
- Create: `packages/graph/LICENSE.md` (copy of `packages/log/LICENSE.md`)
- Create: `packages/graph/src/symbol.ts`
- Create: `packages/graph/src/index.ts`
- Test: `packages/graph/test/extractor.test.ts`

**Interfaces:**

- Produces:
  - `interface Symbol { readonly id: string; readonly kind: 'function' | 'type' | 'const'; }`
  - `interface Definition { readonly symbol: string; readonly name: string; readonly path: string; readonly line: number; }`
  - `interface Reference { readonly symbol: string; readonly path: string; readonly line: number; }`
  - `interface Edge { readonly kind: 'calls' | 'references'; readonly from: string; readonly to: string; }`
  - `interface Extractor { readonly language: string; extract(path, text): { defs; refs } }`
  - `class HeuristicExtractor implements Extractor`

- [ ] **Step 1: Create the package config files**

`packages/graph/package.json` (copy `packages/fs/package.json`'s shape; note the
`provenance`-style dependency split — `identity` + `@noble/hashes` runtime, `fs`
and `log` type-only dev):

```json
{
  "name": "@thaddeus.run/graph",
  "version": "0.0.0",
  "description": "The semantic graph — code as a queryable graph of symbols, definitions, references, and call edges over a Workspace, with rename as a first-class signed SymbolOp. Pillar 08.",
  "keywords": ["semantic-graph", "symbols", "rename", "Thaddeus", "substrate"],
  "homepage": "https://thaddeus.run",
  "bugs": { "url": "https://github.com/thaddeus-run/thaddeus/issues" },
  "license": "Apache-2.0",
  "author": { "name": "thaddeus.run", "url": "https://thaddeus.run" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/thaddeus-run/thaddeus.git",
    "directory": "packages/graph"
  },
  "files": ["dist", "LICENSE.md", "README.md"],
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "publishConfig": { "access": "public" },
  "scripts": { "prepublishOnly": "moon run graph:prepublish" },
  "dependencies": {
    "@noble/hashes": "catalog:",
    "@thaddeus.run/identity": "workspace:*"
  },
  "devDependencies": {
    "@thaddeus.run/fs": "workspace:*",
    "@thaddeus.run/log": "workspace:*",
    "@thaddeus.run/store": "workspace:*",
    "@types/bun": "catalog:",
    "@typescript/native-preview": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:"
  }
}
```

> **Dependency note:** mirrors `packages/provenance` — `@noble/hashes` (blake3)
> and `@thaddeus.run/identity` (`Identity.sign` / `PublicIdentity.fromDid` are
> **values**) are runtime deps; `@thaddeus.run/fs` (`Workspace`) and
> `@thaddeus.run/log` (`Op`) are imported **type-only**, so dev deps. `store` is
> a dev dep only for the tests (they build a `MemoryStore`/`OpLog`/`Workspace`).

`packages/graph/moon.yml`, `tsconfig.json`, `tsdown.config.ts` — copy
`packages/fs/moon.yml`, `packages/fs/tsconfig.json`,
`packages/fs/tsdown.config.ts` verbatim (only the surrounding directory
differs).

`packages/graph/README.md`:

```markdown
# @thaddeus.run/graph

The semantic graph for **Thaddeus** (working name) — Pillar 08.

`SymbolGraph` projects a graph of symbols, definitions, references, and call
edges from the plaintext a `@thaddeus.run/fs` `Workspace` materializes — so code
is something you _query_, and files are one rendered view. It addresses code by
a stable `Symbol.id` (minted once at birth, retained across renames by a
`SymbolLedger`) and makes **rename a first-class operation**: one signed
`SymbolOp` rendered across the definition and every reference, not a
thousand-line find-and-replace. The graph is **decryption-bounded** — you only
see the meaning of code your identity can decrypt.

> **Status: spike.** In-memory, single process. One heuristic language behind
> the `Extractor` seam (a real tree-sitter/LSP parser drops in there); type
> edges, structural ops beyond rename, per-symbol capability scope, and
> durability are deferred (see the design spec).
```

- [ ] **Step 2: Copy the license**

```bash
cp packages/log/LICENSE.md packages/graph/LICENSE.md
```

- [ ] **Step 3: Install so workspace symlinks resolve**

Run: `bun install` Expected: completes; `node_modules/@thaddeus.run/graph`
symlink created.

- [ ] **Step 4: Write the failing test**

`packages/graph/test/extractor.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { HeuristicExtractor } from '../src/symbol';

const ex = new HeuristicExtractor();

describe('HeuristicExtractor', () => {
  test('extracts a function definition', () => {
    const { defs, refs } = ex.extract('src/auth.rs', 'fn refresh() {}\n');
    expect(defs).toEqual([{ name: 'refresh', kind: 'function', line: 1 }]);
    expect(refs).toEqual([]);
  });

  test('a call site is a reference, not a definition', () => {
    const text = 'fn refresh() {}\nfn login() {\n  refresh();\n}\n';
    const { defs, refs } = ex.extract('src/auth.rs', text);
    expect(defs.map((d) => d.name).sort()).toEqual(['login', 'refresh']);
    expect(refs).toEqual([{ name: 'refresh', line: 3 }]);
  });

  test('the `fn` keyword is never a symbol name', () => {
    const { defs, refs } = ex.extract('a.rs', 'fn a() {}\n');
    expect(defs).toEqual([{ name: 'a', kind: 'function', line: 1 }]);
    expect(refs.some((r) => r.name === 'fn')).toBe(false);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `AGENT=1 moon run graph:test` Expected: FAIL — cannot resolve
`../src/symbol`.

- [ ] **Step 6: Write `src/symbol.ts`**

```ts
// Pillar 08 projection types + the single-language extraction seam. Symbols,
// definitions, references, and edges are DERIVED from Workspace text — never
// stored, never signed. See the design spec §6–§7.

// A symbol's durable identity — minted once at birth (graph.ts), independent of
// path, name, and text. Rename changes the binding, never this id.
export interface Symbol {
  readonly id: string;
  readonly kind: 'function' | 'type' | 'const';
}

// Where a symbol is currently defined. `name` is the current (post-rename) name.
export interface Definition {
  readonly symbol: string; // Symbol.id
  readonly name: string;
  readonly path: string;
  readonly line: number; // 1-based
}

// A use-site of a symbol.
export interface Reference {
  readonly symbol: string; // Symbol.id
  readonly path: string;
  readonly line: number;
}

// A typed edge in the call/reference graph.
export interface Edge {
  readonly kind: 'calls' | 'references';
  readonly from: string; // Symbol.id (caller)
  readonly to: string; // Symbol.id (callee)
}

// A raw (pre-identity) definition/reference the extractor emits; graph.ts binds
// each to a Symbol.id via the ledger.
export interface RawDef {
  readonly name: string;
  readonly kind: Symbol['kind'];
  readonly line: number;
}
export interface RawRef {
  readonly name: string;
  readonly line: number;
}

// The rigid extraction seam. A real implementation is tree-sitter or a language
// server; the spike ships one regex heuristic. Swapping in a real parser is a
// drop-in behind this interface.
export interface Extractor {
  readonly language: string;
  extract(
    path: string,
    text: string
  ): { readonly defs: readonly RawDef[]; readonly refs: readonly RawRef[] };
}

// Match an identifier immediately following `fn ` — a function definition.
const DEF_RE = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
// Match every `identifier(` on a line — a call. Filtered against defs + keywords.
const CALL_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

// The loose interior: `fn <name>(` is a function definition; any other
// `<name>(` is a call reference. No scope/shadowing analysis, no types, false
// positives inside comments/strings. A SPIKE SEAM — see the spec's honest
// limitations (§11).
export class HeuristicExtractor implements Extractor {
  readonly language = 'rs-heuristic';

  extract(
    _path: string,
    text: string
  ): { readonly defs: readonly RawDef[]; readonly refs: readonly RawRef[] } {
    const defs: RawDef[] = [];
    const refs: RawRef[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const def = DEF_RE.exec(line);
      const defName = def?.[1] ?? null;
      if (defName !== null) {
        defs.push({ name: defName, kind: 'function', line: i + 1 });
      }
      // Every `name(` that is neither the `fn` keyword nor THIS line's own
      // definition occurrence is a call reference.
      CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CALL_RE.exec(line)) !== null) {
        const name = m[1] ?? '';
        if (name === 'fn') {
          continue;
        }
        if (name === defName && DEF_RE.test(line.slice(0, m.index + 1))) {
          continue; // the definition's own `name(`, not a call
        }
        refs.push({ name, line: i + 1 });
      }
    }
    return { defs, refs };
  }
}
```

`packages/graph/src/index.ts`:

```ts
export { HeuristicExtractor } from './symbol';
export type {
  Definition,
  Edge,
  Extractor,
  RawDef,
  RawRef,
  Reference,
  Symbol,
} from './symbol';
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `AGENT=1 moon run graph:test` Expected: PASS — extractor tests green.

- [ ] **Step 8: Typecheck and build**

Run: `moon run graph:typecheck && moon run graph:build` Expected: both succeed.

- [ ] **Step 9: Commit**

```bash
git add packages/graph bun.lock
git commit -m "feat(graph): scaffold @thaddeus.run/graph — projection types + heuristic extractor (Pillar 08)

New package @thaddeus.run/graph. src/symbol.ts defines the Symbol/
Definition/Reference/Edge projection types, the rigid Extractor seam, and
a single-language HeuristicExtractor (fn <name>( defs, <name>( call refs)
— a spike seam a real parser drops in behind.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `SymbolLedger` + `SymbolGraph` read model

Add `src/graph.ts`: the `SymbolLedger` (stable-id mint + retention) and the
`SymbolGraph` read queries over a `Workspace`. `rename` arrives in Task 4.

**Files:**

- Create: `packages/graph/src/graph.ts`
- Modify: `packages/graph/src/index.ts` (export `SymbolGraph`, `SymbolLedger`)
- Test: `packages/graph/test/graph.test.ts`

**Interfaces:**

- Consumes: `Workspace` (type) from `@thaddeus.run/fs`; the `symbol.ts` types +
  `Extractor`.
- Produces: `SymbolLedger`;
  `SymbolGraph.over(workspace, { extractor, ledger?, ops? })` with `symbols`,
  `resolve`, `resolveAt`, `definitionOf`, `referencesTo`, `callersOf`, `edges`.

- [ ] **Step 1: Write the failing test**

`packages/graph/test/graph.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { Workspace } from '@thaddeus.run/fs';
import { beforeAll, describe, expect, test } from 'bun:test';

import { HeuristicExtractor } from '../src/symbol';
import { SymbolGraph } from '../src/graph';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// A repo with `fn refresh()` and a caller `fn login()` that calls refresh().
async function seed(): Promise<{ ws: Workspace; g: SymbolGraph }> {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const dev = Identity.create();
  const ws = Workspace.open(log, store, { source: 'main', reader: dev });
  ws.write(
    'src/auth.rs',
    enc('fn refresh() {}\nfn login() {\n  refresh();\n}\n')
  );
  await ws.commit(dev);
  const g = SymbolGraph.over(ws, { extractor: new HeuristicExtractor() });
  return { ws, g };
}

describe('SymbolGraph — read model', () => {
  test('resolve maps a name to a stable id; definitionOf reports the site', async () => {
    const { g } = await seed();
    const id = await g.resolve('refresh');
    expect(id).not.toBeNull();
    expect(await g.resolve('refresh')).toBe(id); // stable across queries
    const def = await g.definitionOf(id!);
    expect(def).toMatchObject({
      name: 'refresh',
      path: 'src/auth.rs',
      line: 1,
    });
  });

  test('referencesTo includes the call site; callersOf includes login', async () => {
    const { g } = await seed();
    const refresh = (await g.resolve('refresh'))!;
    const login = (await g.resolve('login'))!;
    expect(await g.referencesTo(refresh)).toEqual([
      { symbol: refresh, path: 'src/auth.rs', line: 3 },
    ]);
    expect((await g.callersOf(refresh)).map((s) => s.id)).toContain(login);
  });

  test('symbols and edges expose the whole decryptable graph', async () => {
    const { g } = await seed();
    const names = (await g.symbols()).length;
    expect(names).toBe(2); // refresh, login
    const refresh = (await g.resolve('refresh'))!;
    const login = (await g.resolve('login'))!;
    expect(await g.edges()).toEqual(
      expect.arrayContaining([
        { kind: 'calls', from: login, to: refresh },
        { kind: 'references', from: login, to: refresh },
      ])
    );
  });

  test('the graph is decryption-bounded: an ungranted def is invisible', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const dev = Identity.create();
    const other = Identity.create();
    // `other` writes an ungranted secret to main; `dev` cannot decrypt it.
    await log.write('main', 'src/secret.rs', enc('fn hidden() {}'), other);
    const ws = Workspace.open(log, store, { source: 'main', reader: dev });
    const g = SymbolGraph.over(ws, { extractor: new HeuristicExtractor() });
    expect(await ws.list()).toContain('src/secret.rs'); // path visible
    expect(await g.resolve('hidden')).toBeNull(); // meaning not
    expect((await g.symbols()).some((s) => true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENT=1 moon run graph:test` Expected: FAIL — cannot resolve
`../src/graph`.

- [ ] **Step 3: Write `src/graph.ts` (ledger + read model)**

```ts
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import type { Workspace } from '@thaddeus.run/fs';

import type {
  Definition,
  Edge,
  Extractor,
  RawDef,
  Reference,
  Symbol,
} from './symbol';

// Domain tag for the birth-mint content address, so a symbol id can never
// collide with an op id, provenance hash, or another protocol's digest.
const SYMBOL_DOMAIN = 'thaddeus.graph.symbol.v1';

// The current binding of a symbol — its lookup key. `id` is stable; this moves.
interface Binding {
  readonly path: string;
  readonly name: string;
  readonly kind: Symbol['kind'];
}

const bindingKey = (b: Binding): string =>
  JSON.stringify([b.path, b.name, b.kind]);

// In-memory symbol-identity map: (path,name,kind) ⇆ Symbol.id. Mints an id at
// first sight and RETAINS it across renames (rebind moves the key, keeps the id).
// Spike — not durable, not concurrency-safe.
export class SymbolLedger {
  readonly #byKey: Map<string, string> = new Map();
  readonly #byId: Map<string, Binding> = new Map();

  // The id for a binding, minting it on first sight. Content-addressed at birth
  // → deterministic and test-reproducible.
  mintOrGet(b: Binding): string {
    const key = bindingKey(b);
    const existing = this.#byKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const id = bytesToHex(
      blake3(
        new TextEncoder().encode(
          JSON.stringify([SYMBOL_DOMAIN, b.path, b.name, b.kind])
        )
      )
    );
    this.#byKey.set(key, id);
    // Do not clobber an existing id→binding (a name resurrected after rename is a
    // known spike edge, spec §11); first binding wins.
    if (!this.#byId.has(id)) {
      this.#byId.set(id, b);
    }
    return id;
  }

  bindingOf(id: string): Binding | null {
    return this.#byId.get(id) ?? null;
  }

  currentName(id: string): string | null {
    return this.#byId.get(id)?.name ?? null;
  }

  // Move a symbol's binding from its current name to `to`, keeping the same id.
  rebind(id: string, to: string): void {
    const b = this.#byId.get(id);
    if (b === undefined) {
      throw new Error(`unknown symbol ${id}`);
    }
    this.#byKey.delete(bindingKey(b));
    const next: Binding = { path: b.path, name: to, kind: b.kind };
    this.#byKey.set(bindingKey(next), id);
    this.#byId.set(id, next);
  }
}

// The read/rename surface over a Workspace. Reads re-extract from decryptable
// Workspace text on each call — the capability boundary is inherited from
// Workspace (a null read ⇒ the symbol is invisible). Spike — single process.
export class SymbolGraph {
  readonly #ws: Workspace;
  readonly #extractor: Extractor;
  readonly #ledger: SymbolLedger;

  protected constructor(
    ws: Workspace,
    extractor: Extractor,
    ledger: SymbolLedger
  ) {
    this.#ws = ws;
    this.#extractor = extractor;
    this.#ledger = ledger;
  }

  static over(
    workspace: Workspace,
    opts: { extractor: Extractor; ledger?: SymbolLedger }
  ): SymbolGraph {
    return new SymbolGraph(
      workspace,
      opts.extractor,
      opts.ledger ?? new SymbolLedger()
    );
  }

  // Re-extract the whole decryptable view into a resolved model: defs bound to
  // stable ids, refs and edges pointing at resolved callees, with each ref's
  // enclosing definition (nearest preceding def in the same file) as the caller.
  async #model(): Promise<{
    defs: Definition[];
    refs: Reference[];
    edges: Edge[];
  }> {
    const defs: Definition[] = [];
    const refs: Reference[] = [];
    const edges: Edge[] = [];
    for (const path of await this.#ws.list()) {
      const bytes = await this.#ws.read(path);
      if (bytes === null) {
        continue; // undecryptable or absent — inherited capability boundary
      }
      const text = new TextDecoder().decode(bytes);
      const raw = this.#extractor.extract(path, text);
      // Bind every def to a stable id first, remembering def line → id so a
      // ref's enclosing caller can be resolved.
      const localDefs: { id: string; line: number; name: string }[] = [];
      for (const d of raw.defs) {
        const id = this.#ledger.mintOrGet({ path, name: d.name, kind: d.kind });
        defs.push({ symbol: id, name: d.name, path, line: d.line });
        localDefs.push({ id, line: d.line, name: d.name });
      }
      // Resolve each ref to the id of the def it names (in this file first, else
      // any file). The caller is the nearest def defined at or before the ref.
      for (const r of raw.refs) {
        const calleeId = this.#resolveName(r.name, path);
        if (calleeId === null) {
          continue; // a call to something outside the decryptable view
        }
        refs.push({ symbol: calleeId, path, line: r.line });
        const caller = localDefs
          .filter((d) => d.line <= r.line)
          .sort((a, b) => b.line - a.line)[0];
        if (caller !== undefined) {
          edges.push({ kind: 'calls', from: caller.id, to: calleeId });
          edges.push({ kind: 'references', from: caller.id, to: calleeId });
        }
      }
    }
    return { defs, refs, edges };
  }

  // Best-effort name → id using the ledger (populated by #model's def pass).
  #resolveName(name: string, preferPath: string): string | null {
    const here = this.#ledger.mintOrGet;
    // Prefer a def in `preferPath`, else any known binding of the name.
    // (mintOrGet is idempotent; here we only look up, so probe both paths.)
    const local = this.#ledgerLookup(preferPath, name);
    if (local !== null) {
      return local;
    }
    return this.#ledgerLookupAny(name);
  }

  // Lookup helpers over the ledger's public surface (bindingOf via a reverse
  // scan is avoided by keeping resolution inside #model, where defs are minted
  // first). These probe by reconstructing candidate keys.
  #ledgerLookup(path: string, name: string): string | null {
    for (const kind of ['function', 'type', 'const'] as const) {
      const id = this.#ledger.mintOrGet({ path, name, kind });
      const b = this.#ledger.bindingOf(id);
      if (b !== null && b.path === path && b.name === name) {
        return id;
      }
    }
    return null;
  }

  #ledgerLookupAny(name: string): string | null {
    // The ledger has no name index; #model always mints defs before resolving
    // refs, so a same-name def in the view is already keyed. A cross-file lookup
    // falls back to null (a call to an undecryptable/undefined symbol).
    return null;
  }

  async symbols(): Promise<readonly Symbol[]> {
    const { defs } = await this.#model();
    const seen = new Set<string>();
    const out: Symbol[] = [];
    for (const d of defs.sort((a, b) => (a.symbol < b.symbol ? -1 : 1))) {
      if (!seen.has(d.symbol)) {
        seen.add(d.symbol);
        out.push({ id: d.symbol, kind: 'function' });
      }
    }
    return out;
  }

  async resolve(name: string): Promise<string | null> {
    const { defs } = await this.#model();
    const hit = defs.find((d) => d.name === name);
    return hit?.symbol ?? null;
  }

  async resolveAt(path: string, name: string): Promise<string | null> {
    const { defs } = await this.#model();
    const hit = defs.find((d) => d.name === name && d.path === path);
    return hit?.symbol ?? null;
  }

  async definitionOf(symbolId: string): Promise<Definition | null> {
    const { defs } = await this.#model();
    return defs.find((d) => d.symbol === symbolId) ?? null;
  }

  async referencesTo(symbolId: string): Promise<readonly Reference[]> {
    const { refs } = await this.#model();
    return refs
      .filter((r) => r.symbol === symbolId)
      .sort((a, b) =>
        a.path !== b.path ? (a.path < b.path ? -1 : 1) : a.line - b.line
      );
  }

  async callersOf(symbolId: string): Promise<readonly Symbol[]> {
    const { edges, defs } = await this.#model();
    const callerIds = new Set(
      edges
        .filter((e) => e.kind === 'calls' && e.to === symbolId)
        .map((e) => e.from)
    );
    const byId = new Map(defs.map((d) => [d.symbol, d] as const));
    return [...callerIds]
      .filter((id) => byId.has(id))
      .sort()
      .map((id) => ({ id, kind: 'function' as const }));
  }

  async edges(): Promise<readonly Edge[]> {
    const { edges } = await this.#model();
    return edges;
  }

  // Expose the ledger for Task 4 (rename) — same-package only.
  protected get ledger(): SymbolLedger {
    return this.#ledger;
  }

  protected get workspace(): Workspace {
    return this.#ws;
  }
}
```

> **Implementer note — resolution simplicity.** The helper `#resolveName`
> approach above is deliberately conservative. If it reads awkwardly during
> implementation, replace it with the simpler two-pass form: in `#model`, build
> a `Map<name, id>` from the def pass first (last def of a name wins), then
> resolve refs by that map. Keep the public read-method behavior and the tests
> identical; the internal name→id resolution is loose interior, not a rigid
> seam.

- [ ] **Step 4: Update `src/index.ts`**

Add:

```ts
export { SymbolGraph, SymbolLedger } from './graph';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `AGENT=1 moon run graph:test` Expected: PASS — read-model tests green.

- [ ] **Step 6: Typecheck and build**

Run: `moon run graph:typecheck && moon run graph:build` Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): SymbolLedger + SymbolGraph read model over a Workspace

SymbolLedger mints a stable Symbol.id at birth (content-addressed) and
retains it across renames. SymbolGraph.over re-extracts decryptable
Workspace text into resolve/definitionOf/referencesTo/callersOf/edges/
symbols — symbol-level addressing, decryption-bounded by inheriting the
Workspace read boundary.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `SymbolOp` signed record + `SymbolOpLog`

Add the signed structural op (`src/symbolop.ts`, the exact
`op.ts`/`provenance.ts` pattern) and its keep-and-verify registry
(`src/symboloplog.ts`, the `provenancelog.ts` pattern).

**Files:**

- Create: `packages/graph/src/symbolop.ts`
- Create: `packages/graph/src/symboloplog.ts`
- Modify: `packages/graph/src/index.ts`
- Test: `packages/graph/test/symbolop.test.ts`

**Interfaces:**

- Consumes: `Identity`, `PublicIdentity` (values) from `@thaddeus.run/identity`;
  `blake3`, `bytesToHex` from `@noble/hashes`.
- Produces: `SymbolOp`, `SymbolOpFields`, `signSymbolOp`, `verifySymbolOp`,
  `SymbolOpLog`.

- [ ] **Step 1: Write the failing test**

`packages/graph/test/symbolop.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { signSymbolOp, verifySymbolOp } from '../src/symbolop';
import { SymbolOpLog } from '../src/symboloplog';

beforeAll(async () => {
  await ready();
});

const fields = {
  kind: 'rename-symbol' as const,
  symbol: 'sym-abc',
  from: 'refresh',
  to: 'refreshToken',
  base: null,
};

describe('SymbolOp — signed record', () => {
  test('sign then verify round-trips', () => {
    const op = signSymbolOp(fields, Identity.create());
    expect(verifySymbolOp(op)).toBe(true);
    expect(op.kind).toBe('rename-symbol');
    expect(op.symbol).toBe('sym-abc');
  });

  test('tampering any signed field fails closed', () => {
    const op = signSymbolOp(fields, Identity.create());
    expect(verifySymbolOp({ ...op, to: 'evil' })).toBe(false);
    expect(verifySymbolOp({ ...op, symbol: 'other' })).toBe(false);
    // id binds the tuple too: a mismatched id fails without throwing.
    expect(verifySymbolOp({ ...op, id: 'deadbeef' })).toBe(false);
  });

  test('an empty required field throws on sign, is rejected on verify', () => {
    expect(() =>
      signSymbolOp({ ...fields, to: '' }, Identity.create())
    ).toThrow();
  });
});

describe('SymbolOpLog — keep-and-verify', () => {
  test('forSymbol returns records for an id; append dedups identical records', () => {
    const author = Identity.create();
    const op = signSymbolOp(fields, author);
    const log = new SymbolOpLog();
    log.append(op);
    log.append(op); // idempotent
    expect(log.forSymbol('sym-abc')).toHaveLength(1);
    expect(log.verify(op)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENT=1 moon run graph:test` Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/symbolop.ts`** (mirror `packages/log/src/op.ts` and
      `packages/provenance/src/provenance.ts` field-for-field)

```ts
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { Identity, PublicIdentity } from '@thaddeus.run/identity';

// A signed structural operation over the semantic graph. Targets a Symbol.id,
// never a path (the manifesto's "step 3's Op targets a symbol id"). The spike
// ships 'rename-symbol'; change-signature/move-definition share this shape.
export interface SymbolOp {
  readonly id: string;
  readonly kind: 'rename-symbol';
  readonly symbol: string;
  readonly from: string;
  readonly to: string;
  readonly base: string | null;
  readonly author: string;
  readonly sig: Uint8Array;
}

// The signable fields, before id/author/sig are computed.
export interface SymbolOpFields {
  readonly kind: 'rename-symbol';
  readonly symbol: string;
  readonly from: string;
  readonly to: string;
  readonly base: string | null;
}

// Domain tag prefixed into the signed tuple so a SymbolOp signature can never be
// confused with an op (thaddeus.log.op.v1) or provenance (thaddeus.provenance.v1)
// signature.
const SYMBOLOP_DOMAIN = 'thaddeus.graph.symbolop.v1';

// Reject non-canonical field values before they are hashed/signed. Mirrors
// op.ts/provenance.ts: an empty/wrong-typed required field throws, so
// verifySymbolOp (try/catch) rejects such records and signSymbolOp fails fast.
function assertCanonical(fields: SymbolOpFields, author: string): void {
  if (fields.kind !== 'rename-symbol') {
    throw new TypeError('symbolOp.kind must be "rename-symbol"');
  }
  const required: [string, unknown][] = [
    ['symbol', fields.symbol],
    ['from', fields.from],
    ['to', fields.to],
    ['author', author],
  ];
  for (const [name, value] of required) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`symbolOp.${name} must be a non-empty string`);
    }
  }
  if (
    fields.base !== null &&
    (typeof fields.base !== 'string' || fields.base.length === 0)
  ) {
    throw new TypeError('symbolOp.base must be a non-empty string or null');
  }
}

// Deterministic bytes for id + signature.
export function canonicalSymbolOp(
  fields: SymbolOpFields,
  author: string
): Uint8Array {
  assertCanonical(fields, author);
  return new TextEncoder().encode(
    JSON.stringify([
      SYMBOLOP_DOMAIN,
      fields.kind,
      fields.symbol,
      fields.from,
      fields.to,
      fields.base,
      author,
    ])
  );
}

// Build the full signed record. id = blake3(canonical); sig = author over the
// same canonical bytes, so id and signature bind the identical tuple.
export function signSymbolOp(
  fields: SymbolOpFields,
  author: Identity
): SymbolOp {
  const bytes = canonicalSymbolOp(fields, author.did);
  return {
    id: bytesToHex(blake3(bytes)),
    kind: fields.kind,
    symbol: fields.symbol,
    from: fields.from,
    to: fields.to,
    base: fields.base,
    author: author.did,
    sig: author.sign(bytes),
  };
}

// Valid iff the id matches the canonical bytes AND the signature verifies under
// the author's did:key. Fails closed: any mismatch OR malformed input returns
// false rather than throwing.
export function verifySymbolOp(op: SymbolOp): boolean {
  try {
    const bytes = canonicalSymbolOp(op, op.author);
    if (bytesToHex(blake3(bytes)) !== op.id) {
      return false;
    }
    return PublicIdentity.fromDid(op.author).verify(bytes, op.sig);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Write `src/symboloplog.ts`** (mirror `provenancelog.ts`)

```ts
import { bytesToHex } from '@noble/hashes/utils';

import { type SymbolOp, verifySymbolOp } from './symbolop';

// In-memory registry of SymbolOps keyed by Symbol.id. Spike — not durable, not
// concurrency-safe. Like ProvenanceLog, an invalid record is KEPT and rendered
// unverifiable rather than rejected: an unverifiable structural claim poisons
// nothing.
export class SymbolOpLog {
  readonly #bySymbol: Map<string, SymbolOp[]> = new Map();

  append(op: SymbolOp): void {
    const list = this.#bySymbol.get(op.symbol) ?? [];
    const key = this.#contentKey(op);
    if (!list.some((e) => this.#contentKey(e) === key)) {
      list.push(op);
      this.#bySymbol.set(op.symbol, list);
    }
  }

  // A total identity key over every field, so a forged record reusing a genuine
  // signature still gets a distinct key and is kept alongside it (see the
  // provenancelog rationale).
  #contentKey(op: SymbolOp): string {
    return JSON.stringify([
      op.id,
      op.kind,
      op.symbol,
      op.from,
      op.to,
      op.base,
      op.author,
      bytesToHex(op.sig),
    ]);
  }

  // The signed structural history of a symbol, deterministic order (by author,
  // then signature bytes, then full content).
  forSymbol(symbolId: string): readonly SymbolOp[] {
    return [...(this.#bySymbol.get(symbolId) ?? [])].sort((a, b) => {
      if (a.author !== b.author) {
        return a.author < b.author ? -1 : 1;
      }
      const sa = bytesToHex(a.sig);
      const sb = bytesToHex(b.sig);
      if (sa !== sb) {
        return sa < sb ? -1 : 1;
      }
      const ka = this.#contentKey(a);
      const kb = this.#contentKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  verify(op: SymbolOp): boolean {
    return verifySymbolOp(op);
  }
}
```

- [ ] **Step 5: Update `src/index.ts`**

```ts
export { signSymbolOp, verifySymbolOp } from './symbolop';
export type { SymbolOp, SymbolOpFields } from './symbolop';
export { SymbolOpLog } from './symboloplog';
```

- [ ] **Step 6: Run, typecheck, build**

Run:
`AGENT=1 moon run graph:test && moon run graph:typecheck && moon run graph:build`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): SymbolOp signed record + SymbolOpLog

SymbolOp is the signed structural op (domain-tagged canonical JSON, id =
blake3(canonical), fail-closed verify) modeled field-for-field on op.ts/
provenance.ts. SymbolOpLog is the ProvenanceLog keep-and-verify registry
keyed by Symbol.id (forSymbol, content-key dedup).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `SymbolGraph.rename` — the first-class structural op

Wire the differentiated operation: mint one `SymbolOp`, render it across every
reference via `Workspace.write` + `commit`, rebind the ledger, with a staleness
guard. Add `history`. This is the pillar's proof point.

**Files:**

- Modify: `packages/graph/src/graph.ts` (add `rename`, `history`, hold a
  `SymbolOpLog`; `StaleRename` error)
- Modify: `packages/graph/src/index.ts` (export `StaleRename`)
- Test: `packages/graph/test/rename.test.ts`

**Interfaces:**

- Consumes: `Identity` (type) from `@thaddeus.run/identity`; `Op` (type) from
  `@thaddeus.run/log`; `signSymbolOp`, `SymbolOp` from `./symbolop`;
  `SymbolOpLog` from `./symboloplog`.
- Produces:
  `SymbolGraph.rename(symbolId, newName, author): Promise<{ symbolOp; ops }>`,
  `SymbolGraph.history(symbolId): readonly SymbolOp[]`, `class StaleRename`.

- [ ] **Step 1: Write the failing test**

`packages/graph/test/rename.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { verifyOp } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { Workspace } from '@thaddeus.run/fs';
import { beforeAll, describe, expect, test } from 'bun:test';

import { HeuristicExtractor } from '../src/symbol';
import { SymbolGraph, StaleRename } from '../src/graph';
import { verifySymbolOp } from '../src/symbolop';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

async function seed() {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const dev = Identity.create();
  const ws = Workspace.open(log, store, { source: 'main', reader: dev });
  ws.write(
    'src/auth.rs',
    enc('fn refresh() {}\nfn login() {\n  refresh();\n}\n')
  );
  await ws.commit(dev);
  const g = SymbolGraph.over(ws, { extractor: new HeuristicExtractor() });
  return { ws, g, dev };
}

describe('SymbolGraph.rename — one signed op, rendered everywhere', () => {
  test('rename mints one SymbolOp and renders across def + every reference', async () => {
    const { ws, g, dev } = await seed();
    const id = (await g.resolve('refresh'))!;

    const { symbolOp, ops } = await g.rename(id, 'refreshToken', dev);

    // One signed semantic op, targeting the symbol id, not a path.
    expect(verifySymbolOp(symbolOp)).toBe(true);
    expect(symbolOp.kind).toBe('rename-symbol');
    expect(symbolOp.symbol).toBe(id);
    expect(symbolOp.from).toBe('refresh');
    expect(symbolOp.to).toBe('refreshToken');

    // Rendered across every occurrence — def AND call — from that one call.
    const src = dec((await ws.read('src/auth.rs'))!);
    expect(src).toContain('fn refreshToken()');
    expect(src).toContain('refreshToken();');
    expect(src).not.toContain('refresh(');

    // The rendered ops are ordinary signed P03 ops.
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((o) => verifyOp(o))).toBe(true);

    // Identity survived: same id, old name gone.
    expect(await g.resolve('refreshToken')).toBe(id);
    expect(await g.resolve('refresh')).toBeNull();

    // History records the rename.
    expect(g.history(id).map((h) => h.to)).toEqual(['refreshToken']);
  });

  test('a stale rename (from no longer matches) is rejected, writes nothing', async () => {
    const { ws, g, dev } = await seed();
    const id = (await g.resolve('refresh'))!;
    await g.rename(id, 'refreshToken', dev); // now named refreshToken

    // A second graph over the same ledger-less workspace resolves fresh; but on
    // THIS graph the ledger says the current name is refreshToken, so a rename
    // asserting from='refresh' is stale.
    await expect(g.rename(id, 'somethingElse', dev)).rejects.toBeInstanceOf(
      StaleRename
    );
  });
});
```

> **Note:** the staleness test relies on `rename` deriving `from` from the
> ledger's current name and rejecting if the caller-visible name has moved. If
> you model `rename(symbolId, newName)` to always read `from` from the ledger
> (recommended), craft the stale case by mutating the workspace text out from
> under the graph (e.g. a direct `ws.write` renaming the def) before calling
> `rename`, so the ledger's `from` no longer matches the extracted def. Keep the
> assertion: a mismatch throws `StaleRename` and writes no ops.

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENT=1 moon run graph:test` Expected: FAIL — `g.rename`/`StaleRename`
missing.

- [ ] **Step 3: Add `rename`, `history`, `StaleRename` to `graph.ts`**

At module scope in `graph.ts`, add the error and the `SymbolOpLog` field, then
the methods (import `Identity` type, `Op` type, `signSymbolOp`, `SymbolOp`,
`SymbolOpLog`):

```ts
// Thrown when a rename's expected `from` name no longer matches the symbol's
// current binding — the symbol moved under the caller. No text is written.
export class StaleRename extends Error {
  constructor(symbolId: string, expected: string, actual: string | null) {
    super(
      `stale rename of ${symbolId}: expected current name ${expected}, found ${actual}`
    );
    this.name = 'StaleRename';
  }
}
```

Give `SymbolGraph` a `#ops: SymbolOpLog` (constructed default or injected via
`over`'s `opts.ops`), then:

```ts
  // Rename a symbol as ONE signed SymbolOp rendered across the def and every
  // reference. Order (spec §4.2): resolve current binding → staleness guard →
  // mint+record SymbolOp → rewrite each occurrence via Workspace.write + one
  // commit → rebind the ledger. Returns the semantic op and the rendered P03 ops.
  async rename(
    symbolId: string,
    newName: string,
    author: Identity
  ): Promise<{ readonly symbolOp: SymbolOp; readonly ops: readonly Op[] }> {
    // (1) Current binding + the live occurrence set from a fresh extraction.
    const from = this.ledger.currentName(symbolId);
    const def = await this.definitionOf(symbolId);
    // (2) Staleness guard: the ledger's name must still match what the text says.
    if (from === null || def === null || def.name !== from) {
      throw new StaleRename(symbolId, from ?? '(unknown)', def?.name ?? null);
    }
    const refs = await this.referencesTo(symbolId);

    // (3) Mint + record the one signed artifact of meaning.
    const symbolOp = signSymbolOp(
      { kind: 'rename-symbol', symbol: symbolId, from, to: newName, base: null },
      author
    );
    this.#ops.append(symbolOp);

    // (4) Render: rewrite the identifier from→newName at every touched path,
    // then a single commit. Whole-word replace (the heuristic has no scope —
    // spec §11). Paths touched = def path ∪ each ref path.
    const touched = new Set<string>([def.path, ...refs.map((r) => r.path)]);
    const wordRe = new RegExp(`\\b${escapeIdent(from)}\\b`, 'g');
    for (const path of touched) {
      const bytes = await this.workspace.read(path);
      if (bytes === null) {
        continue;
      }
      const text = new TextDecoder().decode(bytes);
      this.workspace.write(path, new TextEncoder().encode(text.replace(wordRe, newName)));
    }
    const ops = await this.workspace.commit(author);

    // (5) Rebind the ledger so re-extraction re-links the same id to newName.
    this.ledger.rebind(symbolId, newName);

    return { symbolOp, ops };
  }

  history(symbolId: string): readonly SymbolOp[] {
    return this.#ops.forSymbol(symbolId);
  }
```

Add the identifier-escape helper at module scope:

```ts
// Escape a bare identifier for use inside a RegExp (identifiers are [A-Za-z0-9_],
// so this is defensive; keeps the helper honest if the char set widens).
function escapeIdent(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

Update `over` to accept and store `opts.ops` (`?? new SymbolOpLog()`), and
adjust the constructor to hold `#ops`.

- [ ] **Step 4: Update `src/index.ts`**

```ts
export { SymbolGraph, SymbolLedger, StaleRename } from './graph';
```

- [ ] **Step 5: Run, typecheck, build**

Run:
`AGENT=1 moon run graph:test && moon run graph:typecheck && moon run graph:build`
Expected: all PASS — rename renders across def + reference, identity survives,
stale rename rejected.

- [ ] **Step 6: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): SymbolGraph.rename — rename as one first-class signed op

rename() mints one SymbolOp (the artifact of meaning) and renders it across
the definition and every reference via Workspace.write + a single commit,
producing ordinary signed P03 ops. Identity survives (the ledger rebinds,
keeping the id); a stale from-name throws StaleRename and writes nothing.
The pillar's proof point: a rename is one operation, not a find-and-replace.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Extend the north-star with a structural rename

Add one test to `integration/test/one-edit-end-to-end.test.ts` proving the
manifesto's "structural change" branch: define a symbol + caller in a
`Workspace`, rename via one `SymbolOp`, all references update, identity
preserved, a provenance "why" bound to the rename, rendered ops land + mirror.

**Files:**

- Modify: `integration/package.json` (add `@thaddeus.run/graph` dependency)
- Modify: `integration/test/one-edit-end-to-end.test.ts` (import + new test)

- [ ] **Step 1: Add the dependency**

Edit `integration/package.json` `dependencies` to include `@thaddeus.run/graph`
(keep alphabetical — `graph` sorts after `fs`, before `identity`):

```json
    "@thaddeus.run/fs": "workspace:*",
    "@thaddeus.run/graph": "workspace:*",
    "@thaddeus.run/identity": "workspace:*",
```

Run: `bun install`.

- [ ] **Step 2: Add the import + test**

Add near the other imports:

```ts
import {
  HeuristicExtractor,
  SymbolGraph,
  verifySymbolOp,
} from '@thaddeus.run/graph';
```

Add this test inside the `north-star: one edit, end to end` describe block:

```ts
test('P08: a structural rename is one signed SymbolOp rendered across every reference, with a why', async () => {
  const repo = new Platform().createRepo('acme/web');
  const author = Identity.create();
  const prov = new ProvenanceLog(repo.store);

  // Define a symbol and a caller in a Workspace, then land it.
  const ws = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: author,
    name: 'feat/graph',
  });
  ws.write(
    'src/auth.rs',
    new TextEncoder().encode('fn refresh() {}\nfn login() {\n  refresh();\n}\n')
  );
  await ws.commit(author);

  // Symbol-level addressing: name → stable id; the call site is a reference.
  const graph = SymbolGraph.over(ws, { extractor: new HeuristicExtractor() });
  const id = await graph.resolve('refresh');
  expect(id).not.toBeNull();
  expect(await graph.referencesTo(id!)).toEqual([
    { symbol: id!, path: 'src/auth.rs', line: 3 },
  ]);

  // Rename is ONE signed SymbolOp, rendered across def + call from one call.
  const { symbolOp, ops } = await graph.rename(id!, 'refreshToken', author);
  expect(verifySymbolOp(symbolOp)).toBe(true);
  expect(symbolOp.symbol).toBe(id);
  const src = new TextDecoder().decode((await ws.read('src/auth.rs'))!);
  expect(src).toContain('fn refreshToken()');
  expect(src).toContain('refreshToken();');
  expect(src).not.toContain('refresh(');

  // Identity survived the rename.
  expect(await graph.resolve('refreshToken')).toBe(id);

  // A signed "why" binds to the rename's rendered op (compose with P04).
  const why = await prov.record(
    ops[0]!,
    {
      intent: 'rename refresh → refreshToken for clarity',
      reasoning: 'the name shadowed a field; renamed the symbol',
      actorKind: 'agent:claude-code@1.2',
    },
    author
  );
  expect(prov.status(why)).toBe('verified');
});
```

- [ ] **Step 3: Run the north-star suite**

Run: `AGENT=1 moon run integration:test` Expected: PASS — the existing tests
plus the new P08 assertion, all green.

- [ ] **Step 4: Commit**

```bash
git add integration
git commit -m "test(integration): the north-star gains a structural rename (P08)

A rename enters through SymbolGraph: define fn refresh() + a caller, resolve
the symbol id, rename to refreshToken as one signed SymbolOp that renders
across def and call, keep the same id, and bind a provenance why to the
rendered op. The manifesto's 'same pipeline, finer unit'.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: The semantic-graph demo (`examples/semantic-graph/`)

Add a runnable CLI demo (sibling to `examples/workspace/`) enacting the three
acts from spec §9.

**Files:**

- Create: `examples/semantic-graph/package.json` (deps: `@thaddeus.run/fs`,
  `@thaddeus.run/graph`, `@thaddeus.run/identity`, `@thaddeus.run/log`,
  `@thaddeus.run/store`; devDep `@types/bun`)
- Create: `examples/semantic-graph/moon.yml` (id `example-semantic-graph`; copy
  `examples/workspace/moon.yml`'s `test --pass-with-no-tests` + `demo` task
  shape)
- Create: `examples/semantic-graph/tsconfig.json` (copy
  `examples/workspace/tsconfig.json`)
- Create: `examples/semantic-graph/src/semantic-graph.ts`

- [ ] **Step 1: Create the config files** — copy the `examples/workspace/`
      shapes, renaming id → `example-semantic-graph` and the demo entry to
      `bun src/semantic-graph.ts`.

- [ ] **Step 2: Write the demo**
      (`examples/semantic-graph/src/semantic-graph.ts`): the three acts — (1)
      query the graph (`resolve`/`definitionOf`/ `referencesTo`/`callersOf`),
      (2) `rename` and show one signed op renders across every site with
      identity preserved and `history`, (3) an ungranted def is listed but
      invisible to the graph. Print the acceptance facts.

- [ ] **Step 3: Install and run** —
      `bun install && CI= moon run example-semantic-graph:demo` Expected: Act 1
      shows the resolved id + caller `login`; Act 2 shows `verifySymbolOp true`,
      `fn refreshToken()` + `refreshToken();`, same id, one `history` entry; Act
      3 shows the secret path listed but `resolve` null.

- [ ] **Step 4: Typecheck** — `moon run example-semantic-graph:typecheck`.

- [ ] **Step 5: Commit**

```bash
git add examples/semantic-graph
git commit -m "docs(graph): runnable demo — query, one-op rename, bounded graph

examples/semantic-graph enacts the three acts: query code as a graph, rename
a symbol as one signed op that renders across every reference (identity
preserved), and a graph that stops at the capability boundary.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Update the convergence docs (ARCHITECTURE + CHANGELOG), incl. P10 fix

Flip Pillar 08 to built, redeem the two P08 IOUs, add the new deferred entries —
and correct the stale Pillar 10 row (it shipped but the table still says
planned).

**Files:**

- Modify: `ARCHITECTURE.md` (P08 row `planned → built`; **P10 row
  `planned → built`, package `review`**; `graph` note on the `Op` primitive row)
- Modify: `CHANGELOG.md` (`[Unreleased] → Added` for P08; move the two P08 IOUs
  out of Deferred; add the new P08 deferred entries; add the missing P10/review
  release bullet if absent)

- [ ] **Step 1: `ARCHITECTURE.md` — status rows.** Change the Pillar 08 row from
      `| 08 Semantic graph | _(planned)_ | planned | P14 P5 P18 |` to
      `| 08 Semantic graph | `graph` | built | P14 P5 P18 |`. In the same pass,
      change the Pillar 10 row from `_(planned)_ | planned` to
      `` `review` ``/`built` (queued housekeeping — PRs #15–17 shipped it). Add
      a `graph` consumer note to the `Op` shared-primitive row's "Reused by"
      cell.

- [ ] **Step 2: `CHANGELOG.md` — Added.** Under `[Unreleased] → Added`, after
      the last package bullet, add the P08 release note (SymbolGraph over a
      Workspace; stable Symbol.id in a SymbolLedger; rename-symbol as one signed
      SymbolOp rendered across every reference; the Extractor seam +
      single-language HeuristicExtractor; decryption-bounded). If no
      `@thaddeus.run/review` (P10) bullet exists, add it too (reputation-tier
      gate, test/proof gate, standing human veto).

- [ ] **Step 3: `CHANGELOG.md` — Deferred ledger.** Remove the two existing P08
      scope-cut IOUs (**Rename/move as a first-class op (P08)**, **Symbol-level
      addressing (P08)**) — they shipped. Add new P08 deferred entries:
      multi-language / real parser (→research), type edges & structural ops
      beyond rename, whole-program call graph, per-symbol capability scope
      (P08×P01/P02), SymbolOp durability / federation, structural
      conflict-as-function (→P10).

- [ ] **Step 4: Format** — `moon run root:format`.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: mark Pillar 08 (semantic graph) built; correct Pillar 10 row

Flip P08 planned→built (@thaddeus.run/graph); redeem the two P08 IOUs
(rename-as-op, symbol-level addressing) and ledger the new deferrals. Also
correct the stale Pillar 10 row (review-as-policy shipped in PRs #15-17 but
the table still said planned).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Full-workspace verification

Run the repo-wide baseline so the new package, the integration extension, the
demo, and the docs land green together.

- [ ] **Step 1: Build the whole workspace** — `moon run :build` (lets type-aware
      lint resolve `@thaddeus.run/graph` through its `dist`).
- [ ] **Step 2: Format and lint** — `moon run root:format root:lint`.
- [ ] **Step 3: Typecheck affected** —
      `moon run graph:typecheck integration:typecheck example-semantic-graph:typecheck`.
- [ ] **Step 4: Affected tests** —
      `AGENT=1 moon run graph:test integration:test`.
- [ ] **Step 5: Confirm nothing regressed** — `AGENT=1 moon run :test`.
- [ ] **Step 6: Run the demo once more** —
      `CI= moon run example-semantic-graph:demo`.
- [ ] **Step 7: Final commit (only if format/lint produced changes)**

```bash
git add -A
git commit -m "chore(graph): repo-wide format/lint pass for Pillar 08

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(If `git status` is clean after Step 2, skip this commit.)

---

## Notes for the implementer

- **Why almost no new code:** the graph is a projection of `Workspace` text and
  the rename renders through `Workspace.write`/`commit`. The only genuinely new
  code is the `Extractor` heuristic, the `SymbolLedger` (stable-id mint +
  rebind), the read-model assembly in `#model`, and the `SymbolOp` record +
  `SymbolOpLog` — both copied from `op.ts`/`provenance.ts`/`provenancelog.ts`.
- **Decryption-bounded for free:** never re-check capabilities in `graph`. A
  `workspace.read` that returns `null` means the file is undecryptable or
  absent; skip it. The Task 2 "ungranted def is invisible" test pins this.
- **Identity is in the ledger, not the bytes:** the id is minted once from the
  birth `(path, name, kind)` and retained via `rebind`. The Task 4 "identity
  survived" assertion (`resolve('refreshToken') === id`) is the load-bearing one
  — if it fails, rename is minting a new symbol.
- **One `SymbolOp`, N text ops:** `rename` returns exactly one `symbolOp` and
  the `Workspace.commit` ops. The Task 4/5 assertions pin "one signed op" +
  "rendered everywhere"; keep them.
- **The extractor and name-resolution are loose interior.** If the `#model`
  name→id resolution reads awkwardly, use the simpler two-pass `Map<name,id>`
  form (Task 2 implementer note). Do not change the public read-method behavior
  or the tests.
- **`bun install` after every `package.json` change** (Tasks 1, 5, 6) so
  workspace symlinks resolve before build/test.
- **Signed-record fidelity:** `symbolop.ts` must match `op.ts` exactly — domain
  tag, `assertCanonical` (throw on empty/malformed), `id = blake3(canonical)`,
  fail-closed `verify` with the id check. The Task 3 "tampering fails closed"
  and "empty field throws" tests pin this.
- **Determinism:** tests use `Identity.create()` (fresh keys) but assert only on
  structural facts (resolved ids equal, verified/invalid, rendered text, sorted
  order), never on specific key or id bytes — so they are reproducible.
