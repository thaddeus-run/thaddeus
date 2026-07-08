# Pillar 07 — Federated Reputation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@thaddeus.run/reputation` — a dual-signed `Contribution` record
(`subj_sig` + `host_sig`) that any holder verifies from the dids alone, plus an
untrusted keep-and-label `ReputationLog` whose `profile` is the gathered,
self-verifying record set — and wire it into the north-star (a landed op mints a
`'merge'` contribution verifiable on a second instance), taking the flow to 6
pass / 0 todo.

**Architecture:** A new package with two source modules, mirroring
`@thaddeus.run/provenance`. `contribution.ts` defines the `Contribution` record
and `canonicalContribution`/`signContribution`/`verifyContribution` — both
signatures cover one domain-tagged canonical core (`subject`, `host`, `repo`,
`ref`, `kind`, `at`), with `subject`/`host` dids derived from the two signing
identities. `verifyContribution` returns `{ authentic, attested }`, fail-soft.
`reputationlog.ts` is the untrusted aggregator: `append` (keep-and-label,
idempotent), `forSubject`, `verify`, and `profile` (partitions into
`attested`/`claimed`, counts the attested set `byKind`). It composes **only**
`@thaddeus.run/identity` — a contribution references an op by id string.

**Tech Stack:** TypeScript (ESM, `type: module`), Bun test runner, moon task
runner, tsdown bundler. No new runtime dependencies beyond
`@thaddeus.run/identity` and **no crypto of its own** — all signing/verifying is
delegated to `identity`.

## Global Constraints

- **Spec:** `docs/specs/2026-06-24-thaddeus-pillar-07-reputation-design.md` is
  the source of truth for this plan.
