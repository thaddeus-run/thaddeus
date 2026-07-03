# Thaddeus — Pillar 10, review-as-policy (test/proof gate) — design

**Date:** 2026-07-01 **Status:** Design — pending user review, then
implementation plan **Product:** Thaddeus **Company/monorepo:** Thaddeus
(`@thaddeus.run/*`) **Source of truth (vision):**
`the-new-age-of-source-control.html`, Pillar 10 (review as policy) **Builds
on:** `docs/specs/2026-06-24-thaddeus-pillar-06-platform-design.md` (the
`LandPolicy` seam),
`docs/specs/2026-06-23-thaddeus-pillar-04-provenance-design.md` (the
`ProvenanceLog` and its `verified` status),
`docs/specs/2026-07-01-thaddeus-pillar-10-review-as-policy-design.md` (the first
P10 gate, `requireReputationTier`, whose slice shape this mirrors)

---

## 1. Context — why this, why now

Pillar 10 makes merge a _function_, not a gesture. The vision names two inputs
to that function: **(a) automated verification** — "types, tests, property
checks, security policy-as-code, and where it matters, formal proof" — and **(b)
the author's signed identity and reputation tier**. The reputation-tier gate
(`requireReputationTier`, shipped) delivered half of (b). This release delivers
the first cut of **(a): a test/proof gate** — a landing is allowed only if every
incoming op carries a signed, verifiable attestation from an automated _checker_
that its checks passed.

Everything the gate needs already exists. Pillar 04 shipped `ProvenanceLog`: a
per-op registry of signed statements about an `Op.id`, each carrying an `actor`
`did:key`, an `actor_kind`, and a render-time `status` of `verified` /
`unverified` (a valid signature vs. not). `requireVerifiedProvenance` already
gates on "every incoming op has _a_ verified record." A checker — a CI runner, a
property-check harness, a proof engine — is just a principal that signs a
provenance record on an op _once its checks pass_. The test/proof gate narrows
`requireVerifiedProvenance` from "any verified why" to "a verified why **from a
checker**." It is the smallest slice that turns P04's signed statements into a
real verification gate over the P06 seam, and it composes with the conflict,
reputation, and delegation gates unchanged.

## 2. Governing principle — _a pure gate over the seam, no new substrate_

No new substrate primitive — exactly as the reputation-tier gate held the line.
The seam (`LandPolicy`), the per-op signed-statement registry (`ProvenanceLog`),
its `verified` status, and per-op attribution (`Op.id`) are all P06/P04's. This
release adds **one pure policy factory** and its wiring (export, tests, demo,
docs), mirroring how `requireVerifiedProvenance` and `requireReputationTier`
shipped.

The rigid calls:

- **A passing check _is_ a verified checker attestation.** The convention: an
  automated checker signs a provenance record on an op only when its checks
  pass. A signed, signature-valid record from that checker _is_ the proof; its
  absence means the op has not been vouched. No new outcome field — presence
  under a checker `actor_kind` carries the meaning, exactly as
  `requireVerifiedProvenance` treats presence of a verified record as the "why."
- **Per-op, all-must-pass.** The gate checks _every_ incoming op; one op lacking
  a verified checker attestation rejects the whole landing. Mirrors
  `requireVerifiedProvenance` / `requireReputationTier` and handles multi-writer
  bundles correctly.
- **Only _verified_ checker records count.** An `unverified` record (bad or
  absent signature) never satisfies the gate — it inherits P04's trust boundary
  for free, just as the tier gate inherits P07's `attested` boundary.
- **Pure and ownership-agnostic.** A total function of
  `(ProvenanceLog, checkerKinds)` over the proposal — no owner concept, no
  registry coupling. Composition (owner-exempt, conflict, reputation,
  delegation) stays the caller's job via `all(...)`.
- **Fail-closed.** Inherited from `Repo.land()`: on reject, `into` is untouched.

