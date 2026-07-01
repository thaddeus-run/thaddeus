# Pillar 10 — Reputation-Tier Land Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `requireReputationTier(reps, minMerges)` — a pure `LandPolicy` that allows a landing only if every incoming op's author has at least `minMerges` attested `merge` contributions (Pillar 10's first review gate over the P06 seam).

**Architecture:** A single new pure policy factory in `@thaddeus.run/platform`'s `src/policy.ts`, mirroring the existing `requireVerifiedProvenance` exactly (type-only dependency, per-op all-must-pass, fail-closed reason string). It reads `ReputationLog.profile(op.author).byKind.merge` (P07) keyed on `Op.author` (P09). Exported, unit-tested against `LandProposal` fixtures, exercised end-to-end through `Repo.land()`, demonstrated in `examples/platform`, and documented. No server-default wiring.

**Tech Stack:** TypeScript, Bun test runner, moon task runner, the `@thaddeus.run/*` workspace (platform, reputation, identity, log, store, fs).

## Global Constraints

- Package manager is **bun**; never `npm`/`pnpm`/`npx`. Run tasks via **moon** (`moonx <project>:<task>`). Copied verbatim from `AGENTS.md`.
- Set `export AGENT=1` at the start of the terminal session (AI-friendly Bun test output).
- Dependencies use Bun's root `workspaces.catalog`; workspace packages use `workspace:*`. Never add version ranges to package-level `package.json`.
- Preserve trailing newlines at the end of every file.
- Commit messages follow **Conventional Commits 1.0.0**.
- **Verification baseline** after code changes: `moon run root:format root:lint`, plus the affected `moonx platform:typecheck` and `moonx platform:test`.
- **The policy stays pure:** it is a total function of `(ReputationLog, minMerges)` over the proposal — no owner concept, no `AgentRegistry` coupling. Composition is the caller's job.
- **Only attested merges count:** the tier reads `Profile.byKind.merge`, which P07 defines over the host-vouched `attested` set; self-claimed reputation must never unlock the gate.
- **Exact reason string** (matched by tests, demo, and land results): `` `${below.length} op(s) authored below the required tier (${minMerges} attested merge(s))` ``.

---

## File Structure

- `packages/platform/src/policy.ts` — **Modify.** Add the `requireReputationTier` factory + a type-only `ReputationLog` import. This file already owns `allowAll`, `blockOnConflict`, `requireVerifiedProvenance`.
- `packages/platform/src/index.ts` — **Modify.** Re-export `requireReputationTier`.
- `packages/platform/package.json` — **Modify.** Add `@thaddeus.run/reputation` as a **devDependency** (type-only import, mirroring `@thaddeus.run/provenance`).
- `packages/platform/test/policy.test.ts` — **Modify.** Add a `describe('policy — requireReputationTier')` block with a `seedMerges` helper.
- `packages/platform/test/land.test.ts` — **Modify.** Add one end-to-end land case through `Repo.land()`.
- `examples/platform/src/platform.ts` — **Modify.** Add "Act 3c" demonstrating the gate.
- `examples/platform/package.json` — **Modify.** Add `@thaddeus.run/reputation` as a dependency (the demo constructs a `ReputationLog`).
- `packages/platform/README.md` — **Modify.** Add `requireReputationTier` to the shipped-policies sentence.
- `docs/plans/2026-06-22-pillar-01-encrypted-capability-store.md` — **Modify.** Set roadmap row 10 to `platform` / `in progress`.

---

### Task 1: The `requireReputationTier` policy (unit-tested)

**Files:**
- Modify: `packages/platform/package.json` (devDependencies)
- Modify: `packages/platform/src/policy.ts`
- Modify: `packages/platform/src/index.ts`
- Test: `packages/platform/test/policy.test.ts`

**Interfaces:**
- Consumes: `LandPolicy`, `LandProposal` (from `../src/policy`); `ReputationLog`, `signContribution`, `Contribution` (from `@thaddeus.run/reputation`); `Identity`, `OpLog`, `MemoryStore` (test fixtures, already imported in the test file).
- Produces: `export function requireReputationTier(reps: ReputationLog, minMerges: number): LandPolicy` — a `LandPolicy` allowing iff every `p.incomingOps[i].author` has `reps.profile(author).byKind.merge >= minMerges`.