- **Dual-signed over scoped, derived cores (rigid).** Two domain-tagged
  (`thaddeus.contribution.v1`) encodings: `subj_sig` signs the portable
  work-claim `(subject, repo, ref, kind, at)` — **excluding `host`**; `host_sig`
  signs the full `(subject, host, repo, ref, kind, at)`. So tampering `host`
  breaks only `host_sig` (authentic survives), and the subject's claim is valid
  no matter which instance attests it. `subject`/`host` are the dids **derived
  from the two signing identities**, never caller-supplied. (This split is the
  user-approved resolution of the original "same core" wording, which
  contradicted Task 1's host-tamper test.)
- **Verification yields two booleans, fail-soft (rigid).**
  `verifyContribution(c)` returns `{ authentic, attested }`: `authentic` =
  `subj_sig` valid for `c.subject`, `attested` = `host_sig` valid for `c.host`.
  A malformed did, wrong-length sig, or non-canonical field yields `false`,
  never throws. A malformed did on one side must not zero the other.
- **Reputation is the attested set; no score number.** `profile` partitions a
  subject's records into `attested` (authentic ∧ attested) and `claimed`
  (authentic ∧ ¬attested); non-authentic records (subj_sig doesn't match the
  record's own `subject`) count toward neither. `byKind` counts only the
  attested set.
- **`ReputationLog` is keep-and-label, untrusted, idempotent.** `append` ingests
  every record regardless of validity (a peer can't suppress by withholding) and
  dedups on full content. The aggregator performs no trust — `verify`/`profile`
  check signatures against the dids in the record, so a verifier honors a record
  minted elsewhere without trusting the aggregator.
- **Composes only `@thaddeus.run/identity`.** `PublicIdentity` (value, via
  `PublicIdentity.fromDid`) is a runtime dependency; `Identity` is a type. A
  contribution references an op by **id string** — no `log`/`store` dependency.
- **Deferred (out of scope, do not build):** network transport/serving, the
  two-party co-sign handshake, reputation scoring/tiers, auto-minting from P06
  landings as a pipeline, contribution revocation, persistence,
  governance/stewardship. Spike: in-memory, single process.
- **Tooling:** use `bun` (never npm/pnpm/npx). Run tasks through moon:
  `moon run <project>:<task>`. Export `AGENT=1` for AI-friendly test output.
  Preserve trailing newlines. Commit messages follow Conventional Commits 1.0.0.
- **Naming:** package is `@thaddeus.run/reputation` (neutral, product-agnostic);
  primary exports the `Contribution` record, the sign/verify functions, and
  `ReputationLog`. The vision file uses "Thaddeus"; package names never use
  `Thaddeus-`.
- **Verification baseline after code changes:** `moon run root:format root:lint`
  plus the affected `moonx reputation:typecheck` and `moonx reputation:test`.

---

### Task 1: Scaffold `@thaddeus.run/reputation` and the `Contribution` record

Create the package skeleton (copying `packages/provenance`'s exact config shape)
and `contribution.ts`: the record, its canonical encoding, and dual-signature
sign/verify. `ReputationLog` arrives in Task 2.

**Files:**

- Create: `packages/reputation/package.json`
- Create: `packages/reputation/moon.yml`
- Create: `packages/reputation/tsconfig.json`
- Create: `packages/reputation/tsdown.config.ts`
- Create: `packages/reputation/README.md`
- Create: `packages/reputation/LICENSE.md` (copy of `packages/log/LICENSE.md`)
- Create: `packages/reputation/src/contribution.ts`
- Create: `packages/reputation/src/index.ts`
- Test: `packages/reputation/test/contribution.test.ts`

**Interfaces:**

- Consumes: `Identity`, `PublicIdentity` from `@thaddeus.run/identity`.
- Produces (later tasks rely on these exact signatures):
  - `type ContributionKind = 'merge' | 'review' | 'release'`
  - `interface ContributionFields { readonly repo: string; readonly ref: string; readonly kind: ContributionKind; readonly at: string; }`
  - `interface Contribution extends ContributionFields { readonly subject: string; readonly host: string; readonly subj_sig: Uint8Array; readonly host_sig: Uint8Array; }`
  - `interface Verification { readonly authentic: boolean; readonly attested: boolean; }`
  - `function canonicalContribution(core: ContributionFields & { subject: string; host: string }): Uint8Array`
  - `function signContribution(fields: ContributionFields, subject: Identity, host: Identity): Contribution`
  - `function verifyContribution(c: Contribution): Verification`

- [ ] **Step 1: Create the package config files**

`packages/reputation/package.json`:

```json
{
  "name": "@thaddeus.run/reputation",
  "version": "0.0.0",
  "description": "Portable federated reputation: dual-signed Contribution records and an untrusted aggregator — reputation as a verifiable set of signed records, honored across instances. Pillar 07.",
  "keywords": [
    "reputation",
    "identity",
    "federation",
    "contribution",
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
    "directory": "packages/reputation"
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
    "prepublishOnly": "moon run reputation:prepublish"
  },
  "dependencies": {
    "@thaddeus.run/identity": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "catalog:",
    "@typescript/native-preview": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:"
  }
}
```

> **Dependency note:** `@thaddeus.run/identity` is a runtime dependency because
> the code uses `PublicIdentity` as a **value** (`PublicIdentity.fromDid` in
> `verifyContribution`). `Identity` is also imported (a type, for the
> `signContribution` params), but the value import is what makes it a runtime
> dep. No other `@thaddeus.run/*` packages are needed — a contribution
> references an op by id string, and the tests construct identities via
> `Identity.create()`.

`packages/reputation/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

language: 'typescript'
layer: 'library'
tags: ['tsdown', 'publishable']
```

`packages/reputation/tsconfig.json`:

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

`packages/reputation/tsdown.config.ts`:

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

`packages/reputation/README.md`:

```markdown
# @thaddeus.run/reputation

Portable, federated reputation for **Thaddeus** (working name) — Pillar 07.

A `Contribution` is a dual-signed record of a merge/review/release: `subj_sig`
(the subject claims it) and `host_sig` (an instance attests it happened there),
both over one canonical core. `verifyContribution` returns
`{ authentic, attested }` — any holder of the record and the two `did:key`s
verifies it alone, with no trust in any server. A `ReputationLog` is an
untrusted, keep-and-label aggregator whose `profile` is the gathered,
self-verifying record set (attested vs claimed, counted by kind) — reputation is
the records, not a number.

> **Status: spike.** In-memory, single process. Network transport, the two-party
> co-sign handshake, scoring/tiers, and revocation are deferred (see the design
> spec).
```

- [ ] **Step 2: Copy the license**

```bash
cp packages/log/LICENSE.md packages/reputation/LICENSE.md
```

- [ ] **Step 3: Install so workspace symlinks resolve**

Run: `bun install` Expected: completes without error;
`node_modules/@thaddeus.run/reputation` symlink is created.

- [ ] **Step 4: Write the failing test**

`packages/reputation/test/contribution.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  canonicalContribution,
  type ContributionFields,
  signContribution,
  verifyContribution,
} from '../src/contribution';

beforeAll(async () => {
  await ready();
});

const FIELDS: ContributionFields = {
  repo: 'forgejo.example/acme/web',
  ref: 'op-abc123',
  kind: 'merge',
  at: '2026-06-24T00:00:00.000Z',
};

describe('Contribution — sign & verify', () => {
  test('a freshly signed contribution is authentic and attested', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const c = signContribution(FIELDS, subject, host);
    expect(verifyContribution(c)).toEqual({ authentic: true, attested: true });
  });

  test('subject and host dids are derived from the signing identities', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const c = signContribution(FIELDS, subject, host);
    expect(c.subject).toBe(subject.did);
    expect(c.host).toBe(host.did);
    expect(c.repo).toBe(FIELDS.repo);
    expect(c.ref).toBe(FIELDS.ref);
    expect(c.kind).toBe('merge');
  });

  test('tampering a shared field breaks both signatures', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const c = signContribution(FIELDS, subject, host);
    expect(verifyContribution({ ...c, ref: 'op-evil' })).toEqual({
      authentic: false,
      attested: false,
    });
  });

  test('tampering subject breaks authentic; tampering host breaks attested', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const other = Identity.create();
    const c = signContribution(FIELDS, subject, host);
    // Re-pointing `subject` to another did invalidates subj_sig (host_sig also
    // covers `subject`, so attested breaks too — both cover the full core).
    expect(verifyContribution({ ...c, subject: other.did }).authentic).toBe(
      false
    );
    expect(verifyContribution({ ...c, host: other.did }).attested).toBe(false);
  });

  test('a host_sig from the wrong key is not attested, but stays authentic', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const stray = Identity.create();
    const bytes = canonicalContribution({
      ...FIELDS,
      subject: subject.did,
      host: host.did,
    });
    const wrongHost = {
      ...signContribution(FIELDS, subject, host),
      host_sig: stray.sign(bytes),
    };
    expect(verifyContribution(wrongHost)).toEqual({
      authentic: true,
      attested: false,
    });
  });

  test('a malformed did fails soft on that side only, never throws', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const c = signContribution(FIELDS, subject, host);
    const bad = { ...c, host: 'did:key:notvalid' };
    expect(verifyContribution(bad).attested).toBe(false);
    expect(verifyContribution(bad).authentic).toBe(true); // subject side still checks
  });

  test('signContribution rejects a non-canonical kind', () => {
    const subject = Identity.create();
    const host = Identity.create();
    expect(() =>
      signContribution(
        { ...FIELDS, kind: 'bogus' as ContributionFields['kind'] },
        subject,
        host
      )
    ).toThrow();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `AGENT=1 moon run reputation:test` Expected: FAIL — cannot resolve
`../src/contribution` (module not yet created).

- [ ] **Step 6: Write `contribution.ts` and `index.ts`**

`packages/reputation/src/contribution.ts`:

```ts
import { type Identity, PublicIdentity } from '@thaddeus.run/identity';

// The kinds of contribution a profile aggregates.
export type ContributionKind = 'merge' | 'review' | 'release';

// The signable, non-derived fields of a contribution.
export interface ContributionFields {
  readonly repo: string; // where it lived, e.g. "forgejo.example/acme/web"
  readonly ref: string; // the op/snapshot id it refers to
  readonly kind: ContributionKind;
  readonly at: string; // ISO 8601 timestamp
}

// A dual-signed contribution. subject/host dids are derived from the two signing
// identities; subj_sig is the subject's self-claim, host_sig is the instance's
// attestation that it happened there.
export interface Contribution extends ContributionFields {
  readonly subject: string; // = subject.did
  readonly host: string; // = host.did
  readonly subj_sig: Uint8Array;
  readonly host_sig: Uint8Array;
}

// Two independent truths a verifier checks for itself — no trust in any server.
export interface Verification {
  readonly authentic: boolean; // subj_sig valid for `subject`
  readonly attested: boolean; // host_sig valid for `host`
}

// Domain tag prefixed into the signed tuple so a contribution signature can
// never be confused with an op (thaddeus.log.op.v1) or provenance
// (thaddeus.provenance.v1) signature.
const CONTRIBUTION_DOMAIN = 'thaddeus.contribution.v1';

// The full signable core, with the derived dids included.
type ContributionCore = ContributionFields & {
  readonly subject: string;
  readonly host: string;
};

// Reject non-canonical field values before they are signed. Mirrors op.ts /
// provenance.ts: a required field that is empty or the wrong type throws, so
// verifyContribution (try/catch) rejects such records and signContribution
// fails fast on bad input.
function assertCanonical(core: ContributionCore): void {
  const required: [string, unknown][] = [
    ['subject', core.subject],
    ['host', core.host],
    ['repo', core.repo],
    ['ref', core.ref],
    ['at', core.at],
  ];
  for (const [name, value] of required) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`contribution.${name} must be a non-empty string`);
    }
  }
  if (
    core.kind !== 'merge' &&
    core.kind !== 'review' &&
    core.kind !== 'release'
  ) {
    throw new TypeError(
      "contribution.kind must be 'merge', 'review', or 'release'"
    );
  }
}

// Deterministic bytes both signatures cover: the domain tag followed by the six
// core fields in a fixed order. Throws on non-canonical input.
export function canonicalContribution(core: ContributionCore): Uint8Array {
  assertCanonical(core);
  return new TextEncoder().encode(
    JSON.stringify([
      CONTRIBUTION_DOMAIN,
      core.subject,
      core.host,
      core.repo,
      core.ref,
      core.kind,
      core.at,
    ])
  );
}

// Build a dual-signed contribution: the subject and the host each sign the same
// canonical core, their dids derived from the identities they signed with.
export function signContribution(
  fields: ContributionFields,
  subject: Identity,
  host: Identity
): Contribution {
  const core: ContributionCore = {
    ...fields,
    subject: subject.did,
    host: host.did,
  };
  const bytes = canonicalContribution(core);
  return {
    ...fields,
    subject: subject.did,
    host: host.did,
    subj_sig: subject.sign(bytes),
    host_sig: host.sign(bytes),
  };
}

// Verify one signature under a did, fail-soft: a malformed did or wrong-length
// sig yields false rather than throwing.
function verifyOne(did: string, bytes: Uint8Array, sig: Uint8Array): boolean {
  try {
    return PublicIdentity.fromDid(did).verify(bytes, sig);
  } catch {
    return false;
  }
}

// Verify a contribution from its own fields + dids — no trust in any server.
// Non-canonical fields render both false; otherwise each side is checked
// independently so a malformed did on one side does not zero the other.
export function verifyContribution(c: Contribution): Verification {
  let bytes: Uint8Array;
  try {
    bytes = canonicalContribution(c);
  } catch {
    return { authentic: false, attested: false };
  }
  return {
    authentic: verifyOne(c.subject, bytes, c.subj_sig),
    attested: verifyOne(c.host, bytes, c.host_sig),
  };
}
```

`packages/reputation/src/index.ts`:

```ts
export {
  canonicalContribution,
  signContribution,
  verifyContribution,
} from './contribution';
export type {
  Contribution,
  ContributionFields,
  ContributionKind,
  Verification,
} from './contribution';
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `AGENT=1 moon run reputation:test` Expected: PASS — all seven contribution
tests green.

- [ ] **Step 8: Typecheck and build**

Run: `moon run reputation:typecheck && moon run reputation:build` Expected: both
succeed; `packages/reputation/dist/index.js` and `index.d.ts` exist.

- [ ] **Step 9: Commit**

```bash
git add packages/reputation bun.lock
git commit -m "feat(reputation): dual-signed Contribution record (Pillar 07)

New package @thaddeus.run/reputation. contribution.ts defines the
Contribution record and canonicalContribution/signContribution/
verifyContribution: both subj_sig and host_sig cover one domain-tagged
canonical core (subject, host, repo, ref, kind, at) with dids derived
from the signers. verifyContribution returns { authentic, attested },
fail-soft on malformed dids. Composes only @thaddeus.run/identity.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 2: `ReputationLog` — the untrusted, keep-and-label aggregator

Add `reputationlog.ts`: `append` (keep-and-label, idempotent on full content),
`forSubject` (deterministic), `verify`, and `profile` (partition into
`attested`/`claimed`, count the attested set `byKind`).

**Files:**

- Create: `packages/reputation/src/reputationlog.ts`
- Modify: `packages/reputation/src/index.ts` (export `ReputationLog`, `Profile`)
- Test: `packages/reputation/test/reputationlog.test.ts`

**Interfaces:**

- Consumes: `Contribution`, `ContributionKind`, `Verification`,
  `verifyContribution` from `./contribution`.
- Produces:
  - `interface Profile { readonly subject: string; readonly attested: readonly Contribution[]; readonly claimed: readonly Contribution[]; readonly byKind: Readonly<Record<ContributionKind, number>>; }`
  - `class ReputationLog` with `append(c: Contribution): void`,
    `forSubject(subject: string): readonly Contribution[]`,
    `verify(c: Contribution): Verification`,
    `profile(subject: string): Profile`.

- [ ] **Step 1: Write the failing test**

`packages/reputation/test/reputationlog.test.ts`:

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  type Contribution,
  type ContributionFields,
  signContribution,
} from '../src/contribution';
import { ReputationLog } from '../src/reputationlog';

beforeAll(async () => {
  await ready();
});

const fields = (
  over: Partial<ContributionFields> = {}
): ContributionFields => ({
  repo: 'acme/web',
  ref: 'op-1',
  kind: 'merge',
  at: '2026-06-24T00:00:00.000Z',
  ...over,
});

describe('ReputationLog — aggregate, verify, profile', () => {
  test('cross-instance honoring: a contribution verifies on a fresh log', () => {
    const alice = Identity.create();
    const instanceA = Identity.create();
    const c = signContribution(fields(), alice, instanceA);

    // instanceB shares NO state with the minter — only the dids in the record.
    const instanceB = new ReputationLog();
    instanceB.append(c);
    expect(instanceB.verify(c)).toEqual({ authentic: true, attested: true });
    expect(instanceB.forSubject(alice.did)).toHaveLength(1);
  });

  test('append keeps invalid records and is idempotent on full content', () => {
    const alice = Identity.create();
    const host = Identity.create();
    const stray = Identity.create();
    const c = signContribution(fields(), alice, host);
    // Non-authentic: subj_sig replaced with a stray key's signature.
    const forged: Contribution = {
      ...c,
      subj_sig: stray.sign(new Uint8Array([1])),
    };

    const log = new ReputationLog();
    log.append(forged);
    log.append(forged); // identical → no duplicate
    expect(log.forSubject(alice.did)).toHaveLength(1); // kept, not rejected
  });

  test('profile partitions attested / claimed / dropped and counts byKind', () => {
    const alice = Identity.create();
    const host = Identity.create();
    const stray = Identity.create();

    // (1) attested: both sigs valid, kind merge.
    const attested = signContribution(fields({ ref: 'op-a' }), alice, host);
    // (2) claimed: authentic (subj_sig intact), but host_sig is from the wrong
    // key, so it does not verify under the record's `host` did.
    const base = signContribution(fields({ ref: 'op-b' }), alice, host);
    const claimed: Contribution = {
      ...base,
      host_sig: stray.sign(new Uint8Array([9])),
    };
    // (3) dropped: not authentic (subj_sig from the wrong key).
    const dropped: Contribution = {
      ...signContribution(fields({ ref: 'op-c', kind: 'review' }), alice, host),
      subj_sig: stray.sign(new Uint8Array([7])),
    };

    const log = new ReputationLog();
    log.append(attested);
    log.append(claimed);
    log.append(dropped);

    const p = log.profile(alice.did);
    expect(p.attested.map((c) => c.ref)).toEqual(['op-a']);
    expect(p.claimed.map((c) => c.ref)).toEqual(['op-b']);
    expect(p.byKind.merge).toBe(1);
    expect(p.byKind.review).toBe(0);
    expect(p.byKind.release).toBe(0);
  });

  test('forSubject returns a deterministic order regardless of append order', () => {
    const alice = Identity.create();
    const host = Identity.create();
    const c1 = signContribution(fields({ ref: 'op-1' }), alice, host);
    const c2 = signContribution(fields({ ref: 'op-2' }), alice, host);
    const c3 = signContribution(fields({ ref: 'op-3' }), alice, host);

    const a = new ReputationLog();
    [c1, c2, c3].forEach((c) => a.append(c));
    const b = new ReputationLog();
    [c3, c1, c2].forEach((c) => b.append(c));

    expect(a.forSubject(alice.did).map((c) => c.ref)).toEqual(
      b.forSubject(alice.did).map((c) => c.ref)
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENT=1 moon run reputation:test` Expected: FAIL — cannot resolve
`../src/reputationlog`.

- [ ] **Step 3: Write `reputationlog.ts`**

`packages/reputation/src/reputationlog.ts`:

```ts
import {
  type Contribution,
  type ContributionKind,
  type Verification,
  verifyContribution,
} from './contribution';

// A gathered, verified profile. Reputation IS this record set, not a number:
// `attested` is the trustworthy set (a host vouched for it), `claimed` is
// self-asserted but unattested, and byKind counts only the attested records.
export interface Profile {
  readonly subject: string;
  readonly attested: readonly Contribution[];
  readonly claimed: readonly Contribution[];
  readonly byKind: Readonly<Record<ContributionKind, number>>;
}

// A total key over every field, so dedup is on full content (not on a sig that a
// forged record could reuse). Uint8Arrays encode as plain number arrays so the
// key is stable and JSON-encodable.
function contentKey(c: Contribution): string {
  return JSON.stringify([
    c.subject,
    c.host,
    c.repo,
    c.ref,
    c.kind,
    c.at,
    Array.from(c.subj_sig),
    Array.from(c.host_sig),
  ]);
}

// Deterministic order: (at, ref, kind), then the full content key as a tiebreak.
function byOrder(a: Contribution, b: Contribution): number {
  const ka = `${a.at} ${a.ref} ${a.kind}`;
  const kb = `${b.at} ${b.ref} ${b.kind}`;
  if (ka !== kb) {
    return ka < kb ? -1 : 1;
  }
  const ca = contentKey(a);
  const cb = contentKey(b);
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

// The untrusted aggregator: an indexer over signed records gathered from
// anywhere. Keep-and-label — every record is kept regardless of validity, and
// the verifier checks signatures itself. Spike — in-memory, single process.
export class ReputationLog {
  readonly #records: Map<string, Contribution> = new Map();

  // Ingest a record, keep it regardless of validity, idempotent on full content.
  append(c: Contribution): void {
    this.#records.set(contentKey(c), c);
  }

  // Every known record bearing `subject` (any validity), deterministic order.
  forSubject(subject: string): readonly Contribution[] {
    return [...this.#records.values()]
      .filter((c) => c.subject === subject)
      .sort(byOrder);
  }

  // Check a record's two signatures against the dids it carries.
  verify(c: Contribution): Verification {
    return verifyContribution(c);
  }

  // Partition `subject`'s records: attested (authentic ∧ attested), claimed
  // (authentic ∧ ¬attested); non-authentic records are dropped (not the
  // subject's claim). byKind counts the attested set.
  profile(subject: string): Profile {
    const attested: Contribution[] = [];
    const claimed: Contribution[] = [];
    const byKind: Record<ContributionKind, number> = {
      merge: 0,
      review: 0,
      release: 0,
    };
    for (const c of this.forSubject(subject)) {
      const v = verifyContribution(c);
      if (!v.authentic) {
        continue;
      }
      if (v.attested) {
        attested.push(c);
        byKind[c.kind] += 1;
      } else {
        claimed.push(c);
      }
    }
    return { subject, attested, claimed, byKind };
  }
}
```

- [ ] **Step 4: Update `index.ts` to export the aggregator**

`packages/reputation/src/index.ts` — add the aggregator exports (keep the
existing contribution exports):

```ts
export {
  canonicalContribution,
  signContribution,
  verifyContribution,
} from './contribution';
export type {
  Contribution,
  ContributionFields,
  ContributionKind,
  Verification,
} from './contribution';
export { ReputationLog } from './reputationlog';
export type { Profile } from './reputationlog';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `AGENT=1 moon run reputation:test` Expected: PASS — contribution +
reputationlog tests green.

- [ ] **Step 6: Typecheck and build**

Run: `moon run reputation:typecheck && moon run reputation:build` Expected: both
succeed.

- [ ] **Step 7: Commit**

```bash
git add packages/reputation
git commit -m "feat(reputation): ReputationLog — untrusted keep-and-label aggregator

append keeps every record (idempotent on full content); forSubject is
deterministic; profile partitions a subject's records into attested
(authentic + host-attested) and claimed (authentic only), drops
non-authentic ones, and counts the attested set byKind. No trust in the
aggregator — verification checks signatures against the dids in the record.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 3: Extend the north-star — a landed op mints a verifiable contribution

Add a P07 step to the seeded flow: after the edit lands into `main` (P06), mint
a `'merge'` `Contribution` for the landed op and assert it verifies on a second,
fresh `ReputationLog`. The flow goes from 5 to 6 pass / 0 todo.

**Files:**

- Modify: `integration/package.json` (add the `@thaddeus.run/reputation`
  dependency)
- Modify: `integration/test/one-edit-end-to-end.test.ts` (add import; add one
  new test)

**Interfaces:**

- Consumes: `signContribution`, `ReputationLog` from `@thaddeus.run/reputation`;
  `Platform`, `blockOnConflict` from `@thaddeus.run/platform` (already
  imported); `Workspace` from `@thaddeus.run/fs` and `Identity` (already
  imported).

- [ ] **Step 1: Add the dependency**

Edit `integration/package.json` `dependencies` to include the reputation package
(keep alphabetical order — `reputation` sorts between `platform` and `store`):

```json
  "dependencies": {
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

Edit `integration/test/one-edit-end-to-end.test.ts`. Add, immediately after the
existing `import { blockOnConflict, Platform } from '@thaddeus.run/platform';`
line:

```ts
import { ReputationLog, signContribution } from '@thaddeus.run/reputation';
```

> **Import order:** `oxlint`/`oxfmt` sort imports alphabetically by module path;
> `@thaddeus.run/reputation` sorts after `@thaddeus.run/platform`. If the
> formatter reorders the block on `root:format`, accept its order.

- [ ] **Step 4: Add the P07 north-star test**

In `integration/test/one-edit-end-to-end.test.ts`, add this test immediately
after the first test (the `P05/P06/P01` land-under-policy test), inside the same
`describe` block:

```ts
test('P06/P07: a landed op mints a merge Contribution verifiable on another instance', async () => {
  const repo = new Platform().createRepo('acme/web');
  const author = Identity.create();
  const instance = Identity.create(); // the host that attests the landing

  // Land an edit (P05/P06), exactly as the canonical flow does.
  const ws = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: author,
    name: 'feat/refresh',
  });
  ws.write('src/auth.rs', new TextEncoder().encode('fn refresh() {}'));
  const [op] = await ws.commit(author);
  const result = await repo.land({
    from: 'feat/refresh',
    into: 'main',
    author,
    policy: blockOnConflict,
  });
  expect(result.landed).toBe(true);
  expect(op).toBeDefined();

  // P07: mint a 'merge' contribution for the landed op — the author claims it,
  // the instance attests it. Then honor it on a SECOND instance with no shared
  // state: reputation travels as signed records, verified from the dids alone.
  if (op != null) {
    const contribution = signContribution(
      {
        repo: repo.name,
        ref: op.id,
        kind: 'merge',
        at: '2026-06-24T00:00:00.000Z',
      },
      author,
      instance
    );

    const elsewhere = new ReputationLog();
    elsewhere.append(contribution);
    expect(elsewhere.verify(contribution)).toEqual({
      authentic: true,
      attested: true,
    });

    const profile = elsewhere.profile(author.did);
    expect(profile.attested).toHaveLength(1);
    expect(profile.attested[0]?.ref).toBe(op.id);
    expect(profile.byKind.merge).toBe(1);
  }
});
```

- [ ] **Step 5: Run the north-star suite to verify it passes**

Run: `AGENT=1 moon run integration:test` Expected: PASS — 6 tests pass, 0 todo;
the new test exercises `Workspace` → `Repo.land` → `signContribution` →
cross-instance `ReputationLog`.

- [ ] **Step 6: Commit**

```bash
git add integration
git commit -m "test(integration): a landed op mints a verifiable contribution (P07)

