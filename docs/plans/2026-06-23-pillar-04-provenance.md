# Pillar 04 — Provenance (the signed "why") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@thaddeus.run/provenance` — a signed `Provenance` record bound
to an `Op.id`, with capability-gated prompt storage and a
`verified`/`unverified` trust label — completing P12 and turning the north-star
one-edit flow 5 pass / 0 todo.

**Architecture:** A new package mirroring `@thaddeus.run/log`'s shape. Two
source modules: `provenance.ts` (the record type + pure
`canonicalProvenance`/`signProvenance`/`verifyProvenance`, modelled exactly on
`log/src/op.ts`) and `provenancelog.ts` (an in-memory `ProvenanceLog` registry
keyed by op id, consuming `store.put` for the optional prompt). It imports `Op`
from `@thaddeus.run/log` as a type only and consumes `identity`/`store` across
their public APIs.

**Tech Stack:** TypeScript (ESM, `type: module`), Bun test runner, moon task
runner, tsdown bundler, `@noble/hashes/blake3`, ed25519 via
`@thaddeus.run/identity` (libsodium). No new dependencies beyond what `log`
already uses.

## Global Constraints

- **Spec:** `docs/specs/2026-06-23-thaddeus-pillar-04-provenance-design.md` is
  the source of truth for this plan.
- **Sign the FULL record.** `canonical` covers all semantic fields (`op`,
  `actor`, `actor_kind`, `intent`, `reasoning`, `task`, `prompt_ref`, `prompt`)
  — deliberately wider than the brief's `op‖intent‖task‖prompt_ref`. Domain tag
  `thaddeus.provenance.v1` is the first element of the signed tuple.
- **Fail-closed verify.** `verifyProvenance` returns `false` (never throws) on
  any malformed input.
- **Keep-and-label, do not reject.** `ProvenanceLog.append` retains invalid
  records (rendered `unverified`) — the opposite of `OpLog.append`, which
  throws.
- **`actor` need not equal `op.author`.** Verification binds to `op.id` +
  signature, not authorship.
- **Spike discipline:** in-memory, single process, no persistence/network.
  Reputation accrual, delegation, and the `--why` query surface are out of scope
  (deferred to P09 / P06-P11).
- **Tooling:** use `bun` (never npm/pnpm/npx). Run tasks through moon:
  `moon run <project>:<task>`. Export `AGENT=1` for AI-friendly test output.
  Preserve trailing newlines. Commit messages follow Conventional Commits 1.0.0.
- **Naming:** package is `@thaddeus.run/provenance` (neutral, product-agnostic).
  Source of truth vision file uses "Thaddeus"; package names never use
  `Thaddeus-`.
- **Verification baseline after code changes:** `moon run root:format root:lint`
  plus the affected `moonx provenance:typecheck` and `moonx provenance:test`.

---

### Task 1: Scaffold `@thaddeus.run/provenance` and build the `Provenance` record

Create the package skeleton (copying `packages/log`'s exact config shape) and
the pure record module: the `Provenance` type and
`canonicalProvenance`/`signProvenance`/`verifyProvenance`, modelled on
`packages/log/src/op.ts`.

**Files:**

- Create: `packages/provenance/package.json`
- Create: `packages/provenance/moon.yml`
- Create: `packages/provenance/tsconfig.json`
- Create: `packages/provenance/tsdown.config.ts`
- Create: `packages/provenance/README.md`
- Create: `packages/provenance/LICENSE.md` (copy of `packages/log/LICENSE.md`)
- Create: `packages/provenance/src/provenance.ts`
- Create: `packages/provenance/src/index.ts`
- Test: `packages/provenance/test/provenance.test.ts`

**Interfaces:**

- Consumes: `Identity`, `PublicIdentity`, `ready` from `@thaddeus.run/identity`;
  `Ref` from `@thaddeus.run/store`; `blake3` from `@noble/hashes/blake3`;
  `bytesToHex` from `@noble/hashes/utils`.
- Produces (later tasks rely on these exact signatures):
  - `interface Provenance { readonly op: string; readonly actor: string; readonly actor_kind: string; readonly intent: string; readonly reasoning: string; readonly task: string | null; readonly prompt_ref: string | null; readonly prompt: Ref | null; readonly sig: Uint8Array; }`
  - `interface ProvenanceFields { readonly op: string; readonly actor_kind: string; readonly intent: string; readonly reasoning: string; readonly task: string | null; readonly prompt_ref: string | null; readonly prompt: Ref | null; }`
  - `function canonicalProvenance(fields: ProvenanceFields, actor: string): Uint8Array`
  - `function signProvenance(fields: ProvenanceFields, actor: Identity): Provenance`
  - `function verifyProvenance(p: Provenance): boolean`

- [ ] **Step 1: Create the package config files**

`packages/provenance/package.json`:

```json
{
  "name": "@thaddeus.run/provenance",
  "version": "0.0.0",
  "description": "A signed \"why\" layer — Provenance records (actor, intent, reasoning, task, capability-gated prompt) bound to an Op.id and verifiable by anyone. Pillar 04.",
  "keywords": ["provenance", "did", "operation-log", "Thaddeus", "substrate"],
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
    "directory": "packages/provenance"
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
    "prepublishOnly": "moon run provenance:prepublish"
  },
  "dependencies": {
    "@noble/hashes": "catalog:",
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/log": "workspace:*",
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

`packages/provenance/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

language: 'typescript'
layer: 'library'
tags: ['tsdown', 'publishable']
```

`packages/provenance/tsconfig.json`:

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

`packages/provenance/tsdown.config.ts`:

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

`packages/provenance/README.md`:

```markdown
# @thaddeus.run/provenance

The signed "why" layer for **Thaddeus** (working name) — Pillar 04.

A `Provenance` record attaches the _why_ — actor, actor kind, intent, reasoning,
task, and an optional capability-gated prompt — to an `Op.id` from
`@thaddeus.run/log`. The record is signed by the actor over **all** of its
fields, so nothing on it is malleable on relay. Unsigned or signature-invalid
provenance renders as `unverified` and is kept (not rejected) so a reader sees
the untrustworthy claim flagged rather than silently dropped.

The prompt is stored by reference, never inline: its bytes live in
`@thaddeus.run/store` as a capability-gated object, and the record carries
`prompt_ref = blake3(prompt)` (a tamper-evident binding) plus the store `Ref`
(the gated pointer) — so a prompt containing secrets never enters world-readable
history.

> **Status: spike.** In-memory, single process. Reputation accrual,
> delegation/attestation, and a real `--why` query surface are deferred (see the
> design spec).
```

- [ ] **Step 2: Copy the license**

```bash
cp packages/log/LICENSE.md packages/provenance/LICENSE.md
```

- [ ] **Step 3: Install so workspace symlinks resolve**

Run: `bun install` Expected: completes without error;
`node_modules/@thaddeus.run/provenance` symlink is created.

- [ ] **Step 4: Write the failing test**

`packages/provenance/test/provenance.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  canonicalProvenance,
  signProvenance,
  verifyProvenance,
} from '../src/provenance';