- [ ] **Step 1: Add the reputation devDependency**

Edit `packages/platform/package.json` — add to `devDependencies` (keep alphabetical, before `@types/bun`):

```json
    "@thaddeus.run/provenance": "workspace:*",
    "@thaddeus.run/reputation": "workspace:*",
    "@types/bun": "catalog:",
```

Then install so the workspace symlink resolves:

Run: `bun install`
Expected: completes without error; `@thaddeus.run/reputation` resolves for `platform`.

- [ ] **Step 2: Write the failing unit tests**

Append to `packages/platform/test/policy.test.ts`. First extend the imports at the top of the file — change the reputation-free import block to add these two lines after the existing imports (before `beforeAll`):

```ts
import { type Contribution, ReputationLog, signContribution } from '@thaddeus.run/reputation';
```

And add `requireReputationTier` to the existing `../src/policy` import:

```ts
import {
  allowAll,
  blockOnConflict,
  type LandProposal,
  requireReputationTier,
  requireVerifiedProvenance,
} from '../src/policy';
```

Then append this block to the end of the file (before the final newline):

```ts
// Seed `count` attested (host-vouched) merge contributions for `subject`, each
// with a distinct `ref` so ReputationLog dedup keeps them all.
function seedMerges(
  reps: ReputationLog,
  subject: Identity,
  host: Identity,
  count: number
): void {
  for (let i = 0; i < count; i++) {
    reps.append(
      signContribution(
        {
          repo: 'acme/web',
          ref: `merge-${subject.did}-${i}`,
          kind: 'merge',
          at: '2026-07-01T00:00:00Z',
        },
        subject,
        host
      )
    );
  }
}

describe('policy — requireReputationTier', () => {
  test('allows when every op author meets the tier', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const reps = new ReputationLog();
    const host = Identity.create();
    const author = Identity.create();
    seedMerges(reps, author, host, 3);
    const op = await log.write('main', 'a.rs', enc('fn a() {}'), author);

    const d = await requireReputationTier(reps, 3)(
      proposal({ incomingOps: [op] })
    );
    expect(d.allow).toBe(true);
  });

  test('rejects when an author is below the tier, naming the count', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const reps = new ReputationLog();
    const host = Identity.create();
    const author = Identity.create();
    seedMerges(reps, author, host, 1); // only 1 attested merge, tier needs 3
    const op = await log.write('main', 'b.rs', enc('fn b() {}'), author);

    const d = await requireReputationTier(reps, 3)(
      proposal({ incomingOps: [op] })
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('1 op(s)');
    expect(d.reason).toContain('tier');
  });

  test('claimed (unattested) merges do not count toward the tier', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const reps = new ReputationLog();
    const host = Identity.create();
    const stray = Identity.create();
    const author = Identity.create();
    // authentic (subj_sig intact) but host_sig from the wrong key → claimed,
    // not attested, so it must not count toward byKind.merge.
    const base = signContribution(
      { repo: 'acme/web', ref: 'op-x', kind: 'merge', at: '2026-07-01T00:00:00Z' },
      author,
      host
    );
    const claimed: Contribution = {
      ...base,
      host_sig: stray.sign(new Uint8Array([9])),
    };
    reps.append(claimed);
    const op = await log.write('main', 'c.rs', enc('fn c() {}'), author);

    const d = await requireReputationTier(reps, 1)(
      proposal({ incomingOps: [op] })
    );
    expect(d.allow).toBe(false);
  });

  test('minMerges of 0 allows any author', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const reps = new ReputationLog(); // empty — the author has no records
    const author = Identity.create();
    const op = await log.write('main', 'd.rs', enc('fn d() {}'), author);

    const d = await requireReputationTier(reps, 0)(
      proposal({ incomingOps: [op] })
    );
    expect(d.allow).toBe(true);
  });

  test('a mixed bundle rejects with the count of under-tier ops', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const reps = new ReputationLog();
    const host = Identity.create();
    const senior = Identity.create();
    const junior = Identity.create();
    seedMerges(reps, senior, host, 5);
    seedMerges(reps, junior, host, 1);
    const opSenior = await log.write('main', 'e.rs', enc('fn e() {}'), senior);
    const opJunior = await log.write('main', 'f.rs', enc('fn f() {}'), junior);

    const d = await requireReputationTier(reps, 3)(
      proposal({ incomingOps: [opSenior, opJunior] })
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('1 op(s)');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `AGENT=1 moonx platform:test -- policy.test.ts`
Expected: FAIL — `requireReputationTier` is not exported from `../src/policy` (`SyntaxError`/`undefined is not a function`).

- [ ] **Step 4: Implement the policy**

In `packages/platform/src/policy.ts`, add the type-only import near the top (after the existing `provenance` type import on line 2):

```ts
import type { ReputationLog } from '@thaddeus.run/reputation';
```

Append to the end of `packages/platform/src/policy.ts` (before the final newline):

```ts
// A reputation-tier gate (Pillar 10): merge is a function of proven
// contribution, not a human reading a diff. Allow iff EVERY incoming op's
// author has at least `minMerges` ATTESTED merges — P07 counts only the
// host-vouched set, so self-claimed reputation can never unlock the gate.
export function requireReputationTier(
  reps: ReputationLog,
  minMerges: number
): LandPolicy {
  return (p) => {
    const below = p.incomingOps.filter(
      (op) => reps.profile(op.author).byKind.merge < minMerges
    );
    return below.length === 0
      ? { allow: true }
      : {
          allow: false,
          reason: `${below.length} op(s) authored below the required tier (${minMerges} attested merge(s))`,
        };
  };
}
```

Then re-export it from `packages/platform/src/index.ts` — add `requireReputationTier` to the value export from `./policy` (keep the existing `allowAll`, `blockOnConflict`, `requireVerifiedProvenance` and the type exports), e.g.:

```ts
export {
  allowAll,
  blockOnConflict,
  requireReputationTier,
  requireVerifiedProvenance,
} from './policy';
```

(Preserve any existing `export type { ... } from './policy';` line unchanged.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `AGENT=1 moonx platform:test -- policy.test.ts`
Expected: PASS — all five `requireReputationTier` tests green, existing policy tests still green.

- [ ] **Step 6: Typecheck, format, lint**

Run: `moonx platform:typecheck && moon run root:format root:lint`
Expected: no type errors; format/lint clean.

- [ ] **Step 7: Commit**

```bash
git add packages/platform/package.json packages/platform/src/policy.ts packages/platform/src/index.ts packages/platform/test/policy.test.ts bun.lock
git commit -m "feat(platform): requireReputationTier land gate (Pillar 10)"
```

(If `bun install` did not change `bun.lock`, omit it from the `git add`.)

---

### Task 2: End-to-end land through the gate

**Files:**
- Test: `packages/platform/test/land.test.ts`

**Interfaces:**
- Consumes: `requireReputationTier` (from `../src/policy`, Task 1); `ReputationLog`, `signContribution` (from `@thaddeus.run/reputation`); the existing `branch(repo, name, path, body, author)` helper and `Platform` in this file; `repo.land({ from, author, policy })`, `repo.heads('main')`.
- Produces: integration coverage that the composed `Repo.land()` path honors the gate and fails closed (no new exports).

- [ ] **Step 1: Write the end-to-end test**

In `packages/platform/test/land.test.ts`, add these imports after the existing imports:

```ts
import { ReputationLog, signContribution } from '@thaddeus.run/reputation';

