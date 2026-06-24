# Pillar 06 — Platform (landing-as-policy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@thaddeus.run/platform` — named repos (scopes) created in one
call, and `land`: re-point a shared view (`main`) to include a workspace's
committed heads, gated by a pluggable policy, fail-closed — then reroute the
north-star so the seeded edit lands under policy and is asserted mirror-servable
(staying 5 pass / 0 todo).

**Architecture:** A new package with two source modules. `policy.ts` holds the
landing types (`LandProposal`/`LandPolicy`/`LandDecision`/`LandResult`) and
three policies (`allowAll`, `blockOnConflict`, `requireVerifiedProvenance`) —
the seam Pillar 10 later fills. `platform.ts` holds `Platform`
(`createRepo`/`open`/ `repos`) and `Repo` (owns its own `OpLog` + `Store`, seeds
`main`, exposes `.log`/`.store` so the existing `Workspace` opens over it
unchanged). `land` dry-runs the merge on a throwaway view
(`OpLog.view(tmp, mergedHeads)`), builds a `LandProposal` (conflicts via
`OpLog.conflicts`, incoming ops via an ancestor-closure diff over
`OpLog.ops`/`heads`), runs the policy, and re-points the target **only** on
allow. It signs nothing — the ops were already signed by the workspace's
`commit` (P05); landing is one re-point under a gate.

**Tech Stack:** TypeScript (ESM, `type: module`), Bun test runner, moon task
runner, tsdown bundler. No new runtime dependencies and **no crypto of its own**
— all signing/encryption was done upstream by `log`/`store`.

## Global Constraints

- **Spec:** `docs/specs/2026-06-24-thaddeus-pillar-06-platform-design.md` is the
  source of truth for this plan.
- **Landing is the only operation that re-points a shared view (rigid).** A
  `Workspace` commits to its own private view; `main` advances **only** through
  `Repo.land`. `land` computes
  `mergedHeads = sorted(dedup(heads(into) ∪ heads(from)))` and, on allow, calls
  `log.view(into, mergedHeads)`.
- **`land` decides on a throwaway dry-run view and is fail-closed (rigid).** It
  re-points a temporary view to `mergedHeads`, builds the `LandProposal` there,
  runs the policy, and re-points `into` **only** if `decision.allow`. A rejected
  landing leaves `into`'s heads unchanged — no rollback path.
- **P06 surfaces conflicts; it does not resolve them.** `land` reports P03
  `conflicts` in the proposal and re-points to the merged head-set;
  `materialize` yields P03's LWW winner. Whether a conflict blocks is the
  **policy's** call (`blockOnConflict` rejects; `allowAll` lands). No 3-way
  content merge.
- **The policy is a pure predicate over a proposal — the Pillar 10 seam.**
  `LandPolicy = (LandProposal) => LandDecision | Promise<LandDecision>`. P06
  ships three; richer review/reputation gates are P10 over the same shape.
- **A landable workspace is opened with an explicit `name`.** `Workspace` does
  not expose its private view name, so `land({ from })` takes the `name` the
  caller passed to `Workspace.open(..., { name })`. Name your branch to land it.
- **A `Repo` owns its own `OpLog` + `Store`** (hard isolation). The existing
  `Workspace` opens over `repo.log`/`repo.store` with no change to
  `@thaddeus.run/fs`.
- **Deferred (out of scope, do not build):** the throughput envelope,
  discoverability-as-query, typed `Release` objects, mirror/peer transport &
  federation, 3-way content merge, repository-as-capability-scoped-slice,
  throwaway-view GC. Spike: in-memory, single process.
- **Tooling:** use `bun` (never npm/pnpm/npx). Run tasks through moon:
  `moon run <project>:<task>`. Export `AGENT=1` for AI-friendly test output.
  Preserve trailing newlines. Commit messages follow Conventional Commits 1.0.0.
- **Naming:** package is `@thaddeus.run/platform` (neutral, product-agnostic);
  primary exports `Platform`, `Repo`. The vision file uses "Strata"; package
  names never use `strata-`.
- **Verification baseline after code changes:** `moon run root:format root:lint`
  plus the affected `moonx platform:typecheck` and `moonx platform:test`.

---

### Task 1: Scaffold `@thaddeus.run/platform` and the policy seam