beforeAll(async () => {
  await ready();
});

const fields = (op: string) => ({
  op,
  actor_kind: 'agent:claude-code@1.2',
  intent: 'fix race in token refresh',
  reasoning: 'refresh() re-entered before lock; added a mutex',
  task: 'Thaddeus-417' as string | null,
  prompt_ref: null,
  prompt: null,
});

describe('Provenance record', () => {
  test('signProvenance produces a verifiable record bound to the op + actor', () => {
    const actor = Identity.create();
    const p = signProvenance(fields('opid'), actor);
    expect(p.op).toBe('opid');
    expect(p.actor).toBe(actor.did);
    expect(p.actor_kind).toBe('agent:claude-code@1.2');
    expect(verifyProvenance(p)).toBe(true);
  });

  test('tampering with ANY signed field breaks verification', () => {
    const actor = Identity.create();
    const p = signProvenance(fields('opid'), actor);
    expect(verifyProvenance({ ...p, op: 'other' })).toBe(false);
    expect(verifyProvenance({ ...p, actor_kind: 'human' })).toBe(false);
    expect(verifyProvenance({ ...p, intent: 'lie' })).toBe(false);
    expect(verifyProvenance({ ...p, reasoning: 'lie' })).toBe(false);
    expect(verifyProvenance({ ...p, task: 'Thaddeus-000' })).toBe(false);
    expect(verifyProvenance({ ...p, prompt_ref: 'deadbeef' })).toBe(false);
  });

  test('verifyProvenance returns false (never throws) on malformed input', () => {
    const actor = Identity.create();
    const p = signProvenance(fields('opid'), actor);
    expect(verifyProvenance({ ...p, actor: 'did:key:not-a-real-key' })).toBe(
      false
    );
    expect(verifyProvenance({ ...p, sig: new Uint8Array([1, 2, 3]) })).toBe(
      false
    );
  });

  test('an absent task/prompt (null) still verifies', () => {
    const actor = Identity.create();
    const p = signProvenance({ ...fields('opid'), task: null }, actor);
    expect(p.task).toBeNull();
    expect(verifyProvenance(p)).toBe(true);
  });

  test('canonical bytes are domain-tagged (cross-protocol separation)', () => {
    // The domain tag is the first element of the signed tuple, so a provenance
    // signature can never be confused with an op signature (thaddeus.log.op.v1)
    // or another protocol's payload. (Acceptance 10.)
    const bytes = canonicalProvenance(fields('opid'), 'did:key:zActor');
    expect(new TextDecoder().decode(bytes)).toContain('thaddeus.provenance.v1');
    expect(new TextDecoder().decode(bytes)).not.toContain('thaddeus.log.op.v1');
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `AGENT=1 moon run provenance:test` Expected: FAIL — cannot resolve
`../src/provenance` (module not yet created).

- [ ] **Step 6: Write the record module**

`packages/provenance/src/provenance.ts`:

```ts
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { Identity, PublicIdentity } from '@thaddeus.run/identity';
import type { Ref } from '@thaddeus.run/store';

// A signed "why" attached to an Op.id (P03). The op is referenced by id, never
// embedded — P03 deliberately left no intent field on Op. Every semantic field
// is covered by `sig`, so nothing on the record is malleable on relay.
export interface Provenance {
  readonly op: string;
  readonly actor: string;
  readonly actor_kind: string;
  readonly intent: string;
  readonly reasoning: string;
  readonly task: string | null;
  readonly prompt_ref: string | null;
  readonly prompt: Ref | null;
  readonly sig: Uint8Array;
}

// The signable fields, before `actor`/`sig` are computed.
export interface ProvenanceFields {
  readonly op: string;
  readonly actor_kind: string;
  readonly intent: string;
  readonly reasoning: string;
  readonly task: string | null;
  readonly prompt_ref: string | null;
  readonly prompt: Ref | null;
}

// Domain tag prefixed into the signed tuple so a provenance signature can never
// be confused with an op signature (thaddeus.log.op.v1) or another protocol's
// payload that happens to serialize the same.
const PROVENANCE_DOMAIN = 'thaddeus.provenance.v1';

// Reject non-canonical field values before they are signed. Mirrors op.ts's
// assertCanonical: a required field that is empty or the wrong type throws, so
// verifyProvenance (try/catch) rejects such records and signProvenance fails
// fast on bad input.
function assertCanonical(fields: ProvenanceFields, actor: string): void {
  const required: [string, unknown][] = [
    ['op', fields.op],
    ['actor', actor],
    ['actor_kind', fields.actor_kind],
    ['intent', fields.intent],
    ['reasoning', fields.reasoning],
  ];
  for (const [name, value] of required) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`provenance.${name} must be a non-empty string`);
    }
  }
  if (
    fields.task !== null &&
    (typeof fields.task !== 'string' || fields.task.length === 0)
  ) {
    throw new TypeError('provenance.task must be a non-empty string or null');
  }
  if (
    fields.prompt_ref !== null &&
    (typeof fields.prompt_ref !== 'string' || fields.prompt_ref.length === 0)
  ) {
    throw new TypeError(
      'provenance.prompt_ref must be a non-empty string or null'
    );
  }
  if (
    fields.prompt !== null &&
    (typeof fields.prompt.id !== 'string' ||
      typeof fields.prompt.plaintext_id !== 'string')
  ) {
    throw new TypeError(
      'provenance.prompt must have string id and plaintext_id'
    );
  }
}

// Deterministic bytes for the signature. `prompt` encodes as its Ref pair or
// null — the same convention Op.payload uses.
export function canonicalProvenance(
  fields: ProvenanceFields,
  actor: string
): Uint8Array {
  assertCanonical(fields, actor);
  const prompt =
    fields.prompt === null
      ? null
      : [fields.prompt.id, fields.prompt.plaintext_id];
  return new TextEncoder().encode(
    JSON.stringify([
      PROVENANCE_DOMAIN,
      fields.op,
      actor,
      fields.actor_kind,
      fields.intent,
      fields.reasoning,
      fields.task,
      fields.prompt_ref,
      prompt,
    ])
  );
}

// Build the full signed record. sig = actor over the canonical bytes covering
// every field, so no field is malleable.
export function signProvenance(
  fields: ProvenanceFields,
  actor: Identity
): Provenance {
  const bytes = canonicalProvenance(fields, actor.did);
  return {
    op: fields.op,
    actor: actor.did,
    actor_kind: fields.actor_kind,
    intent: fields.intent,
    reasoning: fields.reasoning,
    task: fields.task,
    prompt_ref: fields.prompt_ref,
    prompt: fields.prompt,
    sig: actor.sign(bytes),
  };
}

// Valid iff the signature verifies under the actor's did:key over the canonical
// bytes. Fails closed: any mismatch OR malformed input (an undecodable did:key,
// a wrong-length sig, a non-canonical field) returns false rather than throwing.
export function verifyProvenance(p: Provenance): boolean {
  try {
    const bytes = canonicalProvenance(p, p.actor);
    return PublicIdentity.fromDid(p.actor).verify(bytes, p.sig);
  } catch {
    return false;
  }
}
```

`packages/provenance/src/index.ts`:

```ts
export {
  canonicalProvenance,
  signProvenance,
  verifyProvenance,
} from './provenance';
export type { Provenance, ProvenanceFields } from './provenance';
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `AGENT=1 moon run provenance:test` Expected: PASS — all four tests green.

- [ ] **Step 8: Typecheck and build**

Run: `moon run provenance:typecheck && moon run provenance:build` Expected: both
succeed; `packages/provenance/dist/index.js` and `index.d.ts` exist.

- [ ] **Step 9: Commit**

```bash
git add packages/provenance bun.lock
git commit -m "feat(provenance): the signed Provenance record (Pillar 04)

canonicalProvenance/signProvenance/verifyProvenance over the full record,
domain-tagged thaddeus.provenance.v1; fail-closed verify. New package
@thaddeus.run/provenance scaffolded on the @thaddeus.run/log template.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 2: The `ProvenanceLog` registry (record, prompt storage, trust label)

Add the in-memory registry that builds + signs provenance for an `Op`, stores an
optional prompt capability-gated, keeps records keyed by op id, and renders the
`verified`/`unverified` label.

**Files:**

- Create: `packages/provenance/src/provenancelog.ts`
- Modify: `packages/provenance/src/index.ts` (add exports)
- Test: `packages/provenance/test/provenancelog.test.ts`

**Interfaces:**

- Consumes: `Provenance`, `signProvenance`, `verifyProvenance` from
  `./provenance`; `Identity` from `@thaddeus.run/identity`; `Op` from
  `@thaddeus.run/log`; `Ref`, `Store` from `@thaddeus.run/store`; `blake3`,
  `bytesToHex` from `@noble/hashes`.
- Produces:
  - `type ProvenanceStatus = 'verified' | 'unverified'`
  - `class ProvenanceLog { constructor(store: Store); record(op: Op, fields: { intent: string; reasoning: string; actorKind: string; task?: string; prompt?: Uint8Array }, actor: Identity): Promise<Provenance>; append(p: Provenance): void; forOp(opId: string): readonly Provenance[]; verify(p: Provenance): boolean; status(p: Provenance): ProvenanceStatus; }`

- [ ] **Step 1: Write the failing test**

`packages/provenance/test/provenancelog.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { signProvenance } from '../src/provenance';
import { ProvenanceLog } from '../src/provenancelog';

beforeAll(async () => {
  await ready();
});

// Helper: write a real op so provenance has something to bind to.
async function anOp(store: MemoryStore, author: Identity) {
  const log = new OpLog(store);
  return log.write('main', 'src/auth.rs', enc('fn refresh() {}'), author);
}
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('ProvenanceLog', () => {
  test('record builds a verified why bound to the op', async () => {
    const store = new MemoryStore();
    const actor = Identity.create();
    const op = await anOp(store, actor);
    const prov = new ProvenanceLog(store);

    const p = await prov.record(
      op,
      {
        intent: 'fix race in token refresh',
        reasoning: 'added a mutex',
        actorKind: 'agent:claude-code@1.2',
        task: 'Thaddeus-417',
      },
      actor
    );

    expect(p.op).toBe(op.id);
    expect(prov.status(p)).toBe('verified');
    expect(prov.forOp(op.id)).toHaveLength(1);
    expect(prov.forOp(op.id)[0]?.intent).toBe('fix race in token refresh');
  });

  test('a supplied prompt is stored capability-gated and bound by hash', async () => {
    const store = new MemoryStore();
    const actor = Identity.create();
    const stranger = Identity.create();
    const op = await anOp(store, actor);
    const prov = new ProvenanceLog(store);

    const promptBytes = enc('secret prompt: the API key is hunter2');
    const p = await prov.record(
      op,
      { intent: 'i', reasoning: 'r', actorKind: 'human', prompt: promptBytes },
      actor
    );

    // prompt_ref is the tamper-evident hash; the Ref is the gated pointer.
    expect(p.prompt_ref).not.toBeNull();
    expect(p.prompt).not.toBeNull();
    expect(prov.status(p)).toBe('verified');

    // The actor can read the prompt back; it hashes to prompt_ref.
    if (p.prompt !== null) {
      const back = await store.get(p.prompt, actor);
      expect(new TextDecoder().decode(back)).toBe(
        'secret prompt: the API key is hunter2'
      );
      // A non-grantee cannot read it (no leak into readable history).
      let denied = false;
      try {
        await store.get(p.prompt, stranger);
      } catch {
        denied = true;
      }
      expect(denied).toBe(true);
    }
  });

  test('no prompt → prompt_ref and prompt are null, still verified', async () => {
    const store = new MemoryStore();
    const actor = Identity.create();
    const op = await anOp(store, actor);
    const prov = new ProvenanceLog(store);

    const p = await prov.record(
      op,
      { intent: 'i', reasoning: 'r', actorKind: 'human' },
      actor
    );
    expect(p.prompt_ref).toBeNull();
    expect(p.prompt).toBeNull();
    expect(prov.status(p)).toBe('verified');
  });

  test('actor need not equal op.author — still verifies and binds the op', async () => {
    const store = new MemoryStore();
    const human = Identity.create();
    const agent = Identity.create();
    const op = await anOp(store, human);
    const prov = new ProvenanceLog(store);

    const p = await prov.record(
      op,
      { intent: 'i', reasoning: 'r', actorKind: 'agent:claude-code@1.2' },
      agent
    );
    expect(p.actor).toBe(agent.did);
    expect(p.actor).not.toBe(op.author);
    expect(prov.status(p)).toBe('verified');
  });

  test('append KEEPS an invalid record and labels it unverified (does not throw)', async () => {
    const store = new MemoryStore();
    const actor = Identity.create();
    const op = await anOp(store, actor);
    const prov = new ProvenanceLog(store);

    const good = signProvenance(
      {
        op: op.id,
        actor_kind: 'human',
        intent: 'i',
        reasoning: 'r',
        task: null,
        prompt_ref: null,
        prompt: null,
      },
      actor
    );
    const tampered = { ...good, reasoning: 'forged' };

    expect(() => prov.append(tampered)).not.toThrow();
    expect(prov.forOp(op.id)).toHaveLength(1);
    expect(prov.status(prov.forOp(op.id)[0]!)).toBe('unverified');
  });

  test('append is idempotent on (op, actor, sig); forOp order is deterministic', async () => {
    const store = new MemoryStore();
    const actor = Identity.create();
    const op = await anOp(store, actor);
    const prov = new ProvenanceLog(store);

    const p = signProvenance(
      {
        op: op.id,
        actor_kind: 'human',
        intent: 'i',
        reasoning: 'r',
        task: null,
        prompt_ref: null,
        prompt: null,
      },
      actor
    );
    prov.append(p);
    prov.append(p);
    expect(prov.forOp(op.id)).toHaveLength(1);

    // A second distinct record (different actor) appears in a stable order.
    const other = Identity.create();
    const q = signProvenance(
      {
        op: op.id,
        actor_kind: 'human',
        intent: 'i2',
        reasoning: 'r2',
        task: null,
        prompt_ref: null,
        prompt: null,
      },
      other
    );
    prov.append(q);
    const order1 = prov.forOp(op.id).map((r) => r.actor);
    const order2 = prov.forOp(op.id).map((r) => r.actor);
    expect(order1).toEqual(order2);
    expect(order1).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENT=1 moon run provenance:test` Expected: FAIL — cannot resolve
`../src/provenancelog`.

- [ ] **Step 3: Write the registry**

`packages/provenance/src/provenancelog.ts`:

```ts
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import type { Identity } from '@thaddeus.run/identity';
import type { Op } from '@thaddeus.run/log';
import type { Ref, Store } from '@thaddeus.run/store';

import {
  type Provenance,
  signProvenance,
  verifyProvenance,
} from './provenance';

// The render-time trust label. `unverified` covers both unsigned and
// signature-invalid records (the brief's trust rule).
export type ProvenanceStatus = 'verified' | 'unverified';

// In-memory registry of provenance keyed by Op.id. Spike — not durable, not
// concurrency-safe, single process. Unlike OpLog, an invalid record is KEPT and
// labelled `unverified` rather than rejected: an unverifiable "why" poisons
// nothing — it is just a claim to disbelieve.
export class ProvenanceLog {
  readonly #store: Store;
  readonly #byOp: Map<string, Provenance[]> = new Map();

  constructor(store: Store) {
    this.#store = store;
  }

  // Build + sign provenance for `op`. If `prompt` bytes are given, store them as
  // a capability-gated object (granted to `actor`) and bind them by hash; the
  // record carries prompt_ref = blake3(prompt) and the store Ref. Records the
  // result and returns it.
  async record(
    op: Op,
    fields: {
      intent: string;
      reasoning: string;
      actorKind: string;
      task?: string;
      prompt?: Uint8Array;
    },
    actor: Identity
  ): Promise<Provenance> {
    let prompt: Ref | null = null;
    let promptRef: string | null = null;
    if (fields.prompt !== undefined) {
      prompt = await this.#store.put(fields.prompt, actor);
      promptRef = bytesToHex(blake3(fields.prompt));
    }
    const p = signProvenance(
      {
        op: op.id,
        actor_kind: fields.actorKind,
        intent: fields.intent,
        reasoning: fields.reasoning,
        task: fields.task ?? null,
        prompt_ref: promptRef,
        prompt,
      },
      actor
    );
    this.#insert(p);
    return p;
  }

  // Ingest a provenance record from a peer. KEEPS it regardless of validity so
  // it can be rendered `unverified`. Idempotent on the full record content.
  append(p: Provenance): void {
    this.#insert(p);
  }

  // NOTE: PR #5 review (Greptile P1) corrected the dedup key. An earlier draft
  // deduped on (actor, sig), which is first-write-wins: a forged record reusing
  // a genuine record's signature (`{ ...valid, reasoning: 'forged' }` keeps
  // valid.sig) arriving first via append() would suppress the genuine record.
  // Dedup now keys on the FULL record content via #contentKey, so genuine and
  // same-sig-forged records are distinct entries — both kept (keep-and-label),
  // genuine survives in any arrival order.

  // A total identity key over every field of a record (never throws).
  #contentKey(p: Provenance): string {
    return JSON.stringify([
      p.op,
      p.actor,
      p.actor_kind,
      p.intent,
      p.reasoning,
      p.task,
      p.prompt_ref,
      p.prompt === null ? null : [p.prompt.id, p.prompt.plaintext_id],
      bytesToHex(p.sig),
    ]);
  }

  // Store a record under its op id, deduped on full content.
  #insert(p: Provenance): void {
    const list = this.#byOp.get(p.op) ?? [];
    const key = this.#contentKey(p);
    const dup = list.some((e) => this.#contentKey(e) === key);
    if (!dup) {
      list.push(p);
      this.#byOp.set(p.op, list);
    }
  }

  // All provenance records known for an op id, in a deterministic order (by
  // actor, then signature bytes, then full content) independent of insertion
  // order. The content tiebreak keeps the order total even for two records that
  // share an (actor, sig) but differ in body.
  forOp(opId: string): readonly Provenance[] {
    return [...(this.#byOp.get(opId) ?? [])].sort((a, b) => {
      if (a.actor !== b.actor) {
        return a.actor < b.actor ? -1 : 1;
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

  // Signature integrity over the bound op id. Whether that op actually exists is
  // the log's concern, not this check.
  verify(p: Provenance): boolean {
    return verifyProvenance(p);
  }

  // The render-time trust label: verified iff the signature checks out.
  status(p: Provenance): ProvenanceStatus {
    return verifyProvenance(p) ? 'verified' : 'unverified';
  }
}
```

- [ ] **Step 4: Add the exports**

Edit `packages/provenance/src/index.ts` to append:

```ts
export { ProvenanceLog } from './provenancelog';
export type { ProvenanceStatus } from './provenancelog';
```

(Full file after the edit:)

```ts
export {
  canonicalProvenance,
  signProvenance,
  verifyProvenance,
} from './provenance';
export type { Provenance, ProvenanceFields } from './provenance';
export { ProvenanceLog } from './provenancelog';
export type { ProvenanceStatus } from './provenancelog';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `AGENT=1 moon run provenance:test` Expected: PASS — all `ProvenanceLog`
tests green (plus Task 1's record tests).

- [ ] **Step 6: Typecheck and build**

Run: `moon run provenance:typecheck && moon run provenance:build` Expected: both
succeed.

- [ ] **Step 7: Commit**

```bash
git add packages/provenance
git commit -m "feat(provenance): ProvenanceLog registry + capability-gated prompt

record() builds+signs a why for an Op, stores an optional prompt
capability-gated (bound by blake3 + Ref), keeps records by op id, and
renders verified/unverified. append() keeps invalid records (labelled,
not rejected). actor need not equal op.author.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 3: Close the north-star — swap the P04 `test.todo` for a real assertion

Replace the P04 stub in the integration test with a real composition test,
making the seeded one-edit flow 5 pass / 0 todo.

**Files:**

- Modify: `integration/package.json` (add the `@thaddeus.run/provenance`
  dependency)
- Modify: `integration/test/one-edit-end-to-end.test.ts:1-3` (add import) and
  `:64-65` (replace the `test.todo`)

**Interfaces:**

- Consumes: `ProvenanceLog` from `@thaddeus.run/provenance`; existing
  `Identity`, `OpLog`, `MemoryStore` already imported in the test.

- [ ] **Step 1: Add the dependency**

Edit `integration/package.json` `dependencies` to include the provenance package
(keep alphabetical order):

```json
  "dependencies": {
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/log": "workspace:*",
    "@thaddeus.run/provenance": "workspace:*",
    "@thaddeus.run/store": "workspace:*"
  },
```

- [ ] **Step 2: Install so the new workspace dep resolves**

Run: `bun install` Expected: completes without error.

- [ ] **Step 3: Add the import**

Edit the top of `integration/test/one-edit-end-to-end.test.ts`. After the
existing `import { OpLog } from '@thaddeus.run/log';` line, add:

```ts
import { ProvenanceLog } from '@thaddeus.run/provenance';
```

(Resulting import block, lines 1-4:)

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import { MemoryStore, publicIdentity } from '@thaddeus.run/store';
```

- [ ] **Step 4: Replace the `test.todo`**

In `integration/test/one-edit-end-to-end.test.ts`, replace these two lines:

```ts
// @ts-expect-error bun-types@1.3.12 requires a fn arg, but the runtime supports label-only todo
test.todo('P04: a signed Provenance record attaches the why to the Op');
```

with:

```ts
test('P04: a signed Provenance record attaches the why to the Op', async () => {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const author = Identity.create();
  const prov = new ProvenanceLog(store);

  const op = await log.write(
    'main',
    'src/auth.rs',
    new TextEncoder().encode('fn refresh() {}'),
    author
  );

  const why = await prov.record(
    op,
    {
      intent: 'fix race in token refresh',
      reasoning: 'refresh() re-entered before lock; added a mutex',
      actorKind: 'agent:claude-code@1.2',
      task: 'Thaddeus-417',
    },
    author
  );

  // The why is bound to the op's id and verifies.
  expect(why.op).toBe(op.id);
  expect(prov.status(why)).toBe('verified');
  expect(prov.forOp(op.id).map((p) => p.intent)).toContain(
    'fix race in token refresh'
  );

  // The trust rule: tampering any signed field renders it unverified.
  expect(prov.status({ ...why, reasoning: 'a plausible lie' })).toBe(
    'unverified'
  );
  expect(prov.status({ ...why, actor_kind: 'human' })).toBe('unverified');
});
```

- [ ] **Step 5: Run the north-star suite to verify it passes**

Run: `AGENT=1 moon run integration:test` Expected: PASS — 5 tests pass, 0 todo
(the P04 test now runs).

- [ ] **Step 6: Commit**

```bash
git add integration
git commit -m "test(integration): close the north-star — P04 provenance (5 pass / 0 todo)

Swap the P04 test.todo for a real assertion: a signed Provenance binds
the why to the seeded edit's Op, verifies, and flips to unverified on
tamper. Every stub on the seeded one-edit path is now gone.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 4: The provenance demo (`examples/provenance/`)

Add a runnable CLI demo (sibling to `examples/oplog/`) enacting the three acts
from spec §9: a signed why on a real op, tamper → `unverified`, and a gated
prompt that does not leak.

**Files:**

- Create: `examples/provenance/package.json`
- Create: `examples/provenance/moon.yml`
- Create: `examples/provenance/tsconfig.json`
- Create: `examples/provenance/src/provenance.ts`

**Interfaces:**

- Consumes: `Identity`, `ready` from `@thaddeus.run/identity`; `OpLog` from
  `@thaddeus.run/log`; `ProvenanceLog` from `@thaddeus.run/provenance`;
  `MemoryStore` from `@thaddeus.run/store`.

- [ ] **Step 1: Create the example config files**

`examples/provenance/package.json`:

```json
{
  "name": "@thaddeus.run/example-provenance",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/log": "workspace:*",
    "@thaddeus.run/provenance": "workspace:*",
    "@thaddeus.run/store": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "catalog:"
  }
}
```

`examples/provenance/moon.yml`:

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
    command: 'bun src/provenance.ts'
    deps:
      - '^:build'
    options:
      cache: false
      runInCI: 'skip'
```

`examples/provenance/tsconfig.json`:

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

`examples/provenance/src/provenance.ts`:

```ts
// Provenance demo for @thaddeus.run/provenance (Pillar 04).
// Run: CI= moon run example-provenance:demo
//
// Three acts: (1) a signed "why" on a real op (P12 completed); (2) the trust
// rule — tamper → unverified, kept not dropped; (3) the prompt does not leak —
// only its hash + address are public, the bytes are capability-gated.

import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import { MemoryStore } from '@thaddeus.run/store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const rule = (): void => console.log('—'.repeat(60));

await ready();
const store = new MemoryStore();
const log = new OpLog(store);
const prov = new ProvenanceLog(store);

// An agent's operator (the human) and the agent identity that signs the why.
const operator = Identity.create();
const agent = Identity.create();

// Act 1 — a signed why on a real op.
const op = await log.write(
  'main',
  'src/auth.rs',
  enc('fn refresh() {}'),
  operator
);
const why = await prov.record(
  op,
  {
    intent: 'fix race in token refresh',
    reasoning: 'refresh() re-entered before lock; added a mutex',
    actorKind: 'agent:claude-code@1.2',
    task: 'Thaddeus-417',
    prompt: enc(
      'PROMPT: patch the token refresh race. context: <secret repo map>'
    ),
  },
  agent
);

rule();
console.log(`$ Thaddeus log src/auth.rs --why`);
console.log(
  `  @@ refresh() … (Op ${op.id.slice(0, 4)}, lamport ${op.lamport})`
);
console.log(
  `  actor   ${why.actor_kind}  (operator: ${operator.did.slice(0, 16)}…)   ${
    prov.status(why) === 'verified' ? '✓ verified' : '✗ unverified'
  }`
);
console.log(`  intent  ${why.intent}        task  ${why.task}`);

// Act 2 — the trust rule: tamper → unverified (and the record is KEPT).
const forged = { ...why, reasoning: 'a plausible lie that was never signed' };
prov.append(forged);
rule();
console.log('2. tamper the reasoning → status:', prov.status(forged));
console.log(
  '   records kept for this op (verified + unverified both shown):',
  prov.forOp(op.id).map((p) => prov.status(p))
);

// Act 3 — the prompt does not leak: only the hash + Ref are public.
rule();
console.log('3. public record carries only a hash + address for the prompt:');
console.log('   prompt_ref:', why.prompt_ref?.slice(0, 16), '…');
console.log(
  '   prompt Ref:',
  why.prompt?.id.slice(0, 16),
  '… (ciphertext address)'
);
if (why.prompt !== null) {
  // The agent (grantee) can read it back.
  console.log(
    '   agent reads prompt:',
    JSON.stringify(dec(await store.get(why.prompt, agent)))
  );
  // A stranger cannot.
  const stranger = Identity.create();
  let denied = false;
  try {
    await store.get(why.prompt, stranger);
  } catch {
    denied = true;
  }
  console.log('   stranger denied the prompt:', denied);
}

rule();
console.log('Acceptance: signed why bound to Op.id; tamper → unverified;');
console.log(
  'prompt stored capability-gated — its bytes never enter readable history.'
);
```

- [ ] **Step 3: Install and run the demo**

Run: `bun install && CI= moon run example-provenance:demo` Expected: prints the
three acts; Act 1 shows `✓ verified`; Act 2 shows `unverified` and
`[ 'verified', 'unverified' ]`; Act 3 shows the agent reading the prompt and
`stranger denied the prompt: true`.

- [ ] **Step 4: Typecheck the example**

Run: `moon run example-provenance:typecheck` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/provenance
git commit -m "docs(provenance): runnable demo — signed why, tamper, no-leak prompt

examples/provenance enacts the three acts: a signed why on a real op
(--why render), tamper → unverified (kept not dropped), and a
capability-gated prompt readable only by its grantee.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 5: Update the convergence docs (ARCHITECTURE + CHANGELOG)

Flip the Pillar 04 row to built and record the release + deferred ledger
entries, per spec §12.

**Files:**

- Modify: `ARCHITECTURE.md` (Pillar 04 status row; shared-primitives note)
- Modify: `CHANGELOG.md` (`[Unreleased] → Added`; Deferred ledger)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `ARCHITECTURE.md`**

In the **Status / traceability** table, change the Pillar 04 row from:

```
| 04 Provenance ("why")                 | _(planned)_          | planned | P12              |
```

to:

```
| 04 Provenance ("why")                 | `provenance`         | built   | P12              |
```

In the **Shared primitives** table, update the `Op (operation log entry)` row's
"Reused by" cell so the P04 reference is concrete (it already lists `P04`; no
change needed if it reads "P03 · P04 · P08 · P10"). Verify the row reads:

```
| Op (operation log entry)              | `@thaddeus.run/log`      | P03 · P04 · P08 · P10                                   |
```

(If the `@thaddeus.run/log` cell currently shows `log` without the scope, leave
it as-is — match the existing cell formatting.)

- [ ] **Step 2: Update `CHANGELOG.md` — Added**

Under `## [Unreleased]` → `### Added`, after the existing `@thaddeus.run/log`
bullet, add:

```markdown
- `@thaddeus.run/provenance` — the signed "why" layer (Pillar 04): a
  `Provenance` record bound to an `Op.id` carrying actor, actor_kind, intent,
  reasoning, task, and an optional **capability-gated prompt** (stored by
  reference — `prompt_ref = blake3(prompt)` plus a store `Ref` — so prompts with
  secrets never enter readable history). The signature covers the **full
  record** (hardening the brief's narrower `op‖intent‖task‖prompt_ref` subset),
  so `actor_kind`/`reasoning` cannot be forged on relay. `ProvenanceLog` renders
  each record `verified`/`unverified` and **keeps** invalid records (labelled,
  not rejected). Completes **P12** and closes the seeded north-star one-edit
  flow (5 pass / 0 todo).
```

- [ ] **Step 3: Update `CHANGELOG.md` — Deferred ledger**

In the **Deferred** section, add these entries under the **scope-cut** bucket
(create the lines near the other scope-cut items; if the section uses a
sub-heading like "### Scope-cut", place them there, else append to the
Research/limitations lists as fits the existing structure):

```markdown
- **Reputation accrual / outcomes (P04→P09).** The trust rule's second clause —
  invalid provenance "never counts toward an agent's reputation" — needs the
  reputation/outcomes machinery that does not yet exist. P04 ships the
  `verified`/`unverified` label only; accrual is Pillar 09.
- **Delegation / attestation (P04→P09).** P04 verifies that _some_ did:key
  signed and bound an op id (actor may differ from op.author), but not that an
  agent was authorized to act _for_ a principal. Authorization semantics are
  Pillar 09.
- **`--why` query surface (P04→P06/P11).** Querying provenance across history is
  a later pillar; P04 renders the why only in its demo.
- **Prompt-cap grant/revoke wiring (P04).** Storing the prompt capability-gated
  is built; granting it to reviewers and revoking a "why" reuse
  `store.grant`/`revoke` but are not wired in this release.
- **Unverified-record spam control (P04).** Keep-and-label lets a peer attach
  unlimited unsigned claims to an op id; rate-limiting/scoping is out of spike
  scope.
```

- [ ] **Step 4: Sanity-check the docs render**

Run: `moon run root:format` Expected: succeeds; the Markdown tables and lists
are reflowed consistently (oxfmt may adjust spacing — that is fine).

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: mark Pillar 04 (provenance) built; changelog + deferred ledger

Flip the Pillar 04 row planned→built (@thaddeus.run/provenance, resolves
P12). Record the release under Added and ledger the deferred items
(reputation→P09, delegation→P09, --why query→P06/P11, prompt-cap wiring,
unverified-record spam control).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 6: Full-workspace verification

Run the repo-wide baseline so the new package, the integration swap, and the
docs all land green together.

**Files:** none (verification only).

- [ ] **Step 1: Build the whole workspace**

Run: `moon run :build` Expected: every package builds, including
`@thaddeus.run/provenance`. (This ensures type-aware lint can resolve the new
package through its `dist`.)

- [ ] **Step 2: Format and lint the repo**

Run: `moon run root:format root:lint` Expected: both succeed with no errors.

- [ ] **Step 3: Typecheck the affected projects**

Run:
`moon run provenance:typecheck integration:typecheck example-provenance:typecheck`
Expected: all PASS.

- [ ] **Step 4: Run the affected tests**

Run: `AGENT=1 moon run provenance:test integration:test` Expected: all PASS —
provenance suite green; integration is 5 pass / 0 todo.

- [ ] **Step 5: Confirm nothing else regressed**

Run: `AGENT=1 moon run :test` Expected: the full repo test run is green.

- [ ] **Step 6: Final commit (only if formatting/lint produced changes)**

```bash
git add -A
git commit -m "chore(provenance): repo-wide format/lint pass for Pillar 04

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

(If `git status` is clean after Step 2, skip this commit.)

---

## Notes for the implementer

- **Why a new package, not an extension of `log`:** provenance is a distinct
  primitive that imports `Op` as a _type only_ and consumes `identity`/`store`
  across their public APIs — no internals cross the seam. This mirrors how P03
  earned its own package.
- **The one deliberate deviation from the brief:** the brief's `sig` formula
  signs only `op‖intent‖task‖prompt_ref`. We sign the full record so
  `actor_kind` and `reasoning` cannot be forged on relay. Acceptance test
  "tampering with ANY signed field breaks verification" (Task 1) is what pins
  this.
- **`bun install` after every `package.json` change** (Tasks 1, 3, 4) so
  workspace symlinks resolve before you build or test.
- **If `moon run :test` ever runs every suite slowly**, you can target a single
  package: `moon run provenance:test`.
- **Determinism:** tests use `Identity.create()` (fresh keys) but assert only on
  structural facts (bound op id, verified/unverified, ordering stability), never
  on specific key bytes — so they are reproducible.