### 2.1 No new substrate primitive

| Need                         | Reuses                                                  |
| ---------------------------- | ------------------------------------------------------- |
| the seam                     | `@thaddeus.run/platform` `LandPolicy` / `LandProposal`  |
| the attestation record       | `@thaddeus.run/provenance` `ProvenanceLog.forOp(op.id)` |
| the trust label              | `ProvenanceLog.status(rec)` (`verified` / `unverified`) |
| the checker's identity       | `Provenance.actor_kind` (signed, canonical, P04)        |
| per-op attribution           | `Op.id` (the record's bound target, P03)                |
| composition with other gates | the server's existing `all(...policies)` combinator     |

## 3. The release's job

One package, additive:

- **`@thaddeus.run/platform`** — a new pure `LandPolicy` factory
  `requirePassingChecks(prov, checkerKinds?)` in `src/policy.ts`, exported from
  `src/index.ts`. `@thaddeus.run/provenance` is already a type-only
  devDependency of this file (`requireVerifiedProvenance` uses it), so no new
  dependency is added.
- **Tests** — unit tests in `packages/platform/test/policy.test.ts` and an
  end-to-end land case in `packages/platform/test/land.test.ts`.
- **Demo** — a Pillar 10 step in `examples/platform` (the north-star): an op
  with a verified CI attestation lands; an op without one is gated.
- **Docs** — `packages/platform/README.md` policy list; the roadmap table in
  `docs/plans/2026-06-22-pillar-01-encrypted-capability-store.md` row 10 stays
  in-progress (already set).

Not the job (deferred, §8): server-default wiring / a `--policy` flag;
per-check-kind requirements (require types AND tests AND proof, each a distinct
verified record); a first-class `Check` record with an explicit pass/fail
outcome; the human-veto gate (its own P10 slice).

## 4. Decisions taken (brainstorm outcomes)

1. **Reuse `ProvenanceLog`, no new `Check` primitive** — over minting a
   first-class check-attestation package. P10's governing principle is "no new
   substrate"; a checker's signed statement about an op is exactly what a
   provenance record is. A dedicated `Check` record (explicit `outcome`, named
   check taxonomy) is earmarked for later (§8) once the surface warrants it —
   the same "one number now, ladder later" restraint the tier gate took.
2. **Checker = `actor_kind` predicate** — the gate takes
   `checkerKinds: readonly string[]` (default `['ci']`) and requires each op to
   carry a verified record whose `actor_kind` is one of them. Chosen over a
   fixed `'ci'` literal (too rigid — proof engines, security scanners are
   checkers too) and over an author-DID allowlist (that is the caller's
   composition job, not the gate's).
3. **Presence-of-verified = pass** — over an explicit outcome field. Matches
   `requireVerifiedProvenance` exactly and needs no substrate change. A checker
   signs only on pass; a failing check simply yields no record.
4. **At-least-one qualifying record per op** — over requiring one record per
   named check. The minimal slice mirrors `requireVerifiedProvenance`; the
   all-of-N-checks refinement is deferred (§8), exactly as the tier gate
   deferred a named tier ladder.
5. **Policy stays pure** — no owner concept, no registry coupling; composition
   is the caller's job (exactly like `requireVerifiedProvenance` /
   `requireReputationTier`).

## 5. The policy

`packages/platform/src/policy.ts`:

```ts
// A test/proof gate (Pillar 10): merge gated on automated verification, not a
// human reading a diff. A checker (CI, a property-check harness, a proof
// engine) signs a provenance record on an op only when its checks pass, so a
// VERIFIED record from a checker IS the proof. Allow iff EVERY incoming op
// carries at least one verified provenance record whose actor_kind names a
// checker. `checkerKinds` defaults to ['ci']; an unverified record never counts.
export function requirePassingChecks(
  prov: ProvenanceLog,
  checkerKinds: readonly string[] = ['ci']
): LandPolicy {
  if (checkerKinds.length === 0) {
    throw new RangeError(
      'requirePassingChecks: checkerKinds must be non-empty'
    );
  }
  const kinds = new Set(checkerKinds);
  return (p) => {
    const missing = p.incomingOps.filter(
      (op) =>
        !prov
          .forOp(op.id)
          .some(
            (rec) =>
              kinds.has(rec.actor_kind) && prov.status(rec) === 'verified'
          )
    );
    return missing.length === 0
      ? { allow: true }
      : {
          allow: false,
          reason: `${missing.length} op(s) lack a verified check from ${[
            ...kinds,
          ].join('/')}`,
        };
  };
}
```

- **Data flow:** `land()` builds the proposal → each `incomingOp` carries its
  `id` → the policy reads `prov.forOp(op.id)`, keeps records whose `actor_kind`
  is a checker AND whose `status` is `verified` → allow iff every op has one. No
  mutation; pure over its inputs.
- **Composition:** slots into the server's `all(basePolicy, …)` alongside
  `blockOnConflict`, `requireReputationTier`, and `delegationPolicy` unchanged.

## 6. Edge cases

- **No provenance at all** for an op: `forOp` is empty → no qualifying record →
  rejected. The intended "prove it passed" default.
- **A verified record, but from a non-checker** (a human/agent author's "why",
  `actor_kind` not in `checkerKinds`): does not satisfy the gate — this is the
  precise line between `requireVerifiedProvenance` (any verified why) and this
  gate (a verified why _from a checker_).
- **A checker record with a broken/absent signature** (`unverified`): never
  counts, even though its `actor_kind` matches. Inherits P04's trust boundary.
- **Empty `checkerKinds`**: rejected at construction with a `RangeError`. No
  `actor_kind` could match, so the gate would block every landing — and its
  reason string would truncate to "…lack a verified check from " with nothing
  after "from". A construction-time guard surfaces the misconfiguration
  immediately, mirroring the tier gate's numeric guard.
- **Empty `incomingOps`**: never reaches the policy — `Repo.land()`
  short-circuits with `landed:false` before any policy call.
- **Mixed multi-op bundle**: any single op without a verified checker
  attestation rejects the whole landing; the reason names the count.

## 7. Testing

**Unit (`packages/platform/test/policy.test.ts`)**, using the existing
`proposal(over)` fixture plus a real `ProvenanceLog` seeded via
`prov.record(op, { actorKind: 'ci', … }, checker)`:

- allow when every incoming op has a verified `ci` provenance record;
- reject an op with no provenance record, and the reason names the count;
- reject an op whose only verified record is from a **non-checker** actor_kind
  (a human "why" does not count);
- an **unverified** checker record (tampered signature) does not satisfy the
  gate;
- custom `checkerKinds` (e.g. `['proof']`) gate on that kind;
- multi-op mix (some checked, some not) → reject with the correct count.

**End-to-end (`packages/platform/test/land.test.ts`)**:

- an op with a verified CI attestation lands into `main` (heads advance);
- an op with no attestation is rejected, `main`'s heads are untouched, and
  `LandResult.reason` carries the check message.

## 8. Open items / next primitives

- **Per-check-kind requirements** — require a verified record for _each_ of a
  named set (types AND tests AND proof), not just one qualifying record. Grows
  the signature without breaking it.
- **First-class `Check` record** — an explicit
  `{ op, name, outcome, checker, at, sig }` attestation (its own domain tag, a
  `CheckLog`) if/when an explicit pass/fail outcome and a check taxonomy are
  warranted over the provenance convention.
- **Human veto** — a standing reviewer veto record + a `LandPolicy` that blocks
  any op under it (the other outstanding P10 slice; the vision's "a human keeps
  the standing right to read any change and veto it").
- **Server-default wiring** — expose the gate via a `serve --policy` flag once
  the surface stabilizes (deferred exactly as the other gates are).