Create the package skeleton (copying `packages/fs`'s exact config shape) and
`policy.ts`: the landing types and the three policies. Policies are pure
predicates, so they are tested in isolation here; `Platform`/`Repo`/`land`
arrive in Tasks 2–3.

**Files:**

- Create: `packages/platform/package.json`
- Create: `packages/platform/moon.yml`
- Create: `packages/platform/tsconfig.json`
- Create: `packages/platform/tsdown.config.ts`
- Create: `packages/platform/README.md`
- Create: `packages/platform/LICENSE.md` (copy of `packages/log/LICENSE.md`)
- Create: `packages/platform/src/policy.ts`
- Create: `packages/platform/src/index.ts`
- Test: `packages/platform/test/policy.test.ts`

**Interfaces:**

- Consumes: `Op`, `Conflict` (types) from `@thaddeus.run/log`; `ProvenanceLog`
  (type) from `@thaddeus.run/provenance`.
- Produces (later tasks rely on these exact signatures):
  - `interface LandProposal { readonly into: string; readonly intoHeads: readonly string[]; readonly incomingHeads: readonly string[]; readonly mergedHeads: readonly string[]; readonly incomingOps: readonly Op[]; readonly conflicts: readonly Conflict[]; }`
  - `interface LandDecision { readonly allow: boolean; readonly reason?: string; }`
  - `type LandPolicy = (p: LandProposal) => LandDecision | Promise<LandDecision>;`
  - `interface LandResult { readonly landed: boolean; readonly into: string; readonly heads: readonly string[]; readonly conflicts: readonly Conflict[]; readonly reason?: string; }`
  - `const allowAll: LandPolicy`
  - `const blockOnConflict: LandPolicy`
  - `function requireVerifiedProvenance(prov: ProvenanceLog): LandPolicy`

- [ ] **Step 1: Create the package config files**

`packages/platform/package.json`:

```json
{
  "name": "@thaddeus.run/platform",
  "version": "0.0.0",
  "description": "The platform: named repos (scopes) with one-call creation and landing-as-policy — re-point a shared view to include a workspace's commits, gated by a pluggable policy. Pillar 06.",
  "keywords": [
    "platform",
    "repository",
    "landing",
    "merge-policy",
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
    "directory": "packages/platform"
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
    "prepublishOnly": "moon run platform:prepublish"
  },
  "dependencies": {
    "@thaddeus.run/log": "workspace:*",
    "@thaddeus.run/store": "workspace:*"
  },
  "devDependencies": {
    "@thaddeus.run/fs": "workspace:*",
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/provenance": "workspace:*",
    "@types/bun": "catalog:",
    "@typescript/native-preview": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:"
  }
}
```

> **Dependency note:** `@thaddeus.run/log` and `@thaddeus.run/store` are runtime
> dependencies because the code uses `OpLog` and `MemoryStore` as **values**
> (`new OpLog(...)`, `new MemoryStore()` in Task 2). `identity` (the `Identity`
> type), `provenance` (the `ProvenanceLog` type), and `fs` (the `Workspace`
> value, used only in tests/demo) are **devDependencies**.

`packages/platform/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

language: 'typescript'
layer: 'library'
tags: ['tsdown', 'publishable']
```

`packages/platform/tsconfig.json`:

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

`packages/platform/tsdown.config.ts`:

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

`packages/platform/README.md`:

```markdown
# @thaddeus.run/platform

The platform for **Strata** (working name) — Pillar 06.

A `Platform` allocates named repos (scopes) in one call (`createRepo`) or by
bare reference (`open` auto-vivifies). A `Repo` owns its own operation log +
store and a `main` shared view; the `@thaddeus.run/fs` `Workspace` opens over it
unchanged.

`Repo.land` is **landing-as-policy**: it re-points a shared view to include a
workspace's committed heads, gated by a pluggable `LandPolicy`, surfacing P03
conflicts and **failing closed** (a rejected landing leaves the target
untouched). Ships `allowAll`, `blockOnConflict`, and `requireVerifiedProvenance`
— the seam Pillar 10 fills with review and reputation gates.

> **Status: spike.** In-memory, single process. The throughput envelope,
> discoverability-as-query, typed releases, and mirror/peer transport are
> deferred (see the design spec).
```

- [ ] **Step 2: Copy the license**

```bash
cp packages/log/LICENSE.md packages/platform/LICENSE.md
```

- [ ] **Step 3: Install so workspace symlinks resolve**

Run: `bun install` Expected: completes without error;
`node_modules/@thaddeus.run/platform` symlink is created.

- [ ] **Step 4: Write the failing test**

`packages/platform/test/policy.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import type { Conflict, Op } from '@thaddeus.run/log';
import { OpLog } from '@thaddeus.run/log';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  allowAll,
  blockOnConflict,
  type LandProposal,
  requireVerifiedProvenance,
} from '../src/policy';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// A proposal with no conflicts and no incoming ops, overridable per test.
function proposal(over: Partial<LandProposal> = {}): LandProposal {
  return {
    into: 'main',
    intoHeads: [],
    incomingHeads: [],
    mergedHeads: [],
    incomingOps: [],
    conflicts: [],
    ...over,
  };
}

const aConflict: Conflict = {
  path: 'src/rate.rs',
  ops: ['op-a', 'op-b'],
  winner: 'op-b',
};

describe('policy — allowAll / blockOnConflict', () => {
  test('allowAll always allows, even with conflicts', async () => {
    expect(await allowAll(proposal({ conflicts: [aConflict] }))).toEqual({
      allow: true,
    });
  });

  test('blockOnConflict allows a clean proposal', async () => {
    expect(await blockOnConflict(proposal())).toEqual({ allow: true });
  });

  test('blockOnConflict rejects when conflicts exist, naming the path', async () => {
    const d = await blockOnConflict(proposal({ conflicts: [aConflict] }));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('src/rate.rs');
  });
});

describe('policy — requireVerifiedProvenance', () => {
  test('allows when every incoming op has a verified provenance record', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const op = await log.write('main', 'a.rs', enc('fn a() {}'), author);
    const prov = new ProvenanceLog(store);
    await prov.record(
      op,
      { intent: 'add a', reasoning: 'feature', actorKind: 'agent:test@1' },
      author
    );

    const d = await requireVerifiedProvenance(prov)(
      proposal({ incomingOps: [op] })
    );
    expect(d.allow).toBe(true);
  });

  test('rejects an incoming op with no provenance record', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const op: Op = await log.write('main', 'b.rs', enc('fn b() {}'), author);
    const prov = new ProvenanceLog(store); // never records anything

    const d = await requireVerifiedProvenance(prov)(
      proposal({ incomingOps: [op] })
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('verified provenance');
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `AGENT=1 moon run platform:test` Expected: FAIL — cannot resolve
`../src/policy` (module not yet created).

- [ ] **Step 6: Write `policy.ts` and `index.ts`**

`packages/platform/src/policy.ts`:

```ts
import type { Conflict, Op } from '@thaddeus.run/log';
import type { ProvenanceLog } from '@thaddeus.run/provenance';

// A proposed landing, computed on a dry-run view before any policy decision.
export interface LandProposal {
  readonly into: string; // the shared target view (e.g. 'main')
  readonly intoHeads: readonly string[]; // target heads before the landing
  readonly incomingHeads: readonly string[]; // the source view's heads
  readonly mergedHeads: readonly string[]; // sorted(dedup(into ∪ from))
  readonly incomingOps: readonly Op[]; // from's closure minus into's, ordered
  readonly conflicts: readonly Conflict[]; // same-path collisions in the merged set
}

// A policy's verdict on a proposal. `reason` surfaces in LandResult on reject.
export interface LandDecision {
  readonly allow: boolean;
  readonly reason?: string;
}

// The policy seam: the exact point Pillar 10 fills with review/reputation gates.
export type LandPolicy = (
  p: LandProposal
) => LandDecision | Promise<LandDecision>;

// The outcome of a land() call. `landed === false` ⇒ `into` is untouched.
export interface LandResult {
  readonly landed: boolean;
  readonly into: string;
  readonly heads: readonly string[]; // into's heads after (unchanged if rejected)
  readonly conflicts: readonly Conflict[];
  readonly reason?: string; // the policy's reason when landed === false
}

// Always allow. Any conflict is left for LWW to resolve and conflicts() to show.
export const allowAll: LandPolicy = () => ({ allow: true });

// The safe default: reject a landing that would collide on a path, leaving the
// target clean. Names the colliding paths in the reason.
export const blockOnConflict: LandPolicy = (p) =>
  p.conflicts.length === 0
    ? { allow: true }
    : {
        allow: false,
        reason: `${p.conflicts.length} conflict(s): ${p.conflicts
          .map((c) => c.path)
          .join(', ')}`,
      };

// A taste of Pillar 10: merge gated on a signed "why", not a human reading a
// diff. Allow iff EVERY incoming op has at least one verified P04 record.
export function requireVerifiedProvenance(prov: ProvenanceLog): LandPolicy {
  return (p) => {
    const missing = p.incomingOps.filter(
      (op) => !prov.forOp(op.id).some((rec) => prov.status(rec) === 'verified')
    );
    return missing.length === 0
      ? { allow: true }
      : {
          allow: false,
          reason: `${missing.length} op(s) lack a verified provenance record`,
        };
  };
}
```

`packages/platform/src/index.ts`:

```ts
export { allowAll, blockOnConflict, requireVerifiedProvenance } from './policy';
export type {
  LandDecision,
  LandPolicy,
  LandProposal,
  LandResult,
} from './policy';
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `AGENT=1 moon run platform:test` Expected: PASS — all five policy tests
green.

- [ ] **Step 8: Typecheck and build**

Run: `moon run platform:typecheck && moon run platform:build` Expected: both
succeed; `packages/platform/dist/index.js` and `index.d.ts` exist.

- [ ] **Step 9: Commit**

```bash
git add packages/platform bun.lock
git commit -m "feat(platform): the landing policy seam (Pillar 06)

New package @thaddeus.run/platform. policy.ts defines the landing types
(LandProposal/LandPolicy/LandDecision/LandResult) and three policies:
allowAll, blockOnConflict (the default), and requireVerifiedProvenance —
the pure-predicate seam Pillar 10 later fills with review and reputation
gates.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 2: `Platform` + `Repo` shells (scopes, isolation)

Add `platform.ts`: `Platform` (`createRepo`/`open`/`repos`) and `Repo` (owns its
own `OpLog` + `Store`, seeds `main`, exposes
`.log`/`.store`/`heads`/`conflicts`). `land` arrives in Task 3.

**Files:**

- Create: `packages/platform/src/platform.ts`
- Modify: `packages/platform/src/index.ts` (export `Platform`, `Repo`)
- Test: `packages/platform/test/platform.test.ts`

**Interfaces:**

- Consumes: `OpLog`, `Conflict` from `@thaddeus.run/log`; `MemoryStore`, `Store`
  from `@thaddeus.run/store`.
- Produces (Task 3 relies on these):
  - `class Repo` with `readonly name: string`, `readonly log: OpLog`,
    `readonly store: Store`, `heads(view?: string): readonly string[]`,
    `conflicts(view?: string): readonly Conflict[]`, and a public constructor
    `new Repo(name: string, log: OpLog, store: Store)`.
  - `class Platform` with `createRepo(name: string): Repo`,
    `open(name: string): Repo`, `repos(): readonly string[]`.

- [ ] **Step 1: Write the failing test**

`packages/platform/test/platform.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Platform } from '../src/platform';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('Platform — scopes', () => {
  test('createRepo seeds an empty main and is idempotent on name', () => {
    const platform = new Platform();
    const a = platform.createRepo('acme/web');
    expect(a.name).toBe('acme/web');
    expect(a.heads('main')).toEqual([]);
    expect(platform.createRepo('acme/web')).toBe(a); // same instance, no re-alloc
  });

  test('open auto-vivifies an absent repo (bare-push trick); repos() lists sorted', () => {
    const platform = new Platform();
    platform.createRepo('acme/web');
    const v = platform.open('acme/agent-run-8f2a'); // never created
    expect(v.name).toBe('acme/agent-run-8f2a');
    expect(platform.repos()).toEqual(['acme/agent-run-8f2a', 'acme/web']);
  });

  test('repos own isolated logs: an op in one is absent from another', async () => {
    const platform = new Platform();
    const a = platform.createRepo('a');
    const b = platform.createRepo('b');
    const author = Identity.create();
    const op = await a.log.write('main', 'x.rs', enc('x'), author);

    expect(a.log.verify(op.id)).toBe(true);
    expect(b.log.verify(op.id)).toBe(false); // distinct log, never saw it
    expect(a.store).not.toBe(b.store); // distinct stores
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENT=1 moon run platform:test` Expected: FAIL — cannot resolve
`../src/platform`.

- [ ] **Step 3: Write `platform.ts`**

`packages/platform/src/platform.ts`:

```ts
import type { Conflict, OpLog } from '@thaddeus.run/log';
import { OpLog as OpLogClass } from '@thaddeus.run/log';
import { MemoryStore, type Store } from '@thaddeus.run/store';

// A named home: its own op-log + store and a seeded `main` shared view. The
// @thaddeus.run/fs Workspace opens over repo.log/repo.store unchanged. Spike —
// in-memory, single process, not durable, not concurrency-safe.
export class Repo {
  readonly name: string;
  readonly log: OpLog;
  readonly store: Store;

  constructor(name: string, log: OpLog, store: Store) {
    this.name = name;
    this.log = log;
    this.store = store;
  }

  // A shared view's current heads (P03 passthrough).
  heads(view?: string): readonly string[] {
    return this.log.heads(view);
  }

  // Same-path collisions in a view's reachable set (P03 passthrough).
  conflicts(view?: string): readonly Conflict[] {
    return this.log.conflicts(view);
  }
}

// The platform: scopes come into being in one call (P11). A scope is a Repo.
export class Platform {
  readonly #repos: Map<string, Repo> = new Map();

  // Allocate a scope in one call (~ms, no wizard). Idempotent: re-creating an
  // existing name returns the existing repo. Seeds an empty `main` view.
  createRepo(name: string): Repo {
    const existing = this.#repos.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const store = new MemoryStore();
    const log = new OpLogClass(store);
    log.view('main', []); // seed an explicit, empty shared view
    const repo = new Repo(name, log, store);
    this.#repos.set(name, repo);
    return repo;
  }

  // Return the repo, auto-vivifying it if absent — the "a bare push brings the
  // scope into being" trick. A fleet stands up thousands in a loop, one call
  // each.
  open(name: string): Repo {
    return this.#repos.get(name) ?? this.createRepo(name);
  }

  // The scope registry, in deterministic (sorted) order.
  repos(): readonly string[] {
    return [...this.#repos.keys()].sort();
  }
}
```

> **Note:** `OpLog` is imported both as a type (`OpLog`, for the `Repo.log`
> field) and as a value under the alias `OpLogClass` (for
> `new OpLogClass(...)`). A single value import would also work; the alias keeps
> the field type and the constructor visibly distinct. `Conflict` is used only
> by `conflicts()`'s return type.

- [ ] **Step 4: Update `index.ts` to export the new classes**

`packages/platform/src/index.ts` — add the platform exports (keep the existing
policy exports):

```ts
export { Platform, Repo } from './platform';
export { allowAll, blockOnConflict, requireVerifiedProvenance } from './policy';
export type {
  LandDecision,
  LandPolicy,
  LandProposal,
  LandResult,
} from './policy';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `AGENT=1 moon run platform:test` Expected: PASS — policy + platform tests
green.

- [ ] **Step 6: Typecheck and build**

Run: `moon run platform:typecheck && moon run platform:build` Expected: both
succeed.

- [ ] **Step 7: Commit**

```bash
git add packages/platform
git commit -m "feat(platform): Platform + Repo — one-call scopes, hard isolation

Platform.createRepo allocates a scope in one call (idempotent) and seeds
an empty main; open() auto-vivifies (the bare-push trick); repos() lists
them sorted. Each Repo owns its own OpLog + Store, so the existing
Workspace opens over repo.log/repo.store unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 3: `Repo.land` — dry-run, decide, re-point (fail-closed)

Add `land`: compute the merged head-set, dry-run it on a throwaway view to build
the `LandProposal` (conflicts + incoming-op diff), run the policy, and re-point
the target **only** on allow.

**Files:**

- Modify: `packages/platform/src/platform.ts` (add `land`, the incoming-op diff,
  and helpers; add imports)
- Test: `packages/platform/test/land.test.ts`

**Interfaces:**

- Consumes: `Op` from `@thaddeus.run/log`; `Identity` (type) from
  `@thaddeus.run/identity`; `blockOnConflict`, `LandPolicy`, `LandResult` from
  `./policy`.
- Produces:
  `land(opts: { from: string; into?: string; author: Identity; policy?: LandPolicy }): Promise<LandResult>`
  on `Repo`.

- [ ] **Step 1: Write the failing test**

`packages/platform/test/land.test.ts`:

```ts
import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { allowAll } from '../src/policy';
import { Platform, type Repo } from '../src/platform';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// Open a NAMED workspace over the repo, stage one write, and commit it onto a
// landable private view. Returns the view name to pass to land({ from }).
async function branch(
  repo: Repo,
  name: string,
  path: string,
  body: string,
  author: Identity
): Promise<string> {
  const ws = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: author,
    name,
  });
  ws.write(path, enc(body));
  await ws.commit(author);
  return name;
}

describe('Repo.land — landing as policy', () => {
  test('a clean land re-points main and materializes the edit', async () => {
    const repo = new Platform().createRepo('acme/web');
    const dev = Identity.create();
    await branch(repo, 'feat/login', 'src/login.rs', 'fn login() {}', dev);

    const result = await repo.land({ from: 'feat/login', author: dev });
    expect(result.landed).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(repo.heads('main')).toEqual(result.heads);
    expect(repo.log.materialize('main').has('src/login.rs')).toBe(true);
  });

  test('blockOnConflict (default): the second same-path land is rejected, main untouched', async () => {
    const repo = new Platform().createRepo('acme/api');
    const alice = Identity.create();
    const bob = Identity.create();
    await branch(repo, 'alice/rate', 'src/rate.rs', 'fn rate() { 100 }', alice);
    await branch(repo, 'bob/rate', 'src/rate.rs', 'fn rate() { 200 }', bob);

    const first = await repo.land({ from: 'alice/rate', author: alice });
    expect(first.landed).toBe(true);
    const mainAfterFirst = repo.heads('main');

    const second = await repo.land({ from: 'bob/rate', author: bob });
    expect(second.landed).toBe(false);
    expect(second.reason).toContain('src/rate.rs');
    // Fail-closed: main's heads are exactly what they were before the reject.
    expect(repo.heads('main')).toEqual(mainAfterFirst);
    expect(dec((await readMain(repo, 'src/rate.rs', alice))!)).toBe(
      'fn rate() { 100 }'
    );
  });

  test('allowAll lands the conflicting second; conflicts() surfaces the LWW collision', async () => {
    const repo = new Platform().createRepo('acme/api2');
    const alice = Identity.create();
    const bob = Identity.create();
    await branch(repo, 'alice/rate', 'src/rate.rs', 'fn rate() { 100 }', alice);
    await branch(repo, 'bob/rate', 'src/rate.rs', 'fn rate() { 200 }', bob);

    await repo.land({ from: 'alice/rate', author: alice });
    const second = await repo.land({
      from: 'bob/rate',
      author: bob,
      policy: allowAll,
    });
    expect(second.landed).toBe(true);
    const collisions = repo.conflicts('main');
    expect(collisions.map((c) => c.path)).toContain('src/rate.rs');
  });

  test('incomingOps = from-closure minus into-closure; landed op is mirror-servable', async () => {
    const repo = new Platform().createRepo('acme/web2');
    const dev = Identity.create();
    const ws = Workspace.open(repo.log, repo.store, {
      source: 'main',
      reader: dev,
      name: 'feat/x',
    });
    ws.write('src/x.rs', enc('fn x() {}'));
    const [op] = await ws.commit(dev);

    // Capture the proposal via a custom policy, then allow.
    let seen = 0;
    const result = await repo.land({
      from: 'feat/x',
      author: dev,
      policy: (p) => {
        seen = p.incomingOps.length;
        expect(p.incomingOps[0]?.id).toBe(op?.id);
        return { allow: true };
      },
    });
    expect(seen).toBe(1); // exactly the one new op
    expect(result.landed).toBe(true);

    // Mirror property: the landed op is ciphertext a public mirror can serve.
    expect(op?.payload).not.toBeNull();
    if (op?.payload != null) {
      expect(repo.store.verify(op.payload.id)).toBe(true);
    }
    if (op != null) {
      expect(repo.log.publicView(op.id).kind).toBe('open');
    }
  });
});

// Read a path from main as `who`, returning null on absent/undecryptable.
async function readMain(
  repo: Repo,
  path: string,
  who: Identity
): Promise<Uint8Array | null> {
  const entry = repo.log.materialize('main', who).get(path);
  if (entry === undefined || entry.ref === null) {
    return null;
  }
  return repo.store.get(entry.ref, who);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENT=1 moon run platform:test` Expected: FAIL —
`repo.land is not a function`.

- [ ] **Step 3: Add `land` and helpers to `platform.ts`**

In `packages/platform/src/platform.ts`, extend the imports:

```ts
import type { Identity } from '@thaddeus.run/identity';
import type { Conflict, Op, OpLog } from '@thaddeus.run/log';
import { OpLog as OpLogClass } from '@thaddeus.run/log';
import { MemoryStore, type Store } from '@thaddeus.run/store';

import { blockOnConflict, type LandPolicy, type LandResult } from './policy';
```

Add a module-scope counter and two helpers above the `Repo` class:

```ts
// Process-local counter for unique throwaway dry-run view names.
let landSeq = 0;

// Sorted, de-duplicated union of two head-sets — the proposed merged frontier.
// Sorted so the result is independent of which side is `into` vs `from`.
function mergeHeads(
  a: readonly string[],
  b: readonly string[]
): readonly string[] {
  return [...new Set([...a, ...b])].sort();
}

// Every op reachable from `heads` by walking parents, inclusive of the heads.
function closure(byId: Map<string, Op>, heads: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...heads];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const op = byId.get(id);
    if (op !== undefined) {
      stack.push(...op.parents);
    }
  }
  return seen;
}
```

Add this method to the `Repo` class (after `conflicts`):

```ts
  // Land a workspace's committed view onto a shared view, gated by policy.
  // Dry-runs the merge on a throwaway view to build the proposal, runs the
  // policy, and re-points `into` ONLY on allow (fail-closed: a rejected landing
  // leaves into's heads unchanged). Signs nothing — the ops were already signed
  // by the workspace's commit (P05); landing is one re-point under a gate.
  async land(opts: {
    from: string;
    into?: string;
    author: Identity;
    policy?: LandPolicy;
  }): Promise<LandResult> {
    const into = opts.into ?? 'main';
    const policy = opts.policy ?? blockOnConflict;
    const intoHeads = this.log.heads(into);
    const incomingHeads = this.log.heads(opts.from);
    const mergedHeads = mergeHeads(intoHeads, incomingHeads);

    // Dry-run on a throwaway view; `into` is untouched until the policy allows.
    const tmp = `land/${into}/${landSeq++}`;
    this.log.view(tmp, mergedHeads);
    const conflicts = this.log.conflicts(tmp);

    // incomingOps = from's closure minus into's closure, in (lamport, id) order.
    const byId = new Map(this.log.ops().map((o) => [o.id, o]));
    const intoClosure = closure(byId, intoHeads);
    const fromClosure = closure(byId, incomingHeads);
    const incomingOps = this.log
      .ops()
      .filter((o) => fromClosure.has(o.id) && !intoClosure.has(o.id));

    const decision = await policy({
      into,
      intoHeads,
      incomingHeads,
      mergedHeads,
      incomingOps,
      conflicts,
    });
    if (!decision.allow) {
      return { landed: false, into, heads: intoHeads, conflicts, reason: decision.reason };
    }
    // The single re-point that IS the landing.
    this.log.view(into, mergedHeads);
    return { landed: true, into, heads: mergedHeads, conflicts };
  }
```

> **Note:** `this.log.ops()` is called twice (once to build `byId`, once to
> filter) — both return the same deterministic `(lamport, id)` order, so the
> filtered `incomingOps` preserve it. The throwaway `tmp` view is intentionally
> left in the log's view map (no GC — a named spike non-goal, spec §11).

- [ ] **Step 4: Run the test to verify it passes**

Run: `AGENT=1 moon run platform:test` Expected: PASS — policy + platform + land
tests green.

- [ ] **Step 5: Typecheck and build**

Run: `moon run platform:typecheck && moon run platform:build` Expected: both
succeed.

- [ ] **Step 6: Commit**

```bash
git add packages/platform
git commit -m "feat(platform): Repo.land — landing as policy, fail-closed

land() computes the merged head-set, dry-runs it on a throwaway view to
build the proposal (P03 conflicts + the incoming-op closure diff), runs
the policy, and re-points the target ONLY on allow. A rejected landing
leaves the target untouched. The landed op stays mirror-servable
(store.verify + log.publicView). This is 'where landing gets its policy'.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 4: Reroute the north-star — the `policy` and `mirror` stages

Change the seeded one-edit flow so the edit originates in a `Workspace` over a
`Repo` and **lands into `main` under policy** (the `policy` stage), then assert
the landed op is **mirror-servable** (the `mirror` stage). The flow stays 5 pass
/ 0 todo.

**Files:**

- Modify: `integration/package.json` (add the `@thaddeus.run/platform`
  dependency)
- Modify: `integration/test/one-edit-end-to-end.test.ts` (add import; replace
  the first test body)

**Interfaces:**

- Consumes: `Platform`, `blockOnConflict` from `@thaddeus.run/platform`;
  `Workspace` from `@thaddeus.run/fs`; existing `Identity` already imported.

- [ ] **Step 1: Add the dependency**

Edit `integration/package.json` `dependencies` to include the platform package
(keep alphabetical order — `platform` sorts between `log` and `provenance`):

```json
  "dependencies": {
    "@thaddeus.run/fs": "workspace:*",
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/log": "workspace:*",
    "@thaddeus.run/platform": "workspace:*",
    "@thaddeus.run/provenance": "workspace:*",
    "@thaddeus.run/store": "workspace:*"
  },
```

- [ ] **Step 2: Install so the new dep resolves**

Run: `bun install` Expected: completes without error.

- [ ] **Step 3: Add the import**

Edit the top of `integration/test/one-edit-end-to-end.test.ts`. Add, immediately
after the existing `import { Workspace } from '@thaddeus.run/fs';` line:

```ts
import { blockOnConflict, Platform } from '@thaddeus.run/platform';
```

> **Import order:** `oxlint`/`oxfmt` sort imports alphabetically by module path;
> `@thaddeus.run/platform` sorts after `@thaddeus.run/log`. If the formatter
> reorders the block on `root:format`, accept its order.

- [ ] **Step 4: Replace the first test body**

In `integration/test/one-edit-end-to-end.test.ts`, replace this test:

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

with:

```ts
test('P05/P06/P01: an edit originates in a Workspace, lands into main under policy → a mirror serves it', async () => {
  const repo = new Platform().createRepo('acme/web');
  const author = Identity.create();

  // The edit enters Strata through the virtual filesystem on a NAMED, landable
  // branch: stage a write in a copy-on-write workspace, then commit it.
  const ws = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: author,
    name: 'feat/refresh',
  });
  ws.write('src/auth.rs', new TextEncoder().encode('fn refresh() {}'));
  const [op] = await ws.commit(author);

  // The policy stage: land the branch into main under blockOnConflict.
  const result = await repo.land({
    from: 'feat/refresh',
    into: 'main',
    author,
    policy: blockOnConflict,
  });
  expect(result.landed).toBe(true);
  expect(repo.log.materialize('main').has('src/auth.rs')).toBe(true);

  // The mirror stage: the landed op's payload is mirror-verifiable ciphertext,
  // and the op is fully servable to a public mirror (not embargoed).
  expect(op).toBeDefined();
  expect(op?.payload).not.toBeNull();
  if (op?.payload != null) {
    expect(repo.store.verify(op.payload.id)).toBe(true);
  }
  if (op != null) {
    expect(repo.log.publicView(op.id).kind).toBe('open');
  }
});
```

> **Note:** `MemoryStore` and `OpLog` remain imported — the other four tests
> still construct their own. Do not remove those imports.

- [ ] **Step 5: Run the north-star suite to verify it passes**

Run: `AGENT=1 moon run integration:test` Expected: PASS — 5 tests pass, 0 todo;
the first test now exercises `Workspace` → `Repo.land` → mirror.

- [ ] **Step 6: Commit**

```bash
git add integration
git commit -m "test(integration): the seeded edit lands under policy, mirror serves it (P06)

Reroute the north-star's first step through @thaddeus.run/platform: the
edit originates in a named Workspace over a Repo, lands into main under
blockOnConflict (the policy stage), and the landed op is asserted
mirror-servable via store.verify + log.publicView (the mirror stage).
Closes the two stages ARCHITECTURE.md names. Flow stays 5 pass / 0 todo.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 5: The platform demo (`examples/platform/`)

Add a runnable CLI demo (sibling to `examples/workspace/`) enacting the four
acts from spec §9: one-call scopes, a clean land, a policy-blocked land (and a
provenance gate), and the mirror property.

**Files:**

- Create: `examples/platform/package.json`
- Create: `examples/platform/moon.yml`
- Create: `examples/platform/tsconfig.json`
- Create: `examples/platform/src/platform.ts`

**Interfaces:**

- Consumes: `Workspace` from `@thaddeus.run/fs`; `Identity`, `ready` from
  `@thaddeus.run/identity`; `ProvenanceLog` from `@thaddeus.run/provenance`;
  `Platform`, `blockOnConflict`, `requireVerifiedProvenance` from
  `@thaddeus.run/platform`.

- [ ] **Step 1: Create the example config files**

`examples/platform/package.json`:

```json
{
  "name": "@thaddeus.run/example-platform",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@thaddeus.run/fs": "workspace:*",
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/platform": "workspace:*",
    "@thaddeus.run/provenance": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "catalog:"
  }
}
```

`examples/platform/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

id: 'example-platform'
language: 'typescript'
layer: 'application'

tasks:
  # No test suite yet; keep `moon run :test` green repo-wide.
  test:
    args: '--pass-with-no-tests'

  # Build-graph-connected, so CI-skipped; run in agent shells with a CI= prefix.
  demo:
    command: 'bun src/platform.ts'
    deps:
      - '^:build'
    options:
      cache: false
      runInCI: 'skip'
```

`examples/platform/tsconfig.json`:

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

`examples/platform/src/platform.ts`:

```ts
// Platform demo for @thaddeus.run/platform (Pillar 06).
// Run: CI= moon run example-platform:demo
//
// Four acts: (1) scopes in one call — createRepo + bare-push open + a fleet
// loop; (2) landing as policy — two branches on different paths both land;
// (3) policy blocks — a same-path conflict is rejected by blockOnConflict, and
// a provenance gate rejects an op with no verified "why"; (4) the mirror
// property — a landed op is ciphertext a public mirror can serve.

import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import {
  blockOnConflict,
  Platform,
  type Repo,
  requireVerifiedProvenance,
} from '@thaddeus.run/platform';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const rule = (): void => console.log('—'.repeat(60));

// Open a named, landable branch over a repo, stage one write, commit it.
async function branch(
  repo: Repo,
  name: string,
  path: string,
  body: string,
  author: Identity
): Promise<void> {
  const ws = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: author,
    name,
  });
  ws.write(path, enc(body));
  await ws.commit(author);
}

