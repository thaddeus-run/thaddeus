# Pillar 09 — Agents as Principals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@thaddeus.run/agent` — an operator-signed `Delegation` (scoped,
budgeted authority granted to an agent `did:key`), an `AgentRegistry`
enforcement authority (verified grants + quarantine + meter), and
`delegationPolicy` (a fail-closed `LandPolicy` enforcing scope + budget +
quarantine at `Repo.land`) — then wire it into the north-star (an agent lands
under its delegation; revocation quarantines it), taking the flow to 7 pass / 0
todo.

**Architecture:** A new package with three source modules. `delegation.ts`
defines the `Delegation` record and `canonicalDelegation`/`signDelegation`/
`verifyDelegation` (one operator signature over a domain-tagged core, the
operator did derived from the signer — mirroring `@thaddeus.run/reputation`).
`registry.ts` is the `AgentRegistry`: it **rejects invalid grants** (unlike the
keep-and-label reputation log), tracks a quarantine set and a per-agent meter.
`policy.ts` is `delegationPolicy(registry)`, a `LandPolicy` that rejects an
incoming op whose author is revoked, undelegated, out of path-scope, or over
budget — plugging into P06's `Repo.land({ policy })` seam. It is read-only on
the meter; the caller `record`s spend after a successful land.

**Tech Stack:** TypeScript (ESM, `type: module`), Bun test runner, moon task
runner, tsdown bundler. Runtime dep `@thaddeus.run/identity` only; **no crypto
of its own** — signing/verifying delegate to `identity`.

## Global Constraints

- **Spec:** `docs/specs/2026-06-25-thaddeus-pillar-09-agents-design.md` is the
  source of truth for this plan.
- **One operator-signed `Delegation` (rigid).** Fields
  `{ agent, paths, maxChanges, maxSpend }`; the record adds `operator` (derived
  from the signer) and `sig`. Domain tag `thaddeus.delegation.v1`; canonical
  tuple `(operator, agent, paths, maxChanges, maxSpend)`. `verifyDelegation` is
  fail-soft (bad did/sig/non-canonical → false, never throws).
- **`AgentRegistry` is an enforcement authority (rigid).** `register` **verifies
  and throws** on an invalid delegation — a forged grant confers nothing (unlike
  `ReputationLog`'s keep-and-label). One active delegation per agent.
- **Enforcement is a fail-closed `LandPolicy`, read-only on the meter (rigid).**
  `delegationPolicy(registry)` rejects an incoming op whose author is revoked,
  has no delegation, touches a path outside the delegation's globs, or would
  exceed `maxChanges`/`maxSpend`. It never mutates the meter (dry-run safe); the
  caller calls `registry.record(agent, spend)` after a successful land.
- **Revocation has two halves.** `registry.revoke(agent)` quarantines (the
  policy rejects its ops); content-key rotation is the existing `store.revoke`
  (P01), shown only in the demo. The package owns the quarantine half.
- **Composes existing surfaces only.** Runtime: `@thaddeus.run/identity`
  (`PublicIdentity.fromDid` value). Type-only: `@thaddeus.run/platform`
  (`LandPolicy`, `LandProposal`) and `@thaddeus.run/log` (`Op`, transitively via
  `LandProposal`). No package source is modified.
- **Path-glob matcher.** `matchGlob`: `**` matches all; `prefix/**` matches any
  path under `prefix/`; otherwise exact equality. An op is in scope iff ANY glob
  matches its `path`.
- **Budget is a total count cap + caller-reported spend.** `maxChanges` caps the
  agent's lifetime op count on the in-memory meter (must be a non-negative
  integer); `maxSpend` caps caller-reported `spend`. No per-hour windowing
  (needs wall-clock), no `Date`/`Math.random`.
- **Deferred (out of scope, do not build):** reputation score/tiers (→P10),
  economy/paid attestation, per-symbol scope (→P08), per-hour rate windowing,
  sub-delegation chains, time-expiry (`not_after`), persistence, network. Spike:
  in-memory, single process.
- **Tooling:** use `bun` (never npm/pnpm/npx). Run tasks through moon. Export
  `AGENT=1` for tests. Preserve trailing newlines. Commit messages follow
  Conventional Commits 1.0.0.
- **Naming:** package is `@thaddeus.run/agent`; primary exports `Delegation`,
  `signDelegation`/`verifyDelegation`/`canonicalDelegation`, `AgentRegistry`,
  `delegationPolicy`. The vision file uses "Thaddeus"; package names never use
  `Thaddeus-`.
- **Verification baseline after code changes:** `moon run root:format root:lint`
  plus the affected `moonx agent:typecheck` and `moonx agent:test`.

---

### Task 1: Scaffold `@thaddeus.run/agent` and the `Delegation` record

