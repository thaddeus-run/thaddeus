# Thaddeus — Pillar 10, review-as-policy (human veto) — design

**Date:** 2026-07-01 **Status:** Design — pending user review, then
implementation plan **Product:** Thaddeus **Company/monorepo:** Thaddeus
(`@thaddeus.run/*`) **Source of truth (vision):**
`the-new-age-of-source-control.html`, Pillar 10 (review as policy) — "a human
keeps the standing right to _read any change and veto it_, even one a green
policy would merge… Retiring the diff as the mandatory gate must not retire the
veto." **Builds on:**
`docs/specs/2026-06-24-thaddeus-pillar-06-platform-design.md` (the `LandPolicy`
seam), `docs/specs/2026-06-23-thaddeus-pillar-04-provenance-design.md` (the
single-signer signed-record shape this mirrors),
`docs/specs/2026-07-01-thaddeus-pillar-10-review-as-policy-design.md` (whose §8
earmarks this slice: "a standing reviewer veto record… No approval concept
exists yet")

---

## 1. Context — why this, why now

Pillar 10 makes merge a _function_ — policy, proof, and reputation replace one
human reading a diff. The reputation-tier gate and the test/proof gate deliver
the automated half. But the vision is explicit that one human right must survive
the automation: **the standing veto.** "The policy function sets the floor for
what merges automatically; it never strips a person's authority to say no."

This release delivers that veto. A designated reviewer signs a **veto** bound to
an `Op.id`; a `LandPolicy` then rejects any landing that includes a vetoed op —
_even if every other gate is green_. It is the human-in-the-loop backstop that
makes retiring the mandatory-diff-review safe: automation sets the floor, the
veto is the ceiling a person can always lower.

## 2. Governing principle — _a minimal new primitive, a pure gate over the seam_

Unlike the two prior gates, this one **does** add a substrate primitive — and
deliberately so: the reputation-tier design's §8 already found that "no approval
concept exists yet." Neither `Provenance` (the author's own _why_) nor
`Contribution` (a positive, host-attested credit) models a reviewer's unilateral
verdict on _someone else's_ op. So this release adds the smallest such record —
a single-signer `Veto` — mirroring `Provenance`'s canonical/sign/verify shape
exactly, plus one pure policy factory at the seam. The policy itself adds no
substrate.

The rigid calls:

- **A veto is a reviewer's single-signed verdict, bound to an `Op.id`.** No host
  co-signature (unlike `Contribution`): the veto _is_ the reviewer's standing
  authority. Who _may_ veto is the caller's composition concern (the policy's
  optional `reviewers` allowlist), not a field baked into the record.
- **Negative-only.** A `Veto` means exactly "I veto this op." No approve/verdict
  field — "standing approval _required_" is a distinct positive gate, deferred
  (§8). This keeps the record and its meaning unambiguous.
- **Per-op, any-veto-rejects.** The gate checks every incoming op; a single
  standing verified veto on any of them rejects the whole landing. Mirrors the
  seam's per-op idiom and is correct for multi-writer bundles.
- **Only _verified_ vetoes count.** An `unverified` veto (bad/absent signature)
  never blocks — a forged veto cannot deny service. Inherits P04's trust
  boundary.
- **The veto overrides a green policy _by composition_.** `blockOnVeto` slots
  into the server's `all(basePolicy, …)`; because `all(...)` is AND (first
  rejection wins), a standing veto rejects no matter how many other gates pass.
  This is the vision's guarantee realized as ordinary composition — the seam
  needs no special "veto beats everything" path.
- **Pure and fail-closed.** The policy is a total function of
  `(VetoLog, reviewers)` over the proposal; on reject, `Repo.land()` leaves
  `into` untouched.

### 2.1 What's new vs. reused