await ready();
const platform = new Platform();
const alice = Identity.create();
const bob = Identity.create();

// Act 1 — scopes in one call.
const web = platform.createRepo('acme/web');
platform.open('acme/agent-run-8f2a'); // bare-push: brought into being by reference
for (const id of ['8f2a', '9c1b', 'a4d3']) {
  platform.open(`fleet/run-${id}`);
}
rule();
console.log('1. scopes created in code — one call each, no wizard:');
console.log('   repos:', platform.repos());

// Act 2 — landing as policy (clean, different paths).
await branch(web, 'alice/login', 'src/login.rs', 'fn login() {}', alice);
await branch(web, 'bob/signup', 'src/signup.rs', 'fn signup() {}', bob);
const la = await web.land({ from: 'alice/login', author: alice });
const lb = await web.land({ from: 'bob/signup', author: bob });
rule();
console.log('2. two branches land cleanly under blockOnConflict:');
console.log(`   alice landed: ${la.landed}, bob landed: ${lb.landed}`);
console.log(
  '   main now holds:',
  [...web.log.materialize('main').keys()].sort()
);

// Act 3a — policy blocks a same-path conflict.
const api = platform.createRepo('acme/api');
await branch(api, 'alice/rate', 'src/rate.rs', 'fn rate() { 100 }', alice);
await branch(api, 'bob/rate', 'src/rate.rs', 'fn rate() { 200 }', bob);
const first = await api.land({ from: 'alice/rate', author: alice });
const second = await api.land({ from: 'bob/rate', author: bob });
rule();
console.log('3a. a same-path conflict is rejected (fail-closed):');
console.log(
  `   first landed: ${first.landed}; second landed: ${second.landed}`
);
console.log(`   reason: ${second.reason}`);