Extend the north-star: after the seeded edit lands into main (P06), mint a
'merge' Contribution for the landed op (author claims, instance attests)
and honor it on a second, fresh ReputationLog — verified from the dids
alone, no shared state. Flow goes to 6 pass / 0 todo.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 4: The reputation demo (`examples/reputation/`)

Add a runnable CLI demo (sibling to `examples/platform/`) enacting the four acts
from spec §9: mint & verify, cross-instance honoring, forgery detection, and
portability.

**Files:**

- Create: `examples/reputation/package.json`
- Create: `examples/reputation/moon.yml`
- Create: `examples/reputation/tsconfig.json`
- Create: `examples/reputation/src/reputation.ts`

**Interfaces:**

- Consumes: `Identity`, `ready` from `@thaddeus.run/identity`; `ReputationLog`,
  `signContribution`, `verifyContribution` from `@thaddeus.run/reputation`.

- [ ] **Step 1: Create the example config files**

`examples/reputation/package.json`:

```json
{
  "name": "@thaddeus.run/example-reputation",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/reputation": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "catalog:"
  }
}
```

`examples/reputation/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

id: 'example-reputation'
language: 'typescript'
layer: 'application'

tasks:
  # No test suite yet; keep `moon run :test` green repo-wide.
  test:
    args: '--pass-with-no-tests'

  # Build-graph-connected, so CI-skipped; run in agent shells with a CI= prefix.
  demo:
    command: 'bun src/reputation.ts'
    deps:
      - '^:build'
    options:
      cache: false
      runInCI: 'skip'
```