import { requireReputationTier } from '../src/policy';
```

Then append this `describe` block to the end of the file (before the final newline):

```ts
describe('Repo.land — reputation-tier gate (Pillar 10)', () => {
  test('a high-reputation author lands; a low-reputation author is gated, main untouched', async () => {
    const repo = new Platform().createRepo('acme/svc');
    const reps = new ReputationLog();
    const host = Identity.create();
    const senior = Identity.create();
    const junior = Identity.create();
    for (let i = 0; i < 3; i++) {
      reps.append(
        signContribution(
          { repo: 'acme/svc', ref: `m-${i}`, kind: 'merge', at: '2026-07-01T00:00:00Z' },
          senior,
          host
        )
      );
    }
    const gate = requireReputationTier(reps, 3);

    await branch(repo, 'senior/feat', 'src/a.rs', 'fn a() {}', senior);
    const ok = await repo.land({ from: 'senior/feat', author: senior, policy: gate });
    expect(ok.landed).toBe(true);
    expect(repo.heads('main')).toEqual(ok.heads);

    const mainBefore = repo.heads('main');
    await branch(repo, 'junior/feat', 'src/b.rs', 'fn b() {}', junior);
    const blocked = await repo.land({ from: 'junior/feat', author: junior, policy: gate });
    expect(blocked.landed).toBe(false);
    expect(blocked.reason).toContain('tier');
    expect(repo.heads('main')).toEqual(mainBefore);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `AGENT=1 moonx platform:test -- land.test.ts`
Expected: PASS — the high-rep land re-points `main`; the low-rep land is rejected with a `tier` reason and `main` is unchanged. (This is integration coverage over the already-unit-tested policy; a failure here means the composed `land()` path does not thread the policy as expected — investigate before proceeding.)

- [ ] **Step 3: Format and lint**

Run: `moon run root:format root:lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/platform/test/land.test.ts
git commit -m "test(platform): reputation-tier gate lands over Repo.land end-to-end"
```

---

### Task 3: Demonstrate the gate in the north-star example

**Files:**
- Modify: `examples/platform/package.json` (dependencies)
- Modify: `examples/platform/src/platform.ts`

**Interfaces:**
- Consumes: `requireReputationTier` (from `@thaddeus.run/platform`, Task 1); `ReputationLog`, `signContribution` (from `@thaddeus.run/reputation`); the demo's existing `alice`, `enc`, `rule`, `platform`, and `Workspace` bindings.
- Produces: an "Act 3c" console section proving a high-rep author lands while a newcomer is gated.

- [ ] **Step 1: Add the reputation dependency to the example**

Edit `examples/platform/package.json` — add to `dependencies` (keep alphabetical, after `@thaddeus.run/provenance`):

```json
    "@thaddeus.run/provenance": "workspace:*",
    "@thaddeus.run/reputation": "workspace:*"
```

Run: `bun install`
Expected: completes without error.

- [ ] **Step 2: Extend the example imports**

In `examples/platform/src/platform.ts`, add `requireReputationTier` to the `@thaddeus.run/platform` named import:

```ts
import {
  blockOnConflict,
  Platform,
  type Repo,
  requireReputationTier,
  requireVerifiedProvenance,
} from '@thaddeus.run/platform';
```

And add a reputation import after the `@thaddeus.run/provenance` import line:

```ts
import { ReputationLog, signContribution } from '@thaddeus.run/reputation';
```

- [ ] **Step 3: Add Act 3c**

In `examples/platform/src/platform.ts`, immediately after the Act 3b console block (the three `console.log` lines ending with `` `   with a verified record → landed: ${withWhy.landed}` ``) and before the `// Act 4 — the mirror property.` comment, insert:

```ts
// Act 3c — a reputation-tier gate (Pillar 10): merge gated on a proven track
// record, not a human reading a diff. A senior author (3 attested merges)
// lands; a newcomer (0 attested merges) is gated.
const svc = platform.createRepo('acme/svc');
const reps = new ReputationLog();
const attester = Identity.create();
for (let i = 0; i < 3; i++) {
  reps.append(
    signContribution(
      { repo: 'acme/svc', ref: `merge-${i}`, kind: 'merge', at: '2026-07-01T00:00:00Z' },
      alice,
      attester
    )
  );
}
const tier = requireReputationTier(reps, 3);

const seniorWs = Workspace.open(svc.log, svc.store, {
  source: 'main',
  reader: alice,
  name: 'alice/feat',
});
seniorWs.write('src/feat.rs', enc('fn feat() {}'));
await seniorWs.commit(alice);
const seniorLand = await svc.land({
  from: 'alice/feat',
  author: alice,
  policy: tier,
});

const newcomer = Identity.create();
const newcomerWs = Workspace.open(svc.log, svc.store, {
  source: 'main',
  reader: newcomer,
  name: 'newcomer/feat',
});
newcomerWs.write('src/other.rs', enc('fn other() {}'));
await newcomerWs.commit(newcomer);
const newcomerLand = await svc.land({
  from: 'newcomer/feat',
  author: newcomer,
  policy: tier,
});
rule();
console.log('3c. requireReputationTier — merge gated on proven track record:');
console.log(`   senior (3 attested merges) → landed: ${seniorLand.landed}`);
console.log(
  `   newcomer (0) → landed: ${newcomerLand.landed} (${newcomerLand.reason})`
);
```

- [ ] **Step 4: Run the demo to verify the output**

Run: `CI= moon run example-platform:demo`
Expected: the run prints an "3c. requireReputationTier …" section showing `senior … → landed: true` and `newcomer (0) → landed: false (… authored below the required tier …)`, then proceeds to Act 4 and the acceptance lines without error.

- [ ] **Step 5: Typecheck, format, lint**

Run: `moonx example-platform:typecheck && moon run root:format root:lint`
Expected: no type errors; clean. (If the example project has no `typecheck` task, skip that half and rely on format/lint + the successful demo run.)

- [ ] **Step 6: Commit**

```bash
git add examples/platform/package.json examples/platform/src/platform.ts bun.lock
git commit -m "docs(example-platform): demo the reputation-tier land gate (Act 3c)"
```

(Omit `bun.lock` if unchanged.)

---

### Task 4: Documentation

**Files:**
- Modify: `packages/platform/README.md`
- Modify: `docs/plans/2026-06-22-pillar-01-encrypted-capability-store.md`

**Interfaces:**
- Consumes: nothing (docs only).
- Produces: the README shipped-policies list includes `requireReputationTier`; the roadmap row 10 reflects in-progress.

- [ ] **Step 1: Update the platform README**

In `packages/platform/README.md`, replace the sentence:

```
untouched). Ships `allowAll`, `blockOnConflict`, and `requireVerifiedProvenance`
— the seam Pillar 10 fills with review and reputation gates.
```

with:

```
untouched). Ships `allowAll`, `blockOnConflict`, `requireVerifiedProvenance`,
and `requireReputationTier` — Pillar 10's first gate, allowing a landing only
when every incoming op's author has enough attested `merge` contributions (P07),
rather than a human reading a diff.
```

- [ ] **Step 2: Update the roadmap row**

In `docs/plans/2026-06-22-pillar-01-encrypted-capability-store.md`, change the Pillar 10 table row:

```
| 10 Review as policy                   | _(planned)_          | planned     | P15 P12          |
```

to:

```
| 10 Review as policy                   | `platform`           | in progress | P15 P12          |
```

- [ ] **Step 3: Format**

Run: `moon run root:format`
Expected: clean (prettier normalizes the table alignment).

- [ ] **Step 4: Commit**

```bash
git add packages/platform/README.md docs/plans/2026-06-22-pillar-01-encrypted-capability-store.md
git commit -m "docs(platform): note requireReputationTier + mark Pillar 10 in progress"
```

---

## Verification (whole feature)

- [ ] `AGENT=1 moonx platform:test` — the full platform suite is green (policy + land).
- [ ] `moonx platform:typecheck` — no type errors.
- [ ] `moon run root:format root:lint` — clean.
- [ ] `CI= moon run example-platform:demo` — Act 3c prints senior-lands / newcomer-gated.
- [ ] Open a PR from `feat/pillar-10-review-as-policy` into `main`.

## Self-Review notes (author)

- **Spec coverage:** §5 policy → Task 1; §6 edge cases (unknown author, `minMerges:0`, claimed-only, mixed bundle) → Task 1 tests + Task 2 e2e; §7 tests → Tasks 1–2; "Demo" → Task 3; "Docs" → Task 4. Deferred items (§8) are explicitly out of scope.
- **Type consistency:** `requireReputationTier(reps: ReputationLog, minMerges: number): LandPolicy` and the reason string are identical across policy, tests, e2e, and demo.
- **Dependency shape:** reputation is a **type-only** import in `policy.ts` → a platform **devDependency** (mirrors `provenance`); the example imports reputation as a **value** → a real dependency.