// Act 3b — a provenance gate.
const docs = platform.createRepo('acme/docs');
const wd = Workspace.open(docs.log, docs.store, {
  source: 'main',
  reader: alice,
  name: 'alice/readme',
});
wd.write('README.md', enc('# Strata'));
const [readmeOp] = await wd.commit(alice);
const prov = new ProvenanceLog(docs.store);
const gate = requireVerifiedProvenance(prov);
const noWhy = await docs.land({
  from: 'alice/readme',
  author: alice,
  policy: gate,
});
if (readmeOp != null) {
  await prov.record(
    readmeOp,
    {
      intent: 'add README',
      reasoning: 'docs',
      actorKind: 'agent:claude-code@1.2',
    },
    alice
  );
}
const withWhy = await docs.land({
  from: 'alice/readme',
  author: alice,
  policy: gate,
});
rule();
console.log('3b. requireVerifiedProvenance — merge gated on a signed "why":');
console.log(`   no provenance → landed: ${noWhy.landed} (${noWhy.reason})`);
console.log(`   with a verified record → landed: ${withWhy.landed}`);

// Act 4 — the mirror property.
rule();
console.log('4. a landed op is ciphertext a public mirror can serve:');
if (readmeOp?.payload != null) {
  console.log(
    '   store.verify(payload):',
    docs.store.verify(readmeOp.payload.id)
  );
}
if (readmeOp != null) {
  console.log('   publicView kind:', docs.log.publicView(readmeOp.id).kind);
}

