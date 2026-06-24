# Thaddeus — Pillar 07: portable identity & federated reputation (design)

**Date:** 2026-06-24 **Status:** Design — pending user review, then
implementation plan **Product:** Strata (working name) · **Company/monorepo:**
Thaddeus (`@thaddeus.run/*`) **Source of truth (vision):**
`the-new-age-of-source-control.html`, Pillar 07 **Builds on:**
`docs/specs/2026-06-22-thaddeus-pillar-01-encrypted-capability-store-design.md`
(identity), `docs/specs/2026-06-23-thaddeus-pillar-04-provenance-design.md` (the
signed-record + log pattern this mirrors)

---

## 1. Context — why this primitive, why now

Strata is an 11-pillar replacement for Git+GitHub, built **one primitive at a
time** (Pillar 01 spec §4). Tier 0 (`identity`, `store`) and Tier 1 (membrane,
operation log) shipped; Tier 2 completed with provenance (P04), the virtual FS
(P05), and the platform (P06). The seeded north-star runs at **5 pass / 0
todo**.

**Pillar 07 — portable identity & federated reputation** is the first Tier-3
primitive, chosen now because:

- **It is the verifiable answer to the brief's "crown jewel" risk.** P13
  (community/identity fractures when leaving GitHub), P19 (the cheap alternative
  is lock-in), and P20 (the platform can be rug-pulled) all resolve through one
  mechanism: reputation as **a set of signed records a verifier gathers and
  checks itself**, not a number a server hands out. When identity and
  contribution history are portable and self-verifying, leaving a host is an
  _export, not an amputation_.
- **It composes the already-shipped `did:key` identity (P01) and the
  signed-record pattern of P04.** An identity is the _same_ self-owned key that
  wraps capabilities (P01) and signs provenance (P04); P07 is its third use.
  This release adds **no new crypto** — it reuses `Identity.sign` /
  `PublicIdentity.verify`.
- **It unblocks the next pillars.** P09 (agent reputation accrual) and P10
  (reputation-tier merge gates) both need a reputation layer to consume; P07 is
  that layer. It also picks up the federation thread P06 deferred (the mirror
  property P06 asserts is the local half; serving between instances is here and
  beyond).
- **It is the right size for one release.** The genuinely large facets — network
  transport, the two-party co-sign handshake, scoring/tiers — are deferred by
  name (§5), each for a concrete reason.

## 2. Governing principle — _stable seams, playground interiors_

Unchanged from Pillars 01–06 (§2): **rigid** = the new package's public API (the
`Contribution` record shape, `signContribution`/`verifyContribution`, the
`ReputationLog` surface) and the north-star flow; **loose** = everything behind
those seams. Consequences here: in-memory only, single process, no persistence,
no network transport, no production hardening.

The genuinely rigid, expensive-to-reverse calls in this release are: **(a)** a
contribution is **dual-signed** with **scoped** cores — `subj_sig` (the subject
claims it) covers the portable work-claim `(subject, repo, ref, kind, at)`, and
`host_sig` (the instance attests it) covers all six fields including `host`; so
the subject's claim is valid no matter which instance attests it (§4, decision
2); **(b)** verification yields **two independent booleans** — `authentic` and
`attested` — and trustworthy reputation counts only the _attested_ set (§4,
decision 3); and **(c)** the aggregator is **keep-and-label** and **untrusted**
— it ingests every record and the verifier checks signatures itself, so honoring
a contribution never requires trusting the aggregator (§4, decision 4). All
three are decided here on purpose.

### 2.1 What the brief asks for, and what is buildable now

The brief's Pillar 07 makes four claims. This release takes a clear position on
each:

1. **Portable, self-owned identity** (already shipped, P01). An identity is a
   `did:key`; P07 adds nothing here — it _uses_ it as the third of three uses.
2. **Contribution history as a signed, aggregatable graph** (buildable now, the
   core). The `Contribution` record is dual-signed and self-verifying; a profile
   is the gathered set of records bearing a subject, verified by anyone.
3. **Instances federate a shared identity/reputation layer** (the _protocol_ is
   buildable; the _transport_ is deferred). Cross-instance honoring is
   demonstrated with two in-memory `ReputationLog`s — a contribution minted on
   "instance A" verifies on "instance B" with zero trust in either. The wire
   that ships records between real instances is deferred (§5), exactly as P06
   deferred the mirror transport.
