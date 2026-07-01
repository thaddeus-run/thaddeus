# Thaddeus — Pillar 10, review-as-policy (reputation-tier gate) — design

**Date:** 2026-07-01 **Status:** Design — pending user review, then
implementation plan **Product:** Thaddeus **Company/monorepo:** Thaddeus
(`@thaddeus.run/*`) **Source of truth (vision):**
`the-new-age-of-source-control.html`, Pillar 10 (review as policy) **Builds
on:** `docs/specs/2026-06-24-thaddeus-pillar-06-platform-design.md` (the
`LandPolicy` seam),
`docs/specs/2026-06-24-thaddeus-pillar-07-reputation-design.md` (the
`ReputationLog`/`Profile`),
`docs/specs/2026-06-25-thaddeus-pillar-09-agents-design.md` (`Op.author` as a
`did:key` principal), `docs/specs/2026-06-30-thaddeus-multi-writer-design.md`
(the `all(...)` composition + delegated land)

---

## 1. Context — why this, why now

The `LandPolicy` seam has been the reserved home for review since Pillar 06:
`Repo.land()` computes a `LandProposal` on a dry-run view and asks a pure
predicate whether the merge is allowed, fail-closed. Three built-ins live there
today — `allowAll`, `blockOnConflict` (the default), and
`requireVerifiedProvenance` (a first taste of "merge is a function of
verification, not a human reading a diff"). Pillar 07 shipped reputation as a
_record set, not a number_: a `ReputationLog.profile(subject)` returns the
`attested` (host-vouched) and `claimed` (self-asserted) contribution sets plus
`byKind` counts of `merge`/`review`/`release`. Pillar 09 made every `Op` carry
an `author` `did:key`. Everything a reputation gate needs is in place; nothing
yet consumes reputation at the seam.

This release delivers the **first Pillar 10 gate: a reputation-tier
`LandPolicy`**. A landing is allowed only if every incoming op was authored by a
principal with enough _proven_ track record — measured as attested `merge`
contributions. It is the smallest slice that turns P07's reputation into a real
merge gate over the P06 seam, and it composes with the existing conflict and
delegation gates unchanged.

## 2. Governing principle — _a pure gate over the seam, no new substrate_

No new substrate primitive. The seam (`LandPolicy`), the reputation aggregator
(`ReputationLog`/`Profile`), and per-op attribution (`Op.author`) are all P06/
P07/P09's. This release adds **one pure policy factory** and its wiring (export,
tests, demo, docs) — mirroring exactly how `requireVerifiedProvenance` shipped
as a platform built-in.

The rigid calls:

- **Per-op, all-must-pass.** The gate checks _every_ incoming op's author; one
  under-tier op rejects the whole landing. This mirrors
  `requireVerifiedProvenance` and handles multi-writer bundles correctly.
- **Only _attested_ merges count.** The tier reads `Profile.byKind.merge`, which
  P07 defines over the host-vouched `attested` set. Self-asserted (`claimed`)
  reputation cannot unlock the gate — the gate inherits P07's trust boundary for
  free.
- **Pure and ownership-agnostic.** The policy takes no notion of "owner"; it is
  a total function of `(ReputationLog, minMerges)` over the proposal.
  Composition (owner-exempt, conflict, delegation) stays the caller's job via
  `all(...)`.
- **Fail-closed.** Inherited from `Repo.land()`: on reject, `into` is untouched.

### 2.1 No new substrate primitive

| Need                         | Reuses                                                      |
| ---------------------------- | ----------------------------------------------------------- |
| the seam                     | `@thaddeus.run/platform` `LandPolicy` / `LandProposal`      |
| the reputation read          | `@thaddeus.run/reputation` `ReputationLog.profile(subject)` |
| the tier signal              | `Profile.byKind.merge` (attested merge count)               |
| per-op attribution           | `Op.author` (`did:key`, signed, P09)                        |
| composition with other gates | the server's existing `all(...policies)` combinator         |

## 3. The release's job

One package, additive:

- **`@thaddeus.run/platform`** — a new pure `LandPolicy` factory
  `requireReputationTier(reps, minMerges)` in `src/policy.ts`, exported from
  `src/index.ts`; `@thaddeus.run/reputation` added as a **type-only
  devDependency** (`src/policy.ts` imports `ReputationLog` via `import type`, so
  no runtime code is pulled in — mirroring the existing type-only
  `@thaddeus.run/provenance` devDependency of `requireVerifiedProvenance`).
- **Tests** — unit tests in `packages/platform/test/policy.test.ts` and an
  end-to-end land case in `packages/platform/test/land.test.ts`.