rule();
console.log('Acceptance: scopes are one call; landing is a re-point under a');
console.log('policy that fails closed; the landed op stays mirror-servable.');
```

- [ ] **Step 3: Install and run the demo**

Run: `bun install && CI= moon run example-platform:demo` Expected: prints four
acts; Act 1 lists 5 repos; Act 2 shows `alice landed: true, bob landed: true`
and main holding both files; Act 3a shows
`first landed: true; second landed: false` with a `src/rate.rs` reason; Act 3b
shows `no provenance → landed: false` then
`with a verified record → landed: true`; Act 4 shows
`store.verify(payload): true` and `publicView kind: open`.

- [ ] **Step 4: Typecheck the example**

Run: `moon run example-platform:typecheck` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/platform
git commit -m "docs(platform): runnable demo — scopes, landing-as-policy, mirror

examples/platform enacts the four acts: one-call scopes (createRepo +
bare-push open + a fleet loop), two clean lands, a policy-blocked land and
a provenance-gated land, and the mirror property of a landed op.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 6: Update the convergence docs (ARCHITECTURE + CHANGELOG)

Flip the Pillar 06 row to built and record the release, per spec §12. (The
deferred ledger already carries the P06 cuts — only the landing item is updated
to note P06 ships the platform half.)

**Files:**

- Modify: `ARCHITECTURE.md` (Pillar 06 status row; `Op` shared-primitive row)
- Modify: `CHANGELOG.md` (`[Unreleased] → Added`; the landing deferred item)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `ARCHITECTURE.md` — status row**

In the **Status / traceability** table, change the Pillar 06 row from:

```
| 06 Platform                           | _(planned)_          | planned | P9 P10 P11       |
```

to:

```
| 06 Platform                           | `platform`           | built   | P9 P10 P11       |
```

- [ ] **Step 2: Update `ARCHITECTURE.md` — shared-primitives row**

In the **Shared primitives** table, update the `Op (operation log entry)` row's
"Reused by" cell to include P06 landing. Change:

```
| Op (operation log entry)              | `@thaddeus.run/log`      | P03 · P04 · P05 · P08 · P10                             |
```

to:

```
| Op (operation log entry)              | `@thaddeus.run/log`      | P03 · P04 · P05 · P06 · P08 · P10                       |
```

(The column widths are reflowed by the formatter in Step 4 — don't hand-align.)

- [ ] **Step 3: Update `CHANGELOG.md` — the Added entry**

Under `## [Unreleased]` → `### Added`, after the existing `@thaddeus.run/fs`
bullet, add:

```markdown
- `@thaddeus.run/platform` — the platform (Pillar 06): named repos (scopes) with
  one-call `createRepo` and bare-push `open` (auto-vivify), each owning its own
  op-log + store so the `Workspace` opens over it unchanged. `Repo.land` is
  **landing-as-policy**: it dry-runs a merge on a throwaway view, runs a
  pluggable `LandPolicy`, and re-points the shared view **only on allow**
  (fail-closed). Ships `allowAll`, `blockOnConflict` (default), and
  `requireVerifiedProvenance` — the seam Pillar 10 fills. The north-star's
  seeded edit now lands into `main` under policy and is asserted mirror-servable
  (`store.verify` + `log.publicView`), closing the spine's `policy` and `mirror`
  stages (5 pass / 0 todo).
```

- [ ] **Step 4: Update `CHANGELOG.md` — the landing deferred item**

In the **Deferred → Scope-cut** ledger, replace the existing landing item:

```markdown
- **Landing / merge onto a shared view (P05→P06/P10).** `commit` lands ops on
  the workspace's private view; re-pointing a shared view like `main` to include
  them (and the conflict resolution that implies) is platform/review territory.
```

with (P06 now ships the platform half; rich review policy is still owed to P10):

```markdown
- **Rich review/reputation merge policy (P06→P10).** P06 ships landing as a
  re-point gated by a pluggable `LandPolicy` (`allowAll`, `blockOnConflict`,
  `requireVerifiedProvenance`); the semantic/behavioral-diff, test/proof, and
  reputation-tier gates — and the standing human veto — are Pillar 10 over the
  same `LandProposal → LandDecision` seam.
```