Create the package skeleton (copying `packages/reputation`'s config shape) and
`delegation.ts`: the record, its canonical encoding, and operator sign/verify.
`AgentRegistry` (Task 2) and `delegationPolicy` (Task 3) follow.

**Files:**

- Create: `packages/agent/package.json`
- Create: `packages/agent/moon.yml`
- Create: `packages/agent/tsconfig.json`
- Create: `packages/agent/tsdown.config.ts`
- Create: `packages/agent/README.md`
- Create: `packages/agent/LICENSE.md` (copy of `packages/log/LICENSE.md`)
- Create: `packages/agent/src/delegation.ts`
- Create: `packages/agent/src/index.ts`
- Test: `packages/agent/test/delegation.test.ts`

**Interfaces:**

- Consumes: `Identity`, `PublicIdentity` from `@thaddeus.run/identity`.
- Produces (later tasks rely on these exact signatures):
  - `interface DelegationFields { readonly agent: string; readonly paths: readonly string[]; readonly maxChanges: number; readonly maxSpend: number; }`
  - `interface Delegation extends DelegationFields { readonly operator: string; readonly sig: Uint8Array; }`
  - `function canonicalDelegation(core: DelegationFields & { operator: string }): Uint8Array`
  - `function signDelegation(fields: DelegationFields, operator: Identity): Delegation`
  - `function verifyDelegation(d: Delegation): boolean`

- [ ] **Step 1: Create the package config files**

`packages/agent/package.json`:

```json
{
  "name": "@thaddeus.run/agent",
  "version": "0.0.0",
  "description": "Agents as first-class principals: operator-signed Delegations (scoped, budgeted authority) and a fail-closed LandPolicy enforcing scope, budget, and quarantine. Pillar 09.",
  "keywords": [
    "agent",
    "identity",
    "capability",
    "delegation",
    "Thaddeus",
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
    "directory": "packages/agent"
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
    "prepublishOnly": "moon run agent:prepublish"
  },
  "dependencies": {
    "@thaddeus.run/identity": "workspace:*"
  },
  "devDependencies": {
    "@thaddeus.run/log": "workspace:*",
    "@thaddeus.run/platform": "workspace:*",
    "@thaddeus.run/store": "workspace:*",
    "@types/bun": "catalog:",
    "@typescript/native-preview": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:"
  }
}
```

> **Dependency note:** `@thaddeus.run/identity` is the only runtime dependency
> (`PublicIdentity.fromDid` is used as a value in `verifyDelegation`).
> `@thaddeus.run/platform` (`LandPolicy`/`LandProposal` types) and
> `@thaddeus.run/log` (`Op`, referenced transitively by `LandProposal`) are
> type-only in `src`; together with `@thaddeus.run/store` they are also used as
> values in tests (to build real ops/proposals) — so all three are
> devDependencies.

`packages/agent/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

language: 'typescript'
layer: 'library'
tags: ['tsdown', 'publishable']
```

`packages/agent/tsconfig.json`:

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

`packages/agent/tsdown.config.ts`:

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

`packages/agent/README.md`:

```markdown
# @thaddeus.run/agent

Agents as first-class principals for **Thaddeus** (working name) — Pillar 09.

An agent is a `did:key`, distinct from the human who operates it. An operator
signs a `Delegation` — a scoped, budgeted grant of authority (`paths`,
`maxChanges`, `maxSpend`) — that makes a change by the agent verifiably
attributable to the operator. `AgentRegistry` holds verified delegations, a
quarantine set, and a per-agent meter; it rejects forged grants.
`delegationPolicy` is a fail-closed `LandPolicy`: at `Repo.land` it rejects an
op whose author is revoked, undelegated, out of scope, or over budget —
substrate-enforced, not by hope. Revocation is `registry.revoke` (quarantine)
plus `store.revoke` (key rotation, P01).

> **Status: spike.** In-memory, single process. Reputation tiers (P10), the paid
> economy leg, per-symbol scope (P08), and per-hour rate limits are deferred
> (see the design spec).
```

- [ ] **Step 2: Copy the license**

```bash
cp packages/log/LICENSE.md packages/agent/LICENSE.md
```

- [ ] **Step 3: Install so workspace symlinks resolve**

Run: `bun install` Expected: completes without error;
`node_modules/@thaddeus.run/agent` symlink is created.

- [ ] **Step 4: Write the failing test**

`packages/agent/test/delegation.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  type DelegationFields,
  signDelegation,
  verifyDelegation,
} from '../src/delegation';

beforeAll(async () => {
  await ready();
});

const FIELDS: DelegationFields = {
  agent: 'did:key:zAgentPlaceholder',
  paths: ['src/**'],
  maxChanges: 5,
  maxSpend: 100,
};

describe('Delegation — sign & verify', () => {
  test('a freshly signed delegation verifies, with the operator did derived', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const d = signDelegation({ ...FIELDS, agent: agent.did }, operator);
    expect(verifyDelegation(d)).toBe(true);
    expect(d.operator).toBe(operator.did);
    expect(d.agent).toBe(agent.did);
    expect(d.paths).toEqual(['src/**']);
  });

  test('tampering any covered field breaks the signature', () => {
    const operator = Identity.create();
    const other = Identity.create();
    const d = signDelegation(FIELDS, operator);
    expect(verifyDelegation({ ...d, agent: 'did:key:zEvil' })).toBe(false);
    expect(verifyDelegation({ ...d, paths: ['**'] })).toBe(false);
    expect(verifyDelegation({ ...d, maxChanges: 999 })).toBe(false);
    expect(verifyDelegation({ ...d, maxSpend: 999 })).toBe(false);
    expect(verifyDelegation({ ...d, operator: other.did })).toBe(false);
  });

  test('a malformed operator did fails soft (false), never throws', () => {
    const operator = Identity.create();
    const d = signDelegation(FIELDS, operator);
    expect(verifyDelegation({ ...d, operator: 'did:key:notvalid' })).toBe(
      false
    );
  });

  test('signDelegation rejects non-canonical fields', () => {
    const operator = Identity.create();
    expect(() => signDelegation({ ...FIELDS, paths: [] }, operator)).toThrow();
    expect(() =>
      signDelegation({ ...FIELDS, maxChanges: -1 }, operator)
    ).toThrow();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `AGENT=1 moon run agent:test` Expected: FAIL — cannot resolve
`../src/delegation` (module not yet created).

- [ ] **Step 6: Write `delegation.ts` and `index.ts`**

`packages/agent/src/delegation.ts`:

```ts
import { type Identity, PublicIdentity } from '@thaddeus.run/identity';

// The signable grant: who is authorized, scoped to which paths, with what caps.
export interface DelegationFields {
  readonly agent: string; // did:key of the agent being authorized
  readonly paths: readonly string[]; // globs the agent may touch, e.g. ['src/**']
  readonly maxChanges: number; // cap on # of ops the agent may land (total)
  readonly maxSpend: number; // cap on caller-reported spend (abstract units)
}

// A signed delegation: the operator authorizes the agent to act for them. The
// operator did is derived from the signer, so it cannot be claimed unsigned.
export interface Delegation extends DelegationFields {
  readonly operator: string; // = operator.did
  readonly sig: Uint8Array; // operator's signature over the canonical core
}

// Domain tag prefixed into the signed tuple so a delegation signature can never
// be confused with an op / provenance / contribution signature.
const DELEGATION_DOMAIN = 'thaddeus.delegation.v1';

type DelegationCore = DelegationFields & { readonly operator: string };

// Reject non-canonical field values before they are signed. Mirrors op.ts /
// provenance.ts: bad input throws, so signDelegation fails fast and
// verifyDelegation (try/catch) renders such records false.
function assertCanonical(core: DelegationCore): void {
  for (const [name, value] of [
    ['operator', core.operator],
    ['agent', core.agent],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`delegation.${name} must be a non-empty string`);
    }
  }
  if (
    !Array.isArray(core.paths) ||
    core.paths.length === 0 ||
    core.paths.some((p) => typeof p !== 'string' || p.length === 0)
  ) {
    throw new TypeError(
      'delegation.paths must be a non-empty array of non-empty strings'
    );
  }
  if (
    typeof core.maxChanges !== 'number' ||
    !Number.isFinite(core.maxChanges) ||
    core.maxChanges < 0
  ) {
    throw new TypeError('delegation.maxChanges must be a finite number >= 0');
  }
  if (
    typeof core.maxSpend !== 'number' ||
    !Number.isFinite(core.maxSpend) ||
    core.maxSpend < 0
  ) {
    throw new TypeError('delegation.maxSpend must be a finite number >= 0');
  }
}