`examples/reputation/tsconfig.json`:

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

`examples/reputation/src/reputation.ts`:

```ts
// Reputation demo for @thaddeus.run/reputation (Pillar 07).
// Run: CI= moon run example-reputation:demo
//
// Four acts: (1) mint & verify a dual-signed contribution; (2) cross-instance
// honoring — a second instance verifies it with no shared state; (3) the
// verifier catches forgery — a tampered field is not authentic, a self-claimed
// record is authentic-but-not-attested; (4) portability — the same profile is
// computed anywhere.

import { Identity, ready } from '@thaddeus.run/identity';
import {
  type Contribution,
  ReputationLog,
  signContribution,
  verifyContribution,
} from '@thaddeus.run/reputation';

const rule = (): void => console.log('—'.repeat(60));

await ready();
const alice = Identity.create(); // the contributor (subject)
const instanceA = Identity.create(); // the host that attests it happened on A

// Act 1 — mint & verify.
const c = signContribution(
  {
    repo: 'a.example/acme/web',
    ref: 'op-7f2a',
    kind: 'merge',
    at: '2026-06-24T09:00:00.000Z',
  },
  alice,
  instanceA
);
rule();
console.log(
  '1. a dual-signed contribution (alice claims, instance A attests):'
);
console.log('   verify:', verifyContribution(c));

// Act 2 — cross-instance honoring.
const instanceB = new ReputationLog(); // shares no state with A; trusts nothing
instanceB.append(c);
rule();
console.log('2. instance B honors it with no shared state — only the dids:');
console.log('   B.verify:', instanceB.verify(c));
console.log(
  '   B.profile(alice).attested:',
  instanceB.profile(alice.did).attested.length
);

// Act 3 — the verifier catches forgery.
const tampered: Contribution = { ...c, repo: 'evil.example/acme/web' };
const stray = Identity.create();
const claimed: Contribution = {
  ...c,
  host_sig: stray.sign(new Uint8Array([1, 2, 3])),
};
rule();
console.log('3. the verifier catches forgery (no server needed):');
console.log('   tampered repo →', verifyContribution(tampered));
console.log('   self-claimed (bad host_sig) →', verifyContribution(claimed));

// Act 4 — portability: the same records yield the same profile anywhere.
instanceB.append(claimed);
const profile = instanceB.profile(alice.did);
rule();
console.log('4. portability — reputation is the gathered record set:');
console.log(
  '   attested:',
  profile.attested.length,
  '| claimed:',
  profile.claimed.length
);
console.log('   byKind:', profile.byKind);

rule();
console.log('Acceptance: a contribution is verifiable from the dids alone;');
console.log('any instance honors it without trusting the one that relayed it.');
```