- [ ] **Step 5: Format the docs**

Run: `moon run root:format` Expected: succeeds; Markdown tables/lists reflow
consistently (oxfmt may adjust spacing — that is fine).

- [ ] **Step 6: Commit**

```bash
git add ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: mark Pillar 06 (platform) built; changelog + deferred ledger

Flip the Pillar 06 row planned→built (@thaddeus.run/platform); add P06 to
the Op primitive's reuse list. Record the release under Added and narrow
the landing deferral to the rich review/reputation policy still owed to
Pillar 10.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 7: Full-workspace verification

Run the repo-wide baseline so the new package, the integration reroute, the
demo, and the docs all land green together.

**Files:** none (verification only).

- [ ] **Step 1: Build the whole workspace**

Run: `moon run :build` Expected: every package builds, including
`@thaddeus.run/platform`. (This lets type-aware lint resolve the new package
through its `dist`.)

- [ ] **Step 2: Format and lint the repo**

Run: `moon run root:format root:lint` Expected: both succeed with no errors.

- [ ] **Step 3: Typecheck the affected projects**

Run:
`moon run platform:typecheck integration:typecheck example-platform:typecheck`
Expected: all PASS.

- [ ] **Step 4: Run the affected tests**

Run: `AGENT=1 moon run platform:test integration:test` Expected: all PASS — the
platform suite green (Tasks 1–3); integration 5 pass / 0 todo.

- [ ] **Step 5: Confirm nothing else regressed**

Run: `AGENT=1 moon run :test` Expected: the full repo test run is green.

- [ ] **Step 6: Run the demo once more end-to-end**

Run: `CI= moon run example-platform:demo` Expected: the four acts print as in
Task 5 Step 3.

- [ ] **Step 7: Final commit (only if formatting/lint produced changes)**

```bash
git add -A
git commit -m "chore(platform): repo-wide format/lint pass for Pillar 06

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

