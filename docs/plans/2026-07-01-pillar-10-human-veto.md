# Pillar 10 — Human Veto Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the standing human veto — a new `@thaddeus.run/review` package
(single-signer `Veto` record bound to an `Op.id` + `VetoLog`) and a pure
`blockOnVeto(vetoes, reviewers?)` `LandPolicy` in `@thaddeus.run/platform` that
rejects any landing including a vetoed op, overriding a green policy by
composition.

**Architecture:** A new library package structurally mirroring
`@thaddeus.run/provenance` (single-signer canonical/sign/verify, a keep-invalid
content-deduped in-memory log), plus one pure policy factory at the P06 seam
mirroring `requirePassingChecks`. The policy overrides green gates purely via
the server's existing `all(...)` AND-combinator — no seam change.

**Tech Stack:** TypeScript, Bun test runner, moon task runner, tsdown build; the
`@thaddeus.run/*` workspace (review, platform, identity, log, store, fs).

## Global Constraints

- Package manager is **bun**; never `npm`/`pnpm`/`npx`. Run tasks via **moon**.
- `export AGENT=1` at session start.
- Dependencies use Bun's root `workspaces.catalog`; workspace packages use
  `workspace:*`. Never add version ranges to a package `package.json`.
- Preserve trailing newlines. Commit messages follow Conventional Commits 1.0.0.
- **Verification baseline:** `moon run root:format root:lint`, plus affected
  `moonx review:typecheck`, `moonx review:test`, `moonx platform:typecheck`,
  `moonx platform:test`.
- **The record is single-signer:** the reviewer signs all fields; no host
  co-signature. **The policy stays pure:** a total function of
  `(VetoLog, reviewers)` over the proposal.
- **Only verified vetoes block; a forgery cannot deny service.**
- **Exact reason string:** `` `${vetoed.length} op(s) under a standing veto` ``.

---

## File Structure

**New package `packages/review/`** (mirror `packages/provenance/`):

- `package.json` — name `@thaddeus.run/review`; deps `@thaddeus.run/identity`
  (`workspace:*`); devDeps `@thaddeus.run/log` (`workspace:*`, type-only),
  `@types/bun`, `@typescript/native-preview`, `tsdown`, `typescript` (all
  `catalog:`); `prepublishOnly` → `moon run review:prepublish`.
- `moon.yml`, `tsconfig.json`, `tsdown.config.ts`, `LICENSE.md` — copy from
  `provenance` verbatim (adjust `repository.directory`).
- `README.md` — the veto layer, Pillar 10.
- `src/veto.ts` — `VetoFields`, `Veto`, `canonicalVeto`, `signVeto`,
  `verifyVeto`; domain tag `thaddeus.veto.v1`.
- `src/vetolog.ts` — `VetoLog` (`record` / `append` / `forOp` / `verify` /
  `status`), `VetoStatus`.
- `src/index.ts` — re-export the above.
- `test/veto.test.ts`, `test/vetolog.test.ts`.

**Modify:**

- `packages/platform/package.json` — add `@thaddeus.run/review` devDependency
  (type-only), alphabetical.
- `packages/platform/src/policy.ts` — add `blockOnVeto` + a type-only `VetoLog`
  import.
- `packages/platform/src/index.ts` — re-export `blockOnVeto`.
- `packages/platform/test/policy.test.ts` — a
  `describe('policy — blockOnVeto')`.
- `packages/platform/test/land.test.ts` — one end-to-end land case.
- `examples/platform/src/platform.ts` + `examples/platform/package.json` — Act
  3e demo; add `@thaddeus.run/review` dependency.
- `packages/platform/README.md` — add `blockOnVeto` to the policy sentence.

---

### Task 1: The `@thaddeus.run/review` package (unit-tested)

- [ ] **Step 1:** Scaffold `packages/review/` by copying `provenance`'s
      `moon.yml`, `tsconfig.json`, `tsdown.config.ts`, `LICENSE.md`; write a
      fresh `package.json` (deps above) and `README.md`. Run `bun install` so
      the workspace symlink resolves.

- [ ] **Step 2 (failing tests):** Write `test/veto.test.ts` (sign→verify true;
      tamper each field → false; wrong-key sig → false) and
      `test/vetolog.test.ts` (`record`+`forOp`; `append` keeps an invalid record
      as `unverified`; content-dedup; deterministic `forOp` order). Run
      `AGENT=1 moonx review:test` → FAIL (modules absent).

- [ ] **Step 3 (implement):** Write `src/veto.ts` (mirror `provenance.ts`'s
      `assertCanonical` / `canonical*` / `sign*` / `verify*`, single-signer,
      `thaddeus.veto.v1`), `src/vetolog.ts` (mirror `provenancelog.ts`: `#byOp`
      map, `#contentKey`, `#insert`, sorted `forOp`, `verify`, `status`; **no**
      `Store` — the log is store-free like `ReputationLog`), and `src/index.ts`.
      Run `AGENT=1 moonx review:test` → PASS. `moonx review:typecheck` → clean.

### Task 2: The `blockOnVeto` policy (unit-tested)

- [ ] **Step 1:** Add `@thaddeus.run/review` to `platform`'s devDependencies
      (type-only), `bun install`.

- [ ] **Step 2 (failing tests):** Add `describe('policy — blockOnVeto')` to
      `packages/platform/test/policy.test.ts`: allow when none vetoed; reject a
      verified veto (reason names count); a non-allowed reviewer's veto does not
      block (with `reviewers`); an unverified veto does not block; multi-op
      count. Seed via a `VetoLog` and `signVeto`. Run
      `AGENT=1 moonx platform:test -- policy.test.ts` → FAIL.

- [ ] **Step 3 (implement):** Add `blockOnVeto` (design §5) to `src/policy.ts`
  - a type-only `VetoLog` import; re-export from `src/index.ts` (alphabetical).
    Run the tests → PASS.

### Task 3: End-to-end land case

- [ ] Add `describe('Repo.land — human veto (Pillar 10)')` to `land.test.ts`: an
      un-vetoed op lands; a reviewer records a veto on a second op; landing
      under `allowAll` composed with `blockOnVeto` (via a local `all` or
      nesting) is rejected, `main` untouched, reason contains `veto`. Run →
      PASS.

### Task 4: Demo (Act 3e) + docs

- [ ] Add `@thaddeus.run/review` to `examples/platform/package.json`; add "Act
      3e" — a green landing overridden by a reviewer's standing veto. Run the
      demo (`CI= moonx example-platform:demo`) and confirm the 3e lines.
- [ ] Add `blockOnVeto` to `packages/platform/README.md`; ensure the new package
      README reads cleanly.

### Task 5: Verify + ship

- [ ] `moon run root:format root:lint`
- [ ] `moonx review:typecheck review:test`,
      `moonx platform:typecheck platform:test`,
      `moonx example-platform:typecheck`
- [ ] Commit (Conventional Commits), push, open PR (based on the test/proof
      branch until it merges).