- [ ] **Step 3: Install and run the demo**

Run: `bun install && CI= moon run example-reputation:demo` Expected: prints four
acts; Act 1 shows `verify: { authentic: true, attested: true }`; Act 2 shows
`B.verify` both true and `attested: 1`; Act 3 shows the tampered repo as
`{ authentic: false, attested: false }` and the self-claimed record as
`{ authentic: true, attested: false }`; Act 4 shows `attested: 1 | claimed: 1`
and `byKind: { merge: 1, review: 0, release: 0 }`.

- [ ] **Step 4: Typecheck the example**

Run: `moon run example-reputation:typecheck` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/reputation
git commit -m "docs(reputation): runnable demo — mint, honor, forgery, portability

examples/reputation enacts the four acts: a dual-signed contribution, a
second instance honoring it with no shared state, the verifier catching a
tampered field and an unattested self-claim, and the portable profile.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 5: Update the convergence docs (ARCHITECTURE + CHANGELOG)

Flip the Pillar 07 row to built and record the release + deferred ledger
entries, per spec §12.

**Files:**

- Modify: `ARCHITECTURE.md` (Pillar 07 status row)
- Modify: `CHANGELOG.md` (`[Unreleased] → Added`; Deferred ledger)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `ARCHITECTURE.md` — status row**