// Deterministic bytes the operator's signature covers: the domain tag followed
// by the core fields in a fixed order. Throws on non-canonical input.
export function canonicalDelegation(core: DelegationCore): Uint8Array {
  assertCanonical(core);
  return new TextEncoder().encode(
    JSON.stringify([
      DELEGATION_DOMAIN,
      core.operator,
      core.agent,
      [...core.paths],
      core.maxChanges,
      core.maxSpend,
    ])
  );
}

// Build a signed delegation; the operator did is derived from the signer.
export function signDelegation(
  fields: DelegationFields,
  operator: Identity
): Delegation {
  const core: DelegationCore = { ...fields, operator: operator.did };
  return {
    ...fields,
    operator: operator.did,
    sig: operator.sign(canonicalDelegation(core)),
  };
}

// Verify the operator's signature over the canonical core. Fail-soft: a
// malformed did, wrong-length sig, or non-canonical field yields false.
export function verifyDelegation(d: Delegation): boolean {
  try {
    return PublicIdentity.fromDid(d.operator).verify(
      canonicalDelegation(d),
      d.sig
    );
  } catch {
    return false;
  }
}
```

`packages/agent/src/index.ts`:

```ts
export {
  canonicalDelegation,
  signDelegation,
  verifyDelegation,
} from './delegation';
export type { Delegation, DelegationFields } from './delegation';
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `AGENT=1 moon run agent:test` Expected: PASS — all four delegation tests
green.

- [ ] **Step 8: Typecheck and build**

Run: `moon run agent:typecheck && moon run agent:build` Expected: both succeed;
`packages/agent/dist/index.js` and `index.d.ts` exist.

- [ ] **Step 9: Commit**

```bash
git add packages/agent bun.lock
git commit -m "feat(agent): operator-signed Delegation record (Pillar 09)

New package @thaddeus.run/agent. delegation.ts defines the Delegation
record and canonicalDelegation/signDelegation/verifyDelegation: the
operator signs a domain-tagged core (operator, agent, paths, maxChanges,
maxSpend) with the operator did derived from the signer. verifyDelegation
is fail-soft. Composes only @thaddeus.run/identity.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 2: `AgentRegistry` — the enforcement authority

Add `registry.ts`: verified-grant storage (rejects forgeries), a quarantine set,
and a per-agent meter.

**Files:**

- Create: `packages/agent/src/registry.ts`
- Modify: `packages/agent/src/index.ts` (export `AgentRegistry`, `Usage`)
- Test: `packages/agent/test/registry.test.ts`

**Interfaces:**

- Consumes: `Delegation`, `verifyDelegation` from `./delegation`.
- Produces:
  - `interface Usage { readonly changes: number; readonly spend: number; }`
  - `class AgentRegistry` with `register(d: Delegation): void`,
    `revoke(agent: string): void`, `isRevoked(agent: string): boolean`,
    `delegationFor(agent: string): Delegation | undefined`,
    `operatorOf(agent: string): string | undefined`,
    `usage(agent: string): Usage`,
    `record(agent: string, spend?: number): void`.

- [ ] **Step 1: Write the failing test**

`packages/agent/test/registry.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { type Delegation, signDelegation } from '../src/delegation';
import { AgentRegistry } from '../src/registry';

beforeAll(async () => {
  await ready();
});

function grant(operator: Identity, agent: Identity): Delegation {
  return signDelegation(
    { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 100 },
    operator
  );
}