4. **Governance / portability as the answer to lock-in & rug-pull** (a property
   that falls out of the format, plus a non-code stewardship requirement). The
   portable, content-addressed, self-verifying record _is_ the export mechanism;
   "open core under accountable stewardship" is an ops/governance requirement,
   not something this package encodes (§5).

## 3. The release's job

Introduce `@thaddeus.run/reputation`: the dual-signed contribution record and
the untrusted aggregator. Deliverables:

- The **`Contribution` record** (§6) and
  `ContributionFields`/`ContributionKind`, with `canonicalContribution`,
  `signContribution`, `verifyContribution`.
- **`ReputationLog`** (§6): `append` (keep-and-label, idempotent), `forSubject`,
  `verify`, `profile` (the gathered set partitioned into `attested` / `claimed`,
  with `byKind` counts of the attested set).
- A **reputation CLI demo** (`examples/reputation/`) enacting mint+verify,
  cross-instance honoring, forgery detection, and portability (§9).
- The north-star integration test **extended** with a P07 step: a landed op
  (P06) mints a `'merge'` contribution verifiable on a second instance;
  `ARCHITECTURE.md` Pillar 07 row flipped `planned → built`; the flow goes to
  **6 pass / 0 todo** (§12).

Not the job: network transport/serving, the two-party co-sign handshake,
reputation scoring/tiers, auto-minting from P06 landings as a wired pipeline,
contribution revocation, persistence, governance/stewardship (§5, §11).

## 4. Decisions taken (brainstorm outcomes)

1. **Home — a new package `@thaddeus.run/reputation`** (primary exports the
   `Contribution` record, the sign/verify functions, and `ReputationLog`).
   Neutral, product-agnostic name per the scope convention (AGENTS.md "Naming");
   matches the `ARCHITECTURE.md` Pillar 07 label ("Identity federation /
   reputation"). It consumes **only `@thaddeus.run/identity`** (`Identity`,
   `PublicIdentity`) across its public API — a contribution references an op by
   _id string_, so no `log`/`store` dependency. It mirrors the structure of
   `@thaddeus.run/provenance` (a record module + an aggregator module).

2. **A contribution is dual-signed over scoped, derived cores.** `subject` and
   `host` are the **dids derived from the two signing identities** (mirroring
   how provenance derives `actor`), so a record can never claim a did it did not
   sign with. The two signatures cover **different** domain-tagged tuples:
   `subj_sig` covers the subject's **portable work-claim**
   `(subject, repo, ref, kind, at)` — deliberately **excluding `host`**, so the
   claim stays valid no matter which instance attests it — while `host_sig`
   covers the **full** tuple `(subject, host, repo, ref, kind, at)`, binding the
   host's attestation to who/what it attests.
   `signContribution(fields, subject, host)` takes the non-derived fields plus
   both identities and returns the full record.