- **Demo** — a Pillar 10 step in `examples/platform` (the north-star): two
  authors, one over-tier lands, one under-tier is gated.
- **Docs** — `packages/platform/README.md` policy list; the roadmap table in
  `docs/plans/2026-06-22-pillar-01-encrypted-capability-store.md` row 10 marked
  in-progress.

Not the job (deferred, §8): server-default wiring / a `--policy` reputation
flag; a named tier ladder; operator-DID resolution (`registry.operatorOf`) for
agent-authored ops; owner-exemption inside the policy; the human-veto and
test/proof gates — each a later Pillar 10 slice.

## 4. Decisions taken (brainstorm outcomes)

1. **Slice = reputation-tier gate first** (over human-veto or test/proof) — the
   smallest slice that directly consumes P07 + P09, matching the focused-pillar
   cadence.
2. **Tier = threshold on attested merges** — `tierOf` is simply
   `profile.byKind.merge`, compared to a configured `minMerges: number`. Chosen
   over a named tier ladder or a weighted total: one number, directly rewards
   proven landings, trivially explainable in the reason string. A distinct
   `review` threshold can be added later without breaking the signature.
3. **Attribution = per-op author, all-must-pass** — over operator-DID resolution
   or a single landing author. Mirrors the seam's established per-op idiom and
   is correct for multi-writer bundles.
4. **Policy stays pure** — no owner concept, no registry coupling; composition
   is the caller's job (exactly like `requireVerifiedProvenance`).

## 5. The policy

`packages/platform/src/policy.ts`:

```ts
import type { ReputationLog } from '@thaddeus.run/reputation';

// A reputation-tier gate: merge is a function of proven contribution, not a
// human reading a diff. Allow iff EVERY incoming op's author has at least
// `minMerges` ATTESTED merges (host-vouched; self-claimed merges don't count).
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

- **Data flow:** `land()` builds the proposal → each `incomingOp` carries its
  author `did:key` → the policy reads `reps.profile(op.author).byKind.merge` →
  compares to `minMerges` → allow/reject. No mutation; pure over its inputs.
- **Composition:** slots into the server's `all(basePolicy, …)` alongside
  `blockOnConflict` and `delegationPolicy` unchanged.

## 6. Edge cases

- **Unknown / new author** (no records, or no attested merges): `byKind.merge`
  is `0` → rejected whenever `minMerges > 0`. This is the intended "prove
  yourself" behavior.
- **`minMerges: 0`**: every author passes — degenerates to allow-all at the
  reputation dimension (still a valid, composable configuration).
- **Claimed-only reputation**: an author with only self-signed (`claimed`) merge
  records still reads `byKind.merge === 0` (P07 counts only `attested`) →
  rejected. A dedicated test asserts this trust boundary.
- **Empty `incomingOps`**: never reaches the policy — `Repo.land()`
  short-circuits with `landed:false` before any policy call.
- **Mixed multi-author bundle**: any single under-tier author rejects the whole
  landing; the reason names the count of under-tier ops.

## 7. Testing

**Unit (`packages/platform/test/policy.test.ts`)**, using the existing
`proposal(over)` fixture helper plus a real `ReputationLog` seeded with
dual-signed `Contribution`s (host-attested `merge` records):

- allow when every incoming op's author has `≥ minMerges` attested merges;
- reject when one author is below, and the reason names the under-tier count;
- **claimed (unattested) merges do not count** toward the tier;
- `minMerges: 0` allows all;
- multi-author mix (some above, some below) → reject with the correct count.

**End-to-end (`packages/platform/test/land.test.ts`)**:

- a high-reputation author lands into `main` (heads advance);
- a low-reputation author's land is rejected, `main`'s heads are untouched, and
  `LandResult.reason` carries the tier message.

## 8. Open items / next primitives

- **Human veto** — a standing reviewer approval/veto record + a `LandPolicy`
  that checks it (and likely a server endpoint + review queue). No approval
  concept exists yet; the docs earmark this as the "standing human veto" owed to
  P10.
- **Test/proof gate** — extend `requireVerifiedProvenance` into a real
  passing-check/attestation gate.
- **Operator resolution** — for agent-authored ops, credit
  `registry.operatorOf(op.author)`'s reputation; couples a gate to
  `AgentRegistry`.
- **Named tier ladder / review threshold** — grow `tierOf` beyond a single merge
  count once a tier taxonomy is warranted.
- **Server-default wiring** — expose the gate via a `serve --policy` flag once
  the surface stabilizes (deferred exactly as `requireVerifiedProvenance` is).