describe('AgentRegistry', () => {
  test('register stores a verified delegation; delegationFor / operatorOf resolve it', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(grant(operator, agent));
    expect(reg.delegationFor(agent.did)?.operator).toBe(operator.did);
    expect(reg.operatorOf(agent.did)).toBe(operator.did);
    expect(reg.operatorOf('did:key:zUnknown')).toBeUndefined();
  });

  test('register throws on an invalid (forged) delegation', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const stray = Identity.create();
    // Forge: keep the operator did but replace the sig with a stray key's.
    const forged: Delegation = {
      ...grant(operator, agent),
      sig: stray.sign(new Uint8Array([1, 2, 3])),
    };
    const reg = new AgentRegistry();
    expect(() => reg.register(forged)).toThrow();
    expect(reg.delegationFor(agent.did)).toBeUndefined();
  });

  test('revoke quarantines an agent', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(grant(operator, agent));
    expect(reg.isRevoked(agent.did)).toBe(false);
    reg.revoke(agent.did);
    expect(reg.isRevoked(agent.did)).toBe(true);
  });

  test('usage starts at zero; record increments changes and spend', () => {
    const reg = new AgentRegistry();
    expect(reg.usage('did:key:zA')).toEqual({ changes: 0, spend: 0 });
    reg.record('did:key:zA', 4);
    reg.record('did:key:zA');
    expect(reg.usage('did:key:zA')).toEqual({ changes: 2, spend: 4 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENT=1 moon run agent:test` Expected: FAIL — cannot resolve
`../src/registry`.

- [ ] **Step 3: Write `registry.ts`**

`packages/agent/src/registry.ts`:

```ts
import { type Delegation, verifyDelegation } from './delegation';

// An agent's running totals against its delegation caps.
export interface Usage {
  readonly changes: number;
  readonly spend: number;
}

// The enforcement authority: verified delegations + a quarantine set + a
// per-agent meter. Unlike ReputationLog (keep-and-label), this REJECTS invalid
// grants — a forged delegation confers nothing. Spike — in-memory, single
// process.
export class AgentRegistry {
  readonly #grants: Map<string, Delegation> = new Map();
  readonly #quarantine: Set<string> = new Set();
  readonly #meter: Map<string, { changes: number; spend: number }> = new Map();

  // Verify and store a delegation (one active per agent; re-register replaces).
  // Throws TypeError on an invalid delegation.
  register(d: Delegation): void {
    if (!verifyDelegation(d)) {
      throw new TypeError(
        `refusing to register an invalid delegation for ${d.agent}`
      );
    }
    this.#grants.set(d.agent, d);
  }

  // Quarantine an agent: delegationPolicy then rejects all its ops at land.
  revoke(agent: string): void {
    this.#quarantine.add(agent);
  }

  isRevoked(agent: string): boolean {
    return this.#quarantine.has(agent);
  }

  // The active (verified) delegation for an agent, or undefined.
  delegationFor(agent: string): Delegation | undefined {
    return this.#grants.get(agent);
  }

  // Attribution: the operator did the agent acts for, or undefined.
  operatorOf(agent: string): string | undefined {
    return this.#grants.get(agent)?.operator;
  }

  // Metered totals (default { changes: 0, spend: 0 }).
  usage(agent: string): Usage {
    const u = this.#meter.get(agent);
    return u === undefined
      ? { changes: 0, spend: 0 }
      : { changes: u.changes, spend: u.spend };
  }

  // After a successful land: +1 change and += spend for the agent. The policy
  // never calls this — recording is the caller's post-land step.
  record(agent: string, spend = 0): void {
    const u = this.#meter.get(agent) ?? { changes: 0, spend: 0 };
    this.#meter.set(agent, { changes: u.changes + 1, spend: u.spend + spend });
  }
}
```

- [ ] **Step 4: Update `index.ts`**

`packages/agent/src/index.ts` — add the registry exports (keep the delegation
exports):

```ts
export {
  canonicalDelegation,
  signDelegation,
  verifyDelegation,
} from './delegation';
export type { Delegation, DelegationFields } from './delegation';
export { AgentRegistry } from './registry';
export type { Usage } from './registry';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `AGENT=1 moon run agent:test` Expected: PASS — delegation + registry tests
green.

- [ ] **Step 6: Typecheck and build**

Run: `moon run agent:typecheck && moon run agent:build` Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add packages/agent
git commit -m "feat(agent): AgentRegistry — verified grants, quarantine, meter

register verifies and rejects forged delegations (an enforcement
authority, not keep-and-label); revoke quarantines; delegationFor /
operatorOf resolve the grant and attribution; usage / record meter an
agent's changes and caller-reported spend.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 3: `delegationPolicy` — fail-closed enforcement as a `LandPolicy`

Add `policy.ts`: a path-glob matcher and `delegationPolicy(registry)`, which
rejects an incoming op whose author is revoked, undelegated, out of scope, or
over budget.

**Files:**

- Create: `packages/agent/src/policy.ts`
- Modify: `packages/agent/src/index.ts` (export `delegationPolicy`)
- Test: `packages/agent/test/policy.test.ts`

**Interfaces:**

- Consumes: `AgentRegistry` from `./registry`; `LandPolicy`, `LandProposal` from
  `@thaddeus.run/platform`.
- Produces: `function delegationPolicy(registry: AgentRegistry): LandPolicy`.

- [ ] **Step 1: Write the failing test**

`packages/agent/test/policy.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import type { Op } from '@thaddeus.run/log';
import type { LandProposal } from '@thaddeus.run/platform';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { signDelegation } from '../src/delegation';
import { delegationPolicy } from '../src/policy';
import { AgentRegistry } from '../src/registry';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// A LandProposal carrying exactly `ops` as the incoming set (other fields are
// unused by delegationPolicy).
function proposal(ops: readonly Op[]): LandProposal {
  return {
    into: 'main',
    intoHeads: [],
    incomingHeads: [],
    mergedHeads: [],
    incomingOps: ops,
    conflicts: [],
  };
}

// Produce a real signed op authored by `agent` at `path`.
async function op(agent: Identity, path: string): Promise<Op> {
  const log = new OpLog(new MemoryStore());
  return log.write('main', path, enc('x'), agent);
}

describe('delegationPolicy', () => {
  test('allows an in-scope op within budget', async () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(
      signDelegation(
        { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 100 },
        operator
      )
    );
    const decision = await delegationPolicy(reg)(
      proposal([await op(agent, 'src/auth.rs')])
    );
    expect(decision.allow).toBe(true);
  });

  test('rejects an op on a path outside the delegated scope', async () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(
      signDelegation(
        { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 100 },
        operator
      )
    );
    const decision = await delegationPolicy(reg)(
      proposal([await op(agent, 'secrets/key.env')])
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('secrets/key.env');
  });

  test('rejects an op from an undelegated agent', async () => {
    const agent = Identity.create();
    const reg = new AgentRegistry();
    const decision = await delegationPolicy(reg)(
      proposal([await op(agent, 'src/a.rs')])
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('no delegation');
  });

  test('rejects when landing would exceed maxChanges', async () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(
      signDelegation(
        { agent: agent.did, paths: ['src/**'], maxChanges: 1, maxSpend: 100 },
        operator
      )
    );
    reg.record(agent.did); // usage.changes = 1, already at cap
    const decision = await delegationPolicy(reg)(
      proposal([await op(agent, 'src/a.rs')])
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('budget');
  });

  test('rejects when spend is at or over maxSpend', async () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(
      signDelegation(
        { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 5 },
        operator
      )
    );
    reg.record(agent.did, 5); // usage.spend = 5 >= maxSpend
    const decision = await delegationPolicy(reg)(
      proposal([await op(agent, 'src/a.rs')])
    );
    expect(decision.allow).toBe(false);
  });

  test('rejects every op from a quarantined agent', async () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(
      signDelegation(
        { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 100 },
        operator
      )
    );
    reg.revoke(agent.did);
    const decision = await delegationPolicy(reg)(
      proposal([await op(agent, 'src/a.rs')])
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('revoked');
  });

  test('is read-only on the meter (dry-run safe)', async () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(
      signDelegation(
        { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 100 },
        operator
      )
    );
    const p = proposal([await op(agent, 'src/a.rs')]);
    await delegationPolicy(reg)(p);
    await delegationPolicy(reg)(p);
    expect(reg.usage(agent.did)).toEqual({ changes: 0, spend: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENT=1 moon run agent:test` Expected: FAIL — cannot resolve
`../src/policy`.

- [ ] **Step 3: Write `policy.ts`**

`packages/agent/src/policy.ts`:

```ts
import type { LandPolicy, LandProposal } from '@thaddeus.run/platform';

import type { AgentRegistry } from './registry';

// Minimal path glob: `**` matches everything; `prefix/**` matches any path under
// `prefix/`; otherwise the glob must equal the path exactly.
function matchGlob(glob: string, path: string): boolean {
  if (glob === '**') {
    return true;
  }
  if (glob.endsWith('/**')) {
    return path.startsWith(glob.slice(0, -2));
  }
  return glob === path;
}

// Enforcement as a LandPolicy: reject an incoming op whose author is revoked,
// undelegated, out of path-scope, or over budget. Fail-closed (like
// blockOnConflict). Read-only on the registry meter — the caller records spend
// after a successful land.
export function delegationPolicy(registry: AgentRegistry): LandPolicy {
  return (p: LandProposal) => {
    // Authorization + scope: every incoming op must be permitted.
    for (const op of p.incomingOps) {
      const agent = op.author;
      if (registry.isRevoked(agent)) {
        return { allow: false, reason: `agent ${agent} is revoked` };
      }
      const d = registry.delegationFor(agent);
      if (d === undefined) {
        return { allow: false, reason: `no delegation for agent ${agent}` };
      }
      if (!d.paths.some((glob) => matchGlob(glob, op.path))) {
        return {
          allow: false,
          reason: `${op.path} is outside ${agent}'s delegated scope`,
        };
      }
    }
    // Budget: project this landing's op count per agent against the caps.
    const countByAgent = new Map<string, number>();
    for (const op of p.incomingOps) {
      countByAgent.set(op.author, (countByAgent.get(op.author) ?? 0) + 1);
    }
    for (const [agent, count] of countByAgent) {
      const d = registry.delegationFor(agent);
      if (d === undefined) {
        continue; // unreachable: rejected in the loop above
      }
      const u = registry.usage(agent);
      if (u.changes + count > d.maxChanges) {
        return {
          allow: false,
          reason: `agent ${agent} is over its change budget`,
        };
      }
      if (u.spend >= d.maxSpend) {
        return {
          allow: false,
          reason: `agent ${agent} is over its spend budget`,
        };
      }
    }
    return { allow: true };
  };
}
```

> **Note:** `Op` is not imported — `op` is typed via `LandProposal.incomingOps`
> (`readonly Op[]`). Do not add an `Op` import to `policy.ts`; it would be
> unused and fail lint.

- [ ] **Step 4: Update `index.ts`**

`packages/agent/src/index.ts` — add the policy export:

```ts
export {
  canonicalDelegation,
  signDelegation,
  verifyDelegation,
} from './delegation';
export type { Delegation, DelegationFields } from './delegation';
export { AgentRegistry } from './registry';
export type { Usage } from './registry';
export { delegationPolicy } from './policy';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `AGENT=1 moon run agent:test` Expected: PASS — delegation + registry +
policy tests green.

- [ ] **Step 6: Typecheck and build**

Run: `moon run agent:typecheck && moon run agent:build` Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add packages/agent
git commit -m "feat(agent): delegationPolicy — fail-closed enforcement at land

delegationPolicy(registry) is a LandPolicy that rejects an incoming op
whose author is revoked, undelegated, out of path-scope (matchGlob), or
over its change/spend budget. Read-only on the meter (dry-run safe);
spend is recorded post-land by the caller. Plugs into Repo.land({ policy }).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 4: Extend the north-star — an agent lands under delegation, revocation quarantines

Add a P09 step: an operator delegates to an agent; the agent lands a change
under `delegationPolicy`; then revocation rejects a second landing. The flow
goes from 6 to 7 pass / 0 todo.

**Files:**

- Modify: `integration/package.json` (add the `@thaddeus.run/agent` dependency)
- Modify: `integration/test/one-edit-end-to-end.test.ts` (add import; add one
  new test)

**Interfaces:**

- Consumes: `AgentRegistry`, `signDelegation`, `delegationPolicy` from
  `@thaddeus.run/agent`; `Platform` from `@thaddeus.run/platform`; `Workspace`,
  `Identity` (already imported).

- [ ] **Step 1: Add the dependency**

Edit `integration/package.json` `dependencies` to include the agent package
(keep alphabetical order — `agent` sorts first):

```json
  "dependencies": {
    "@thaddeus.run/agent": "workspace:*",
    "@thaddeus.run/fs": "workspace:*",
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/log": "workspace:*",
    "@thaddeus.run/platform": "workspace:*",
    "@thaddeus.run/reputation": "workspace:*",
    "@thaddeus.run/store": "workspace:*"
  },
```

- [ ] **Step 2: Install so the new dep resolves**

Run: `bun install` Expected: completes without error.

- [ ] **Step 3: Add the import**

Edit `integration/test/one-edit-end-to-end.test.ts`. Add, as the first import
line (above `@thaddeus.run/fs`):

```ts
import {
  AgentRegistry,
  delegationPolicy,
  signDelegation,
} from '@thaddeus.run/agent';
```

> **Import order:** `oxlint`/`oxfmt` sort imports alphabetically by module path;
> `@thaddeus.run/agent` sorts first. If the formatter reorders, accept its
> order.

- [ ] **Step 4: Add the P09 north-star test**

In `integration/test/one-edit-end-to-end.test.ts`, add this test immediately
after the `P06/P07` test, inside the same `describe` block:

```ts
test('P09: an agent lands under its operator delegation; revocation quarantines it', async () => {
  const repo = new Platform().createRepo('acme/web');
  const operator = Identity.create();
  const agent = Identity.create();
  const registry = new AgentRegistry();
  registry.register(
    signDelegation(
      { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 100 },
      operator
    )
  );

  // Attribution: the change will be signed by the agent, attributed to operator.
  expect(registry.operatorOf(agent.did)).toBe(operator.did);

  // The agent lands a change within its delegated scope, under the policy.
  const ws = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: agent,
    name: 'agent/feat',
  });
  ws.write('src/auth.rs', new TextEncoder().encode('fn refresh() {}'));
  await ws.commit(agent);
  const ok = await repo.land({
    from: 'agent/feat',
    into: 'main',
    author: agent,
    policy: delegationPolicy(registry),
  });
  expect(ok.landed).toBe(true);
  registry.record(agent.did); // meter the successful land

  // Revocation quarantines the agent: a further landing is rejected.
  registry.revoke(agent.did);
  const ws2 = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: agent,
    name: 'agent/feat2',
  });
  ws2.write('src/extra.rs', new TextEncoder().encode('fn x() {}'));
  await ws2.commit(agent);
  const blocked = await repo.land({
    from: 'agent/feat2',
    into: 'main',
    author: agent,
    policy: delegationPolicy(registry),
  });
  expect(blocked.landed).toBe(false);
  expect(blocked.reason).toContain('revoked');
});
```

- [ ] **Step 5: Run the north-star suite to verify it passes**

Run: `AGENT=1 moon run integration:test` Expected: PASS — 7 tests pass, 0 todo;
the new test exercises delegation → land-under-policy → revoke → quarantine.

- [ ] **Step 6: Commit**

```bash
git add integration
git commit -m "test(integration): an agent lands under delegation; revoke quarantines (P09)

Extend the north-star: an operator delegates scoped/budgeted authority to
an agent; the agent lands a change to src/** under delegationPolicy
(landed: true, attributed to the operator); after registry.revoke, a
second landing by the agent is rejected (quarantined). Flow goes to 7
pass / 0 todo.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 5: The agent demo (`examples/agent/`)

Add a runnable CLI demo (sibling to `examples/reputation/`) enacting the four
acts from spec §9: delegate, bounded autonomy, scope/budget rejection, and the
kill switch.

**Files:**

- Create: `examples/agent/package.json`
- Create: `examples/agent/moon.yml`
- Create: `examples/agent/tsconfig.json`
- Create: `examples/agent/src/agent.ts`

**Interfaces:**

- Consumes: `Workspace` from `@thaddeus.run/fs`; `Identity`, `ready` from
  `@thaddeus.run/identity`; `Platform` from `@thaddeus.run/platform`;
  `AgentRegistry`, `signDelegation`, `verifyDelegation`, `delegationPolicy` from
  `@thaddeus.run/agent`.

- [ ] **Step 1: Create the example config files**

`examples/agent/package.json`:

```json
{
  "name": "@thaddeus.run/example-agent",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@thaddeus.run/agent": "workspace:*",
    "@thaddeus.run/fs": "workspace:*",
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/platform": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "catalog:"
  }
}
```

`examples/agent/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

id: 'example-agent'
language: 'typescript'
layer: 'application'

tasks:
  # No test suite yet; keep `moon run :test` green repo-wide.
  test:
    args: '--pass-with-no-tests'

  # Build-graph-connected, so CI-skipped; run in agent shells with a CI= prefix.
  demo:
    command: 'bun src/agent.ts'
    deps:
      - '^:build'
    options:
      cache: false
      runInCI: 'skip'
```

`examples/agent/tsconfig.json`:

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

`examples/agent/src/agent.ts`:

```ts
// Agent demo for @thaddeus.run/agent (Pillar 09).
// Run: CI= moon run example-agent:demo
//
// Four acts: (1) an operator delegates scoped, budgeted authority to an agent;
// (2) bounded autonomy — the agent lands a change within scope under the policy,
// attributed to the operator; (3) scope + budget enforced — an out-of-scope path
// and an over-budget landing are rejected; (4) the kill switch — revocation
// quarantines the agent from the converging state.

import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import {
  AgentRegistry,
  delegationPolicy,
  signDelegation,
  verifyDelegation,
} from '@thaddeus.run/agent';
import { Platform, type Repo } from '@thaddeus.run/platform';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const rule = (): void => console.log('—'.repeat(60));

// Stage one change on a named branch authored by `who`, then return its view name.
async function branch(
  repo: Repo,
  who: Identity,
  name: string,
  path: string
): Promise<string> {
  const ws = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: who,
    name,
  });
  ws.write(path, enc('fn x() {}'));
  await ws.commit(who);
  return name;
}

await ready();
const platform = new Platform();
const repo = platform.createRepo('acme/web');
const operator = Identity.create();
const agent = Identity.create();
const registry = new AgentRegistry();

// Act 1 — delegate.
const grant = signDelegation(
  { agent: agent.did, paths: ['src/**'], maxChanges: 2, maxSpend: 10 },
  operator
);
registry.register(grant);
rule();
console.log('1. operator delegates scoped, budgeted authority to the agent:');
console.log('   verifyDelegation:', verifyDelegation(grant));
console.log('   scope:', grant.paths, '| maxChanges:', grant.maxChanges);

// Act 2 — bounded autonomy.
await branch(repo, agent, 'agent/login', 'src/login.rs');
const ok = await repo.land({
  from: 'agent/login',
  author: agent,
  policy: delegationPolicy(registry),
});
registry.record(agent.did, 4);
rule();
console.log('2. the agent lands within scope, attributed to its operator:');
console.log(
  '   landed:',
  ok.landed,
  '| operator:',
  registry.operatorOf(agent.did) === operator.did
);
console.log('   usage:', registry.usage(agent.did));

// Act 3 — scope + budget enforced.
await branch(repo, agent, 'agent/secret', 'secrets/key.env');
const outOfScope = await repo.land({
  from: 'agent/secret',
  author: agent,
  policy: delegationPolicy(registry),
});
rule();
console.log('3. scope + budget are enforced at land (not by hope):');
console.log(
  '   out-of-scope landed:',
  outOfScope.landed,
  '|',
  outOfScope.reason
);

// Act 4 — kill switch.
registry.revoke(agent.did);
await branch(repo, agent, 'agent/more', 'src/more.rs');
const afterRevoke = await repo.land({
  from: 'agent/more',
  author: agent,
  policy: delegationPolicy(registry),
});
rule();
console.log('4. revocation quarantines the agent from converging state:');
console.log('   landed:', afterRevoke.landed, '|', afterRevoke.reason);
console.log(
  '   (the other half of "kill" is store.revoke — rotates its keys, P01)'
);

rule();
console.log(
  'Acceptance: authorship is signed, scoped, budgeted, and revocable;'
);
console.log('a compromised agent is one revoke() from quarantine.');
```

- [ ] **Step 3: Install and run the demo**

Run: `bun install && CI= moon run example-agent:demo` Expected: prints four
acts; Act 1 `verifyDelegation: true`; Act 2 `landed: true | operator: true` and
`usage: { changes: 1, spend: 4 }`; Act 3 `out-of-scope landed: false` with a
`secrets/key.env` reason; Act 4 `landed: false` with a `revoked` reason.

- [ ] **Step 4: Typecheck the example**

Run: `moon run example-agent:typecheck` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/agent
git commit -m "docs(agent): runnable demo — delegate, bounded autonomy, scope/budget, kill

examples/agent enacts the four acts: an operator delegates scoped,
budgeted authority; the agent lands within scope (attributed to the
operator); out-of-scope and over-budget landings are rejected; and
revocation quarantines the agent from the converging state.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 6: Update the convergence docs (ARCHITECTURE + CHANGELOG)

Flip the Pillar 09 row to built and record the release + deferred ledger
entries, per spec §12.

**Files:**

- Modify: `ARCHITECTURE.md` (Pillar 09 status row)
- Modify: `CHANGELOG.md` (`[Unreleased] → Added`; Deferred ledger)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `ARCHITECTURE.md` — status row**

In the **Status / traceability** table, change the Pillar 09 row from:

```
| 09 Agents as principals               | _(planned)_          | planned | P16 P3 P21       |
```

to:

```
| 09 Agents as principals               | `agent`              | built   | P16 P3 P21       |
```

(The `Identity` shared-primitives row already lists `P09 agents` — no change
there. The formatter reflows column widths; don't hand-align.)

- [ ] **Step 2: Update `CHANGELOG.md` — the Added entry**

Under `## [Unreleased]` → `### Added`, after the existing
`@thaddeus.run/reputation` bullet, add:

```markdown
- `@thaddeus.run/agent` — agents as first-class principals (Pillar 09): an
  operator-signed `Delegation` grants an agent `did:key` scoped, budgeted
  authority (`paths` globs, `maxChanges`, `maxSpend`), with the operator did
  derived from the signer so a change by the agent is verifiably attributed to
  its operator. `AgentRegistry` is an enforcement authority — it rejects forged
  grants (unlike the keep-and-label reputation log), holds a quarantine set, and
  meters each agent's changes/spend. `delegationPolicy(registry)` is a
  fail-closed `LandPolicy`: at `Repo.land` it rejects an op whose author is
  revoked, undelegated, out of path-scope, or over budget — substrate-enforced,
  read-only on the meter. Revocation = `registry.revoke` (quarantine) +
  `store.revoke` (key rotation, P01). The north-star now lands an agent's change
  under its delegation and quarantines it on revoke (7 pass / 0 todo).
```

- [ ] **Step 3: Update `CHANGELOG.md` — the Deferred ledger**

In the **Deferred → Scope-cut** ledger, add these entries (match the surrounding
structure):

```markdown
- **Agent reputation score / tiers (P09→P10).** P07 supplies the attested
  contribution records; the derived score that grants autonomy ("a
  high-reputation agent's change merges under policy") is Pillar 10's
  merge-policy input.
- **Agent economy / paid attestation (P09→later).** A priced third-party
  verification verdict that travels with a change, and any payment rail.
- **Per-symbol capability scope (P09→P08).** `Delegation.paths` is path-glob
  only; per-symbol scope needs the semantic graph.
- **Per-hour rate windowing & time-expiry (P09→later).** `maxChanges` is a
  lifetime count cap; per-hour rate and `not_after` delegation expiry need
  wall-clock. Sub-delegation chains are also deferred.
```

- [ ] **Step 4: Format the docs**

Run: `moon run root:format` Expected: succeeds; Markdown tables/lists reflow
consistently (oxfmt may adjust spacing — that is fine).

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: mark Pillar 09 (agents) built; changelog + deferred ledger

Flip the Pillar 09 row planned→built (@thaddeus.run/agent). Record the
release under Added and ledger the deferred items (reputation tiers→P10,
economy/paid attestation, per-symbol scope→P08, per-hour rate / time-expiry
/ sub-delegation).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 7: Full-workspace verification

Run the repo-wide baseline so the new package, the north-star step, the demo,
and the docs all land green together.

**Files:** none (verification only).

- [ ] **Step 1: Build the whole workspace**

Run: `moon run :build` Expected: every package builds, including
`@thaddeus.run/agent`. (Pre-existing/unrelated: `apps/landing` build may report
`missing_outputs` — untouched here, same as prior pillars.)

- [ ] **Step 2: Format and lint the repo**

Run: `moon run root:format root:lint` Expected: both succeed; 0 errors. (Some
pre-existing `require-await` warnings in store/log/fs are expected; no new ones
from `agent`.)

- [ ] **Step 3: Typecheck the affected projects**

Run: `moon run agent:typecheck integration:typecheck example-agent:typecheck`
Expected: all PASS.

- [ ] **Step 4: Run the affected tests**

Run: `AGENT=1 moon run agent:test integration:test` Expected: all PASS — the
agent suite green (Tasks 1–3); integration 7 pass / 0 todo.

- [ ] **Step 5: Confirm nothing else regressed**

Run: `AGENT=1 moon run :test` Expected: the full repo test run is green (0
failures across identity/store/log/provenance/fs/platform/reputation/agent/
integration).

- [ ] **Step 6: Run the demo once more end-to-end**

Run: `CI= moon run example-agent:demo` Expected: the four acts print as in Task
5 Step 3.

- [ ] **Step 7: Final commit (only if formatting/lint produced changes)**

```bash
git add -A
git commit -m "chore(agent): repo-wide format/lint pass for Pillar 09

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

(If `git status` is clean after Step 2, skip this commit.)

---

## Notes for the implementer

- **Why almost no new code:** agents-as-principals is mostly composition. The
  `Delegation` reuses the domain-tagged signed-record pattern (P04/P07);
  enforcement reuses `Repo.land`'s `LandPolicy` seam (P06); revocation's
  key-rotation half is `store.revoke` (P01). New code is the record, the
  registry (a map + a set + a meter), the policy checks, and `matchGlob`.
- **The registry rejects forgeries — that's the one difference from
  `ReputationLog`.** `register` verifies and throws; an aggregator keeps
  everything, an enforcement authority must not confer authority from an
  unverified grant. The Task 2 forged-delegation test pins this.
- **The policy is read-only on the meter.** `delegationPolicy` only _reads_
  `usage`; `record` is the caller's post-land step. The Task 3 "dry-run safe"
  test pins that calling the policy never moves the meter — so a rejected (or
  dry-run) land never consumes budget.
- **`Op` is typed transitively.** `policy.ts` does not import `Op`; `op` comes
  from `LandProposal.incomingOps`. Importing `Op` would be an unused import.
- **`bun install` after every `package.json` change** (Tasks 1, 4, 5) so
  workspace symlinks resolve before you build or test.
- **Runtime vs type-only deps.** `identity` is a runtime dep
  (`PublicIdentity.fromDid`); `platform`/`log`/`store` are devDependencies
  (types in `src`, values only in tests/demo).
- **Determinism:** tests use `Identity.create()` (fresh keys) but assert only on
  structural facts (verify booleans, allow/reject + reason substrings, usage
  counts), never on key bytes — so they are reproducible. No
  `Date`/`Math.random`.

```

```