| Need                     | New / Reuses                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| the veto record + verify | **NEW** `@thaddeus.run/review` — `Veto`, `signVeto`, `verifyVeto`, `VetoLog` (mirrors `@thaddeus.run/provenance`'s single-signer shape) |
| the seam                 | `@thaddeus.run/platform` `LandPolicy` / `LandProposal`                                                                                  |
| per-op attribution       | `Op.id` (the veto's bound target, P03)                                                                                                  |
| the reviewer's identity  | `@thaddeus.run/identity` `did:key` (signs / verifies)                                                                                   |
| composition + override   | the server's existing `all(...policies)` combinator (AND)                                                                               |

## 3. The release's job

Two packages, additive:

- **`@thaddeus.run/review`** (NEW) — a single-signer `Veto` record bound to an
  `Op.id` (`canonicalVeto` / `signVeto` / `verifyVeto`, domain tag
  `thaddeus.veto.v1`) and an in-memory `VetoLog` (`record` / `append` / `forOp`
  / `verify` / `status`), structurally a twin of `ProvenanceLog` (keep-invalid,
  content-dedup, deterministic `forOp` order). `@thaddeus.run/identity` is a
  dependency; `@thaddeus.run/log` a type-only devDependency (for `Op`).
- **`@thaddeus.run/platform`** — a new pure `LandPolicy` factory
  `blockOnVeto(vetoes, reviewers?)` in `src/policy.ts`, exported from
  `src/index.ts`; `@thaddeus.run/review` added as a **type-only devDependency**.
- **Tests** — package unit tests for the record + log; platform unit tests for
  the policy; an end-to-end land case through `Repo.land()`.
- **Demo** — a Pillar 10 step in `examples/platform`: a green landing is
  overridden by a reviewer's standing veto.
- **Docs** — the new package README; `packages/platform/README.md` policy list;
  the roadmap table row 10 stays in-progress.

Not the job (deferred, §8): veto _revocation_ (a signed withdrawal); a positive
"approval required" gate; a server endpoint + review queue to place/list vetoes;
server-default `--policy` wiring.

## 4. Decisions taken (brainstorm outcomes)

1. **A new `Veto` primitive** — over overloading `Provenance` (the author's why)
   or `Contribution` (a positive credit). §8 already found no approval concept
   exists; a reviewer's verdict on another's op is neither of the above. The
   record is minimal and mirrors `Provenance` exactly.
2. **Single-signer, no host attestation** — over `Contribution`'s dual-signer. A
   veto is the reviewer's own standing authority; a host co-sign adds nothing.
   The authorized-reviewer set is the _policy's_ concern (`reviewers`), not the
   record's.
3. **Negative-only, targets an `Op.id`** — over a verdict field or targeting a
   proposal/branch. Matches the seam's per-op idiom; "approval required" is a
   separate future gate.
4. **Override-by-composition** — over a bespoke "veto wins" path in the seam.
   `all(...)` being AND already makes a veto beat any green gate; the vision's
   guarantee falls out of ordinary composition.
5. **Optional `reviewers` allowlist** — `blockOnVeto(vetoes, reviewers?)`: given
   → only those DIDs' vetoes count; omitted → any verified veto counts. Pure;
   who-may-veto stays the caller's policy. Mirrors `requirePassingChecks`'
   `checkerKinds` shape.
6. **Policy stays pure** — no owner concept, no registry coupling; composition
   is the caller's job (exactly like the other gates).

## 5. The record and the policy

`packages/review/src/veto.ts` (mirrors `provenance.ts`):

```ts
export interface VetoFields {
  readonly op: string; // the Op.id being vetoed
  readonly reason: string; // human-readable "why blocked"
  readonly at: string; // ISO 8601
}
export interface Veto extends VetoFields {
  readonly reviewer: string; // = reviewer.did
  readonly sig: Uint8Array; // reviewer over the canonical bytes
}
// Domain tag: 'thaddeus.veto.v1' (never confusable with op/provenance/contribution).
// canonicalVeto → assertCanonical(op, reviewer, reason, at all non-empty) then
//   encode [DOMAIN, op, reviewer, reason, at].
// signVeto(fields, reviewer) → Veto ; verifyVeto(v) → boolean (fail-closed).
```

`packages/platform/src/policy.ts`:

```ts
// The standing human veto (Pillar 10): a reviewer keeps the right to say no to
// any change, even one a green policy would merge. Reject iff ANY incoming op
// carries a verified standing veto (from an allowed reviewer, if `reviewers` is
// given). Composed in the floor via all(...), an AND: a veto overrides every
// green gate. An unverified veto never blocks — a forgery cannot deny service.
export function blockOnVeto(
  vetoes: VetoLog,
  reviewers?: readonly string[]
): LandPolicy {
  const allow = reviewers === undefined ? undefined : new Set(reviewers);
  return (p) => {
    const vetoed = p.incomingOps.filter((op) =>
      vetoes
        .forOp(op.id)
        .some(
          (v) =>
            vetoes.status(v) === 'verified' &&
            (allow === undefined || allow.has(v.reviewer))
        )
    );
    return vetoed.length === 0
      ? { allow: true }
      : {
          allow: false,
          reason: `${vetoed.length} op(s) under a standing veto`,
        };
  };
}
```

## 6. Edge cases

- **No veto on an op**: passes — the default is "not vetoed."
- **A verified veto from a non-allowed reviewer** (when `reviewers` is given):
  does not block — the line between "anyone's veto" and "an authorized
  reviewer's veto" is the `reviewers` allowlist.
- **An unverified veto** (tampered/forged signature): never blocks, even if the
  `reviewer` field names an authorized reviewer. A forgery cannot deny service.
- **`reviewers: []`** (empty allowlist): no reviewer can match → no veto ever
  blocks. A degenerate "no one may veto" config, total and composable.
- **Empty `incomingOps`**: never reaches the policy — `Repo.land()`
  short-circuits before any policy call.
- **Multi-op bundle**: any single vetoed op rejects the whole landing; the
  reason names the count.
- **Green-but-vetoed**: composed as
  `all(requireReputationTier(...), blockOnVeto(...))`, a high-reputation author
  whose op is vetoed is still rejected — the veto is the ceiling.

## 7. Testing

**Package unit (`packages/review/test`)** — mirrors provenance's tests:

- a signed veto verifies; a tampered field (op/reason/at/reviewer) fails
  `verifyVeto`; a wrong-key signature fails.
- `VetoLog`: `record` then `forOp` returns it; `append` keeps an invalid record
  (rendered `unverified`) rather than dropping it; dedup on full content;
  deterministic `forOp` order independent of insertion.

**Platform unit (`packages/platform/test/policy.test.ts`)**:

- allow when no incoming op is vetoed;
- reject when an op has a verified veto, reason names the count;
- a verified veto from a **non-allowed** reviewer does not block (with
  `reviewers` set);
- an **unverified** veto does not block;
- multi-op mix → reject with the correct count.

**End-to-end (`packages/platform/test/land.test.ts`)**:

- an un-vetoed op lands (heads advance);
- a reviewer records a veto on an op; the landing is rejected even under
  `allowAll` composed with `blockOnVeto`, and `main`'s heads are untouched.

## 8. Open items / next primitives

- **Veto revocation** — a signed withdrawal so a reviewer can lift a standing
  veto; the log would then reflect the net state.
- **Approval-required gate** — the positive dual (require a reviewer's signed
  approval before an op may land), a distinct `LandPolicy` over the same record
  family.
- **Server endpoint + review queue** — place/list/notify vetoes over HTTP (the
  reputation-tier and test/proof slices deferred their server wiring the same
  way).
- **Veto scope beyond a single op** — vetoing a symbol, a path, or an author's
  ops in bulk, once a scope taxonomy is warranted.