3. **Verification yields two booleans; reputation counts the attested set.**
   `verifyContribution(c)` recomputes the canonical core from `c`'s own fields
   and returns `{ authentic, attested }`: `authentic` = `subj_sig` valid for
   `c.subject`, `attested` = `host_sig` valid for `c.host`. Both are
   **fail-soft** — a malformed did or bad signature yields `false`, never throws
   (mirrors provenance's `status`). A profile's _trustworthy_ reputation is
   exactly the **attested** records (authentic ∧ attested); authentic-but-
   unattested records are surfaced as **claimed** (a self-assertion no instance
   vouched for); non-authentic records count toward neither. **No score number**
   is computed — reputation _is_ the attested record set.

4. **`ReputationLog` is keep-and-label and untrusted.** `append` ingests every
   record regardless of validity (so a peer cannot suppress a genuine record by
   withholding judgment) and is idempotent on full content. `forSubject(did)`
   returns every known record bearing that subject, any validity, in a
   deterministic order. The aggregator performs **no trust** —
   `verify`/`profile` check signatures against the dids in the record, so a
   verifier honors a contribution minted elsewhere without trusting the
   aggregator that relayed it. This is the structural property that makes "click
   a username, see everything they've built" a protocol rather than a server
   feature.

5. **Cross-instance honoring is demonstrated, transport is deferred.** Two
   in-memory `ReputationLog`s stand in for two instances; a record minted with
   `host = A` and ingested into B verifies on B from the dids alone. The wire
   that moves records between real instances — and the two-party handshake by
   which a host proposes a record and the subject co-signs it — are deferred
   (§5). The spike's `signContribution` holds both keys at once; the handshake
   is a federation-transport concern.

### 4.1 Why this is almost no new machinery (honest claim)

The reputation graph is mostly _composition_ of primitives P01/P04 already
established:

| P07 capability                | Mechanism (existing)                                                        |
| ----------------------------- | --------------------------------------------------------------------------- |
| self-owned signer/verifier    | `Identity.sign` / `PublicIdentity.verify` (P01)                             |
| did from a record's claim     | `PublicIdentity.fromDid` (P01)                                              |
| signed-record + canonical tag | the `provenance` pattern (P04) — domain tag, assert-canonical, sign, verify |
| keep-and-label aggregator     | `ProvenanceLog`'s ingest/forOp/status shape (P04)                           |

P07's genuinely new code is small: the `Contribution` field set + its canonical
encoding, the dual-signature wrap/verify, and the `ReputationLog`
partition/tally. That is the point — identity was designed for exactly this
third use.

### 4.2 The two canonical cores (the one subtle rule)

There are **two** domain-tagged (`thaddeus.contribution.v1`) encodings, each in
a fixed field order. The **host** core (`canonicalContribution`, the exported
one) is the full six fields — `subject`, `host`, `repo`, `ref`, `kind`, `at`.
The **subject** core is the five-field portable work-claim — `subject`, `repo`,
`ref`, `kind`, `at` — deliberately **excluding `host`**. `subj_sig` signs the
subject core; `host_sig` signs the host core. `verifyContribution` rebuilds each
from the record's own fields, so mutation is caught per scope: a tampered
`subject`/`repo`/`ref`/`kind`/`at` breaks **both** sigs; a tampered `host`
breaks **only** `host_sig` (the subject never signed `host`, so `authentic`
survives — a swapped or malformed host did cannot revoke the subject's claim).
Non-canonical input (empty/wrong-type field) throws in `signContribution` and
renders `false` in `verifyContribution`, mirroring `op.ts`/`provenance.ts`.

## 5. Scope

**In (this release):**

- Package `@thaddeus.run/reputation` with the `Contribution` record,
  `ContributionFields`, `ContributionKind`, `canonicalContribution`,
  `signContribution`, `verifyContribution`.
- `ReputationLog` with `append`, `forSubject`, `verify`, `profile` (`Profile` =
  `{ subject, attested, claimed, byKind }`).
- `examples/reputation/` demo; north-star P07 step; `ARCHITECTURE.md` +
  `CHANGELOG.md`.

**Out (deferred, named so scope stays honest):**

- **Network transport / serving between instances (P07→later).** The wire that
  ships records (and P06's deferred view/op mirror) between real hosts.
  "Instances" are two in-memory `ReputationLog`s here.
- **Two-party co-sign handshake (P07→later).** The protocol by which a host
  proposes a contribution and the subject co-signs over the wire. The spike's
  `signContribution` holds both keys.
- **Reputation scoring / tiers (P07→P09/P10).** A derived score or trust tier a
  merge policy (P10) or agent gate (P09) would consume. The brief insists
  reputation is the set of signed records, not a number; this release computes
  the attested set and counts by kind, nothing more.
- **Auto-minting from P06 landings (pipeline).** Reputation stays decoupled
  (depends only on `identity`, like provenance); the demo and north-star mint
  contributions explicitly. Wiring a landing to emit a `'merge'` contribution is
  a platform/integration concern.
- **Contribution revocation / expiry.** A signed retraction record is a later
  refinement; this release has no revocation.
- **Governance / stewardship.** "Open core under accountable, nonprofit-style
  stewardship" (the P20 answer) is an ops/governance requirement, not code; the
  portable record format is the part this package provides.
- Persistence, production hardening, multi-process concurrency.

## 6. The seam (public API delta)

New package. No changes to `@thaddeus.run/identity` — `reputation` consumes its
existing public surface.

### `@thaddeus.run/reputation`

```ts
import type { Identity } from '@thaddeus.run/identity';

// The kinds of contribution a profile aggregates.
export type ContributionKind = 'merge' | 'review' | 'release';

// The signable, non-derived fields of a contribution.
export interface ContributionFields {
  readonly repo: string; // where it lived, e.g. "forgejo.example/acme/web"
  readonly ref: string; // the op/snapshot id it refers to
  readonly kind: ContributionKind;
  readonly at: string; // ISO 8601 timestamp
}

// A dual-signed contribution record. subject/host dids are derived from the two
// signing identities; subj_sig is the subject's self-claim, host_sig is the
// instance's attestation that it happened there.
export interface Contribution extends ContributionFields {
  readonly subject: string; // = subject.did
  readonly host: string; // = host.did
  readonly subj_sig: Uint8Array;
  readonly host_sig: Uint8Array;
}

// Two independent truths, each checkable by anyone holding the record + dids.
export interface Verification {
  readonly authentic: boolean; // subj_sig valid for `subject`
  readonly attested: boolean; // host_sig valid for `host`
}

// A gathered, verified profile. Reputation IS this record set, not a number.
export interface Profile {
  readonly subject: string;
  readonly attested: readonly Contribution[]; // authentic AND attested
  readonly claimed: readonly Contribution[]; // authentic, NOT host-attested
  readonly byKind: Readonly<Record<ContributionKind, number>>; // attested counts
}

// The HOST canonical bytes (the exported one): domain tag + (subject, host,
// repo, ref, kind, at), the full tuple host_sig covers. Throws on non-canonical
// input. (subj_sig covers a separate five-field core that omits host — internal.)
export function canonicalContribution(
  core: ContributionFields & { subject: string; host: string }
): Uint8Array;

// Build a dual-signed contribution: the subject signs the portable work-claim
// (subject, repo, ref, kind, at) and the host signs the full six-field core
// (their dids derived from the identities). Throws on non-canonical fields.
export function signContribution(
  fields: ContributionFields,
  subject: Identity,
  host: Identity
): Contribution;

// Verify a contribution from its own fields + dids — no trust in any server.
// authentic = subj_sig valid; attested = host_sig valid. Fail-soft: a malformed
// did or bad signature yields false, never throws.
export function verifyContribution(c: Contribution): Verification;

// The untrusted aggregator: an indexer over signed records gathered from
// anywhere. Spike — in-memory, single process, not durable.
export class ReputationLog {
  // Ingest a record, keep it regardless of validity (a peer can't suppress by
  // withholding), idempotent on full content.
  append(c: Contribution): void;

  // Every known record bearing `subject` (any validity), deterministic order.
  forSubject(subject: string): readonly Contribution[];

  // Check a record's two signatures against the dids it carries.
  verify(c: Contribution): Verification;

  // Gather `subject`'s records and partition: attested (authentic ∧ attested),
  // claimed (authentic ∧ ¬attested); non-authentic records count toward neither.
  // byKind counts the attested set by kind.
  profile(subject: string): Profile;
}
```

### 6.1 Signing — the dual signature

`signContribution(fields, subject, host)`:

1. `assertCanonical(fields)` — `repo`/`ref`/`at` non-empty strings, `kind` one
   of the three literals (throws otherwise, like `op.ts`).
2. Derive `subjectDid = subject.did`, `hostDid = host.did`.
3. `subjBytes` = the **five-field** subject core
   `(subject, repo, ref, kind, at)`;
   `hostBytes = canonicalContribution({ ...fields, subject: subjectDid, host: hostDid })`
   (the full six fields).
4. `subj_sig = subject.sign(subjBytes)`, `host_sig = host.sign(hostBytes)`.
5. Return
   `{ ...fields, subject: subjectDid, host: hostDid, subj_sig, host_sig }`.

The two signatures cover **scoped** cores, so each verifies on its own and the
subject's claim is portable: a verifier can accept authenticity while treating
attestation as absent (a record relayed without a trusted host), and
re-attesting the same work on another instance never invalidates the subject's
signature.

### 6.2 Verifying — two booleans, fail-soft

`verifyContribution(c)`:

1. Recompute both cores from the record's own fields — `subjBytes` (five-field
   work-claim) and `hostBytes` (`canonicalContribution(c)`, six fields) —
   wrapped so non-canonical content returns
   `{ authentic: false, attested: false }` rather than throwing.
2. `authentic = PublicIdentity.fromDid(c.subject).verify(subjBytes, c.subj_sig)`,
   each `fromDid`/`verify` wrapped to yield `false` on a malformed did or bad
   sig.
3. `attested = PublicIdentity.fromDid(c.host).verify(hostBytes, c.host_sig)`.
4. Return `{ authentic, attested }`.

This is the federation property in one function: any holder of the record and
the two dids verifies it alone — no aggregator, no server, no shared state.

### 6.3 Aggregating — keep-and-label, partitioned profile

`ReputationLog`:

- `append(c)` inserts `c` keyed on its full content (dedup so re-appending an
  identical record is a no-op); invalid records are kept, not rejected.
- `forSubject(did)` returns every stored record whose `subject === did`, sorted
  deterministically (by `(at, ref, kind)` then content) so order is independent
  of append order.
- `profile(did)` runs `verifyContribution` over `forSubject(did)` and
  partitions: `attested` = authentic ∧ attested, `claimed` = authentic ∧
  ¬attested; a record that is not authentic (its `subj_sig` doesn't match its
  own `subject`) counts toward neither — it is not the subject's claim. `byKind`
  tallies the `attested` list by kind (`merge`/`review`/`release`), each
  defaulting to 0.

## 7. Data model

P07 introduces one new in-memory/wire record (`Contribution`) and one in-memory
index (`ReputationLog`):

```
Contribution (wire record) {
  subject, host: string            // did:key of the contributor / attesting instance
  repo, ref:     string            // where it lived / the op-snapshot id
  kind:          'merge'|'review'|'release'
  at:            string            // ISO 8601
  subj_sig, host_sig: Uint8Array   // independent ed25519 over the canonical core
}
ReputationLog (in-memory) {
  records: Map<contentKey, Contribution>   // keep-and-label; the only state
}
```

There is nothing new to encrypt or store — a contribution is signed cleartext
metadata, gathered and verified, never sealed.

## 8. Crypto choices

**None new.** P07 performs no encryption or hashing of its own. It composes:

- `Identity.sign` (P01) to produce `subj_sig` / `host_sig`.
- `PublicIdentity.fromDid` + `PublicIdentity.verify` (P01) to check them.
- The domain-tag + canonical-tuple discipline of `op.ts`/`provenance.ts`
  (P03/P04) so a contribution signature can never be confused with an op or
  provenance signature.

`canonicalContribution` builds the signable bytes with the domain tag
`thaddeus.contribution.v1`. The package documents that `ready()` (from
`@thaddeus.run/identity`) must be awaited before use, consistent with Tier 0.

## 9. The demo — the reputation graph (CLI)

`examples/reputation/` (sibling to `platform/`, `workspace/`, `provenance/`),
deterministic via injected seeded identities. Four acts:

**Act 1 — mint & verify.** alice (subject) and instance A (host) sign a
`'merge'` contribution for a ref; print `verifyContribution` →
`{ authentic: true, attested: true }`.

**Act 2 — cross-instance honoring.** Construct instance B's `ReputationLog`,
`append` A's contribution (B shares no state with A and trusts nothing); print
`B.verify(c)` → both true and `B.profile(alice.did)` listing it. B honors a
contribution minted on A without trusting A.

**Act 3 — the verifier catches forgery.** Tamper a field (e.g. flip `kind` or
`repo`) → `authentic: false`. Mint a self-claimed record (valid `subj_sig`, a
`host_sig` from a non-attesting key) → `{ authentic: true, attested: false }`;
show it lands in `profile.claimed`, not `attested`.

**Act 4 — portability.** Compute alice's profile on A and on B; show they are
the same gathered set — export, not amputation. Print the acceptance facts.

## 10. Acceptance criteria (measurable; written test-first)

1. **Round-trip** — `signContribution(fields, subject, host)` then
   `verifyContribution` → `{ authentic: true, attested: true }`.
2. **Derived dids** — the returned record has `subject === subject.did` and
   `host === host.did`.
3. **Tamper detection** — mutating any covered field renders the corresponding
   sig invalid: a changed `subject` → `authentic: false`; a changed `host` →
   `attested: false`; a changed shared field (`repo`/`ref`/`kind`/`at`) → both
   `false`.
4. **Wrong host key** — a record whose `host_sig` was produced by a different
   identity than `host` → `attested: false`, `authentic: true`.
5. **Cross-instance honoring** — a contribution verifies on a fresh
   `ReputationLog` that shares no state with the minter; only the dids in the
   record are used. _(Pins decision 4.)_
6. **Keep-and-label + idempotent** — `append` of a non-authentic record keeps it
   (returned by `forSubject`); re-appending an identical record does not
   duplicate it.
7. **Profile partition** — given one attested, one authentic-only, and one
   non-authentic record for a subject, `profile` puts them in `attested`,
   `claimed`, and neither, respectively; `byKind` counts only the attested set.
   _(Pins decision 3.)_
8. **Deterministic order** — `forSubject` and `profile` return records in a
   stable order independent of append order.
9. **Malformed did fails soft** — `verifyContribution` of a record with a
   malformed `subject` or `host` did returns `false` for that side and does not
   throw.
10. **Composition (north-star)** — a landed op (P06) mints a `'merge'`
    `Contribution` (`ref` = the op id, `subject` = author, `host` = an instance
    identity) that verifies `{ authentic: true, attested: true }` on a second,
    fresh `ReputationLog`; the flow is **6 pass / 0 todo**.

## 11. Honest limitations (stated, not hidden)

- **No network transport.** Cross-instance honoring is shown with two in-memory
  logs; the wire that ships records between real hosts is deferred.
- **No two-party handshake.** `signContribution` holds both keys; a real flow
  has the host propose and the subject co-sign over the wire.
- **No scoring / tiers.** The profile is the attested set + per-kind counts; any
  trust tier is a P09/P10 consumer concern.
- **No revocation.** A signed retraction record is a later refinement; today a
  contribution, once minted, stands.
- **Self-claims are cheap.** Anyone can mint an authentic, unattested record
  about themselves; only the `host_sig` from an instance the verifier recognizes
  makes it `attested`. The spike treats _all_ valid host sigs as attestation —
  distinguishing "an instance I trust" from "any instance" (a host allowlist /
  web-of-trust) is out of scope.
- **In-memory, single process.** No persistence, no concurrency safety. Inherits
  Tier 0 spike limits.

## 12. Seeded/updated docs

- **`CHANGELOG.md`** — under `[Unreleased] → Added`: the P07 reputation graph
  (`@thaddeus.run/reputation`: the dual-signed `Contribution`,
  `signContribution`/ `verifyContribution` yielding `{ authentic, attested }`,
  and a keep-and-label `ReputationLog` with `forSubject`/`verify`/`profile`;
  reputation is the gathered, self-verifying record set, honored across
  instances with no trust in the aggregator). In the **Deferred ledger**:
  network transport/serving, the two-party co-sign handshake, reputation
  scoring/tiers (→P09/P10), auto-minting from landings, contribution revocation,
  governance/stewardship.
- **`ARCHITECTURE.md`** — flip the **Pillar 07** row `planned → built` (package
  `reputation`); update the `Identity` shared-primitive row's "Reused by" to
  note P07 is now realized (it already lists `P07 reputation`).
- **North-star** — add a P07 step: after the seeded edit lands into `main`
  (P06), mint a `'merge'` contribution for the landed op and assert it verifies
  on a second `ReputationLog`. The flow goes to **6 pass / 0 todo**.

## 13. Open items / next primitives

- **Pillar 09 (agents as principals)** consumes this layer: an agent is a
  `did:key` like any subject, and its reputation is its attested contribution
  set; metered budgets and the agent economy build on top.
- **Pillar 10 (review as policy)** can grow a reputation-tier `LandPolicy` over
  the P06 seam once a tier model exists — the natural home for the deferred
  scoring/tiers.
- **Federation transport** (the deferred wire) and the **two-party co-sign
  handshake** are the next reputation-specific refinements; the mirror property
  P06 asserts and the record format P07 ships are the two halves they connect.