In the **Status / traceability** table, change the Pillar 07 row from:

```
| 07 Identity federation / reputation   | _(planned)_          | planned | P13 P19 P20      |
```

to:

```
| 07 Identity federation / reputation   | `reputation`         | built   | P13 P19 P20      |
```

(The `Identity` shared-primitives row already lists `P07 reputation` in its
"Reused by" cell — no change needed there. The formatter reflows column widths;
don't hand-align.)

- [ ] **Step 2: Update `CHANGELOG.md` — the Added entry**

Under `## [Unreleased]` → `### Added`, after the existing
`@thaddeus.run/platform` bullet, add:

```markdown
- `@thaddeus.run/reputation` — portable federated reputation (Pillar 07): the
  dual-signed `Contribution` record (`subj_sig` = the subject claims it,
  `host_sig` = an instance attests it), both over one domain-tagged canonical
  core with dids derived from the signers. `verifyContribution` returns
  `{ authentic, attested }`, fail-soft — any holder of the record + dids
  verifies it alone, with no trust in any server. `ReputationLog` is an
  untrusted, keep-and-label aggregator whose `profile` partitions a subject's
  records into **attested** and **claimed** and counts the attested set `byKind`
  — reputation is the gathered, self-verifying record set, not a number. The
  north-star's landed op now mints a `'merge'` contribution honored on a second
  instance (6 pass / 0 todo).
```

- [ ] **Step 3: Update `CHANGELOG.md` — the Deferred ledger**

In the **Deferred → Scope-cut** ledger, add these entries (place alongside the
existing scope-cut items; match the surrounding structure):

```markdown
- **Reputation network transport / federation wire (P07→later).** Cross-instance
  honoring is demonstrated with two in-memory `ReputationLog`s; the wire that
  ships contribution records (and P06's deferred view/op mirror) between real
  hosts is not built.
- **Two-party co-sign handshake (P07→later).** `signContribution` holds both the
  subject and host keys; the protocol by which a host proposes a record and the
  subject co-signs over the wire is deferred.
- **Reputation scoring / tiers (P07→P09/P10).** `profile` yields the attested
  set and per-kind counts; a derived score or trust tier a merge policy (P10) or
  agent gate (P09) would consume is deferred.
- **Auto-minting contributions from landings (P07).** Reputation stays decoupled
  (depends only on `identity`); wiring a P06 landing to emit a `'merge'`
  contribution is a platform/integration concern, shown only in the north-star
  and demo.
- **Contribution revocation, host allowlist / web-of-trust (P07).** No signed
  retraction; the spike treats every valid `host_sig` as attestation rather than
  distinguishing instances a verifier recognizes.
```

- [ ] **Step 4: Format the docs**

Run: `moon run root:format` Expected: succeeds; Markdown tables/lists reflow
consistently (oxfmt may adjust spacing — that is fine).

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: mark Pillar 07 (reputation) built; changelog + deferred ledger

Flip the Pillar 07 row planned→built (@thaddeus.run/reputation). Record
the release under Added and ledger the deferred items (network transport,
two-party handshake, scoring/tiers→P09/P10, auto-minting, revocation /
host allowlist).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 6: Full-workspace verification

Run the repo-wide baseline so the new package, the north-star step, the demo,
and the docs all land green together.

**Files:** none (verification only).

- [ ] **Step 1: Build the whole workspace**

Run: `moon run :build` Expected: every package builds, including
`@thaddeus.run/reputation`. (Pre-existing/unrelated: `apps/landing` build may
report `missing_outputs` — untouched here, same as prior pillars.)

- [ ] **Step 2: Format and lint the repo**

Run: `moon run root:format root:lint` Expected: both succeed; 0 errors. (Some
pre-existing `require-await` warnings in store/log/fs are expected; no new ones
from `reputation`.)

- [ ] **Step 3: Typecheck the affected projects**

Run:
`moon run reputation:typecheck integration:typecheck example-reputation:typecheck`
Expected: all PASS.

- [ ] **Step 4: Run the affected tests**

Run: `AGENT=1 moon run reputation:test integration:test` Expected: all PASS —
the reputation suite green (Tasks 1–2); integration 6 pass / 0 todo.

- [ ] **Step 5: Confirm nothing else regressed**

Run: `AGENT=1 moon run :test` Expected: the full repo test run is green (0
failures across
identity/store/log/provenance/fs/platform/reputation/integration).

- [ ] **Step 6: Run the demo once more end-to-end**

Run: `CI= moon run example-reputation:demo` Expected: the four acts print as in
Task 4 Step 3.

- [ ] **Step 7: Final commit (only if formatting/lint produced changes)**

```bash
git add -A
git commit -m "chore(reputation): repo-wide format/lint pass for Pillar 07

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

(If `git status` is clean after Step 2, skip this commit.)

---

## Notes for the implementer

- **Why almost no new code:** reputation is mostly composition. `Identity.sign`
  / `PublicIdentity.fromDid` / `PublicIdentity.verify` (P01) do the crypto; the
  `provenance` package (P04) is the exact pattern for a domain-tagged canonical
  record with try/catch fail-soft verification. P07's new code is the
  `Contribution` field set, the dual-signature wrap, and the `ReputationLog`
  partition/tally.
- **Both signatures cover the same bytes.** `signContribution` computes the
  canonical core once and signs it with both keys; `verifyContribution`
  recomputes from the record's own fields. Any mutation of a covered field
  invalidates the affected signature — a changed `subject` breaks `subj_sig`, a
  changed `host` breaks `host_sig`, a changed shared field breaks both.
- **Fail-soft is per-side.** `verifyContribution` computes the canonical bytes
  once (both false if non-canonical), then checks each signature in its own
  try/catch via `verifyOne`, so a malformed `host` did does not zero
  `authentic`.
- **`profile` drops non-authentic records.** A record bearing `subject = X`
  whose `subj_sig` does not match `X` is not X's claim — it appears in
  `forSubject(X)` (it bears X) but counts toward neither `attested` nor
  `claimed`. The Task 2 partition test pins all three buckets.
- **No score, by design.** `profile` returns the attested/claimed record sets
  and per-kind counts of the attested set — never a single number. The brief is
  explicit: reputation is the records.
- **`bun install` after every `package.json` change** (Tasks 1, 3, 4) so
  workspace symlinks resolve before you build or test.
- **Runtime vs type-only deps.** `identity` is a runtime dep (`PublicIdentity`
  is a value via `fromDid`). No other `@thaddeus.run/*` package is needed in
  `reputation`'s `src` — a contribution references an op by id string.
- **Determinism:** tests use `Identity.create()` (fresh keys) but assert only on
  structural facts (authentic/attested booleans, partition membership, byKind
  counts, sorted order), never on specific key bytes — so they are reproducible.

```

```