(If `git status` is clean after Step 2, skip this commit.)

---

## Notes for the implementer

- **Why almost no new code:** landing is mostly composition.
  `OpLog.view(tmp, heads)` gives the zero-copy dry-run; `OpLog.conflicts(tmp)`
  surfaces collisions; `OpLog.view(into, heads)` is the landing itself;
  `OpLog.ops()`/parents give the incoming-op diff; `Store.verify` +
  `OpLog.publicView` give the mirror property (spec §4.1). The only genuinely
  new code is the `Platform`/`Repo` shells, the `land` envelope, and the three
  policies.
- **Fail-closed is structural, not a code path.** `land` never touches `into`
  until `decision.allow` is true — it builds the proposal on a throwaway view.
  Do not "re-point then roll back"; the Task 3 fail-closed test pins that
  `into`'s heads are unchanged after a reject.
- **Landing signs nothing.** The ops were signed by the workspace's `commit`
  (P05). `land` only changes which head-set a named view points at. If you find
  yourself calling `log.write` inside `land`, stop — that is a bug.
- **A landable workspace needs an explicit `name`.** `Workspace` hides its
  private view, so open it with `{ name }` and pass that same name to
  `land({ from })`. The demo and the north-star both do this.
- **Conflicts are surfaced, not resolved.** `land` reports `conflicts` and
  re-points to the merged head-set; LWW (P03) decides the materialized winner.
  `blockOnConflict` is the _policy_ that turns a conflict into a rejection — the
  mechanism never merges content.
- **`bun install` after every `package.json` change** (Tasks 1, 4, 5) so
  workspace symlinks resolve before you build or test.
- **Runtime vs type-only deps.** `log` and `store` are runtime deps
  (`new OpLog`, `new MemoryStore`); `identity`, `provenance`, and `fs` are
  devDependencies (types in `src`, values only in tests/demo).
- **Determinism:** tests use `Identity.create()` (fresh keys) but assert only on
  structural facts (landed/rejected, heads equality, materialized paths,
  conflict paths, `publicView` kind), never on specific key bytes — so they are
  reproducible.
