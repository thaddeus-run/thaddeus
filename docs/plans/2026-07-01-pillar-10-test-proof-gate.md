# Pillar 10 — Test/Proof Land Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `requirePassingChecks(prov, checkerKinds?)` — a pure `LandPolicy`
that allows a landing only if every incoming op carries at least one _verified_
provenance record authored by a _checker_ (`actor_kind ∈ checkerKinds`, default
`['ci']`). Pillar 10's automated-verification gate over the P06 seam.

**Architecture:** A single new pure policy factory in `@thaddeus.run/platform`'s
`src/policy.ts`, mirroring `requireVerifiedProvenance` exactly (type-only
`ProvenanceLog` dependency — already present, per-op all-must-pass, fail-closed
reason string). It narrows `requireVerifiedProvenance` from "any verified
record" to "a verified record from a checker `actor_kind`." Exported,
unit-tested against `LandProposal` fixtures, exercised end-to-end through
`Repo.land()`, demonstrated in `examples/platform`, and documented. No new
dependency, no server-default wiring.

**Tech Stack:** TypeScript, Bun test runner, moon task runner, the
`@thaddeus.run/*` workspace (platform, provenance, log, store, identity, fs).

## Global Constraints

- Package manager is **bun**; never `npm`/`pnpm`/`npx`. Run tasks via **moon**
  (`moonx <project>:<task>`). Copied verbatim from `AGENTS.md`.
- Set `export AGENT=1` at the start of the terminal session (AI-friendly Bun
  test output).
- Preserve trailing newlines at the end of every file.
- Commit messages follow **Conventional Commits 1.0.0**.
- **Verification baseline** after code changes:
  `moon run root:format root:lint`, plus the affected `moonx platform:typecheck`
  and `moonx platform:test`.
- **The policy stays pure:** a total function of `(ProvenanceLog, checkerKinds)`
  over the proposal — no owner concept, no registry coupling. Composition is the
  caller's job.
- **Only verified checker records count:** an `unverified` record, or a verified
  record from a non-checker `actor_kind`, never satisfies the gate.
- **Exact reason string** (matched by tests and demo):
  `` `${missing.length} op(s) lack a verified check from ${[...kinds].join('/')}` ``.

---

## File Structure

- `packages/platform/src/policy.ts` — **Modify.** Add the `requirePassingChecks`
  factory. `ProvenanceLog` is already imported (type-only) here.
- `packages/platform/src/index.ts` — **Modify.** Re-export
  `requirePassingChecks`.
- `packages/platform/test/policy.test.ts` — **Modify.** Add a
  `describe('policy — requirePassingChecks')` block.
- `packages/platform/test/land.test.ts` — **Modify.** Add one end-to-end land
  case through `Repo.land()`.
- `examples/platform/src/platform.ts` — **Modify.** Add "Act 3d" demonstrating
  the gate.
- `packages/platform/README.md` — **Modify.** Add `requirePassingChecks` to the
  shipped-policies sentence.

No package.json / dependency changes: `@thaddeus.run/provenance` is already a
devDependency of `platform` and a dependency of `examples/platform`.

---

### Task 1: The `requirePassingChecks` policy (unit-tested)

**Files:**

- Modify: `packages/platform/src/policy.ts`
- Modify: `packages/platform/src/index.ts`
- Test: `packages/platform/test/policy.test.ts`

**Interfaces:**

- Consumes: `LandPolicy`, `LandProposal` (from `../src/policy`); `ProvenanceLog`
  (type-only, already imported); `ProvenanceLog.record` / `.forOp` / `.status`
  (test seeding). `OpLog`, `MemoryStore`, `Identity` are already imported in the
  test file.
- Produces:
  `export function requirePassingChecks(prov: ProvenanceLog, checkerKinds?: readonly string[]): LandPolicy`
  — allows iff every `p.incomingOps[i]` has a verified record whose `actor_kind`
  is in `checkerKinds` (default `['ci']`).

- [ ] **Step 1: Write the failing unit tests** — append a
      `describe('policy — requirePassingChecks')` block to
      `packages/platform/test/policy.test.ts` covering: all-checked allow;
      no-record reject (reason names count); verified non-checker record does
      not count; unverified checker record does not count; custom `checkerKinds`
      (`['proof']`); multi-op mix reject. Seed via
      `prov.record(op, { intent, reasoning, actorKind: 'ci' }, checker)`; forge
      an unverified record by tampering a recorded record's `intent` after
      signing.

- [ ] **Step 2: Run the tests to verify they fail** —
      `AGENT=1 moonx platform:test -- policy.test.ts`. Expected: FAIL —
      `requirePassingChecks` not exported.

- [ ] **Step 3: Implement `requirePassingChecks`** in `src/policy.ts` (the code
      in §5 of the design). Add the re-export to `src/index.ts` (keep the export
      list alphabetical).

- [ ] **Step 4: Run the tests to verify they pass** —
      `AGENT=1 moonx platform:test -- policy.test.ts`. Expected: PASS.

### Task 2: End-to-end land case

**Files:**

- Test: `packages/platform/test/land.test.ts`

- [ ] **Step 1:** Add a `describe('Repo.land — test/proof gate (Pillar 10)')`
      case: a repo, a `ProvenanceLog` over `repo.store`, a `ci` checker
      identity. Branch + commit an op; record a `ci` provenance on it; land with
      `requirePassingChecks(prov)` → `landed:true`, heads advance. A second op
      with no provenance → `landed:false`, reason contains `check`, `main`
      unchanged.

- [ ] **Step 2:** Run `AGENT=1 moonx platform:test -- land.test.ts` → PASS.

### Task 3: Demo (Act 3d) + docs

**Files:**

- Modify: `examples/platform/src/platform.ts`
- Modify: `packages/platform/README.md`

- [ ] **Step 1:** Add "Act 3d" to the example: an op with a verified CI
      attestation lands; an op without one is gated. Import
      `requirePassingChecks` (from `../../packages/platform/src` alias used by
      the example) — `ProvenanceLog` is already imported for Act 3b.

- [ ] **Step 2:** Run the example — `CI= moonx example-platform:dev` (or the
      example's run task) — and confirm the 3d lines print the expected landed
      booleans.

- [ ] **Step 3:** Add `requirePassingChecks` to the README shipped-policies
      sentence with a one-clause gloss.

### Task 4: Verify + ship

- [ ] `moon run root:format root:lint`
- [ ] `moonx platform:typecheck` and `moonx platform:test`
- [ ] `moonx example-platform:typecheck` (or the example's check task)
- [ ] Commit (Conventional Commits), push, open PR.
