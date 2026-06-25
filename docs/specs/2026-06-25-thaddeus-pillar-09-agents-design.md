# Thaddeus — Pillar 09: agents as first-class principals (design)

**Date:** 2026-06-25 **Status:** Design — pending user review, then
implementation plan **Product:** Strata (working name) · **Company/monorepo:**
Thaddeus (`@thaddeus.run/*`) **Source of truth (vision):**
`the-new-age-of-source-control.html`, Pillar 09 **Builds on:**
`docs/specs/2026-06-22-thaddeus-pillar-01-encrypted-capability-store-design.md`
(identity + revocation),
`docs/specs/2026-06-24-thaddeus-pillar-06-platform-design.md` (the `LandPolicy`
seam), `docs/specs/2026-06-24-thaddeus-pillar-07-reputation-design.md` (the
signed-record pattern, and reputation this layer will later consume)

---

## 1. Context — why this primitive, why now

Strata is an 11-pillar replacement for Git+GitHub, built **one primitive at a
time** (Pillar 01 spec §4). Tiers 0–2 shipped; Tier 3 began with portable
identity + federated reputation (P07). The seeded north-star runs at **6 pass /
0 todo**.

**Pillar 09 — agents as first-class principals** is the second Tier-3 primitive,
chosen now because:

- **It is "the missing half of P16 and the reason the whole design is
  possible."** If a million agents write the code, they are citizens, not
  clients: each agent is a first-class `did:key` principal, distinct from the
  human who operates it, and a change it makes is **signed by the agent and
  attributed to its operator** — accountability that is precise instead of
  laundered through a human who never read it.
- **Every dependency it needs now exists.** An agent is a `did:key` (P01);
  revocation-by-key-rotation is `store.revoke` (P01); its reputation is its
  attested contribution set (P07); and the enforcement point is `Repo.land`'s
  `LandPolicy` seam (P06). P09 is mostly composition over these.
- **It closes the authorization gap P04 deferred.** P04 verifies that _some_
  did:key signed an op (actor may differ from author) but not that an agent was
  _authorized to act for a principal_. P09 owns that: a signed `Delegation`.
- **It is the right size for one release** once scoped to "signed, scoped,
  revocable." The fourth leg the brief names — **economy** (priced third-party
  attestation) — and the reputation **score/tier** are deferred by name (§5),
  each for a concrete reason.

It resolves the brief's P16 (agents are second-class — no identity,
accountability, or economy), and contributes the blast-radius control behind P3
(public-on-merge zero-days) and P21 (the home is a supply-chain attack surface):
a compromised agent is quarantined from the converging state and its keys
rotated, so the npx-from-a-skill / squatted-tanstack class of attack has a
bounded place to live and a one-call kill.

## 2. Governing principle — _stable seams, playground interiors_

Unchanged from Pillars 01–07 (§2): **rigid** = the new package's public API (the
`Delegation` record shape, `signDelegation`/`verifyDelegation`, the
`AgentRegistry` surface, and `delegationPolicy`'s contract as a `LandPolicy`);
**loose** = everything behind those seams. Consequences here: in-memory only,
single process, no persistence, no network transport, no production hardening.

The genuinely rigid, expensive-to-reverse calls in this release are: **(a)** one
unifying **`Delegation`** record carries authorization + scope + budget, signed
by the operator (§4, decision 2); **(b)** enforcement is a **`LandPolicy`** that
runs at `Repo.land`, fail-closed, **read-only on the meter** — spend is recorded
only after a successful land (§4, decisions 3 + 5); and **(c)** the
`AgentRegistry` is an **enforcement authority**, not a keep-and-label aggregator
— it rejects invalid delegations rather than storing them (§4, decision 4). All
three are decided here on purpose.

### 2.1 What the brief asks for, and what is buildable now

The brief's Pillar 09 attaches **four** things to an agent identity. This
release takes a clear position on each:

1. **Capability** — scoped permissions + rate/spend budgets, "enforced by the
   substrate, not by hope" (buildable now, the core). A `Delegation` scopes by
   **path glob** and caps **total changes** and **spend**; `delegationPolicy`
   enforces it at `Repo.land`. _Per-symbol_ scoping needs P08 (deferred);
   _per-hour_ rate windowing needs wall-clock (deferred — a total count cap
   stands in).
2. **Revocation** — "a compromised agent is killed by rotating its keys, and its
   operations are quarantined from the converging state" (buildable now). Key
   rotation is the existing `store.revoke` (P01); quarantine is
   `registry.revoke` + the policy rejecting the agent's ops.
3. **Identity + attribution** — "signed by the agent and attributed to its
   operator" (buildable now). The agent is a `did:key`; the `Delegation` binds
   it to its operator, so `operatorOf(agent)` resolves accountability.
4. **Reputation** — "a score derived from verified outcomes … feeds merge
   policy" (deferred). P07 supplies the signed contribution records; the
   _score/tier_ that grants autonomy is P10's merge-policy input, not this
   release (P07 spec §13 routed scoring to P09/P10; we route it onward to P10).
5. **Economy** — "a paid, third-party verification attestation" (deferred). A
   priced auditor verdict + a payment rail is a distinct economy primitive; out
   of the spike.

## 3. The release's job

Introduce `@thaddeus.run/agent`: the signed `Delegation` and the enforcement
registry + policy. Deliverables:

- The **`Delegation` record** (§6) and `DelegationFields`, with
  `canonicalDelegation`, `signDelegation`, `verifyDelegation`.
- **`AgentRegistry`** (§6): `register` (verifies, rejects invalid), `revoke`,
  `isRevoked`, `delegationFor`, `operatorOf`, `usage`, `record`.
- **`delegationPolicy(registry): LandPolicy`** (§6): quarantine +
  authorization + scope + budget checks at `Repo.land`, fail-closed,
  meter-read-only.
- An **agent CLI demo** (`examples/agent/`) enacting delegate → bounded autonomy
  → scope/budget rejection → revoke/quarantine (§9).
- The north-star integration test **extended** with a P09 step: an agent lands
  under its operator's delegation, then a post-revocation landing is rejected;
  `ARCHITECTURE.md` Pillar 09 row flipped `planned → built`; the flow goes to
  **7 pass / 0 todo** (§12).

Not the job: reputation scoring/tiers, economy/paid attestation, per-symbol
scoping, per-hour rate windowing, sub-delegation chains, time-expiry,
persistence, network (§5, §11).

## 4. Decisions taken (brainstorm outcomes)

1. **Home — a new package `@thaddeus.run/agent`** (primary exports the
   `Delegation` record, the sign/verify functions, `AgentRegistry`, and
   `delegationPolicy`). Neutral name per the scope convention; matches the
   `ARCHITECTURE.md` Pillar 09 label. It consumes `@thaddeus.run/identity`
   (`PublicIdentity` value, `Identity` type) and the **types** of
   `@thaddeus.run/platform` (`LandPolicy`, `LandProposal`) and
   `@thaddeus.run/log` (`Op`). Enforcement is delivered **as a `LandPolicy`**,
   so it plugs into P06's landing seam rather than inventing a parallel
   enforcement path.

2. **One unifying record: `Delegation`.** The operator signs a single grant
   `(operator, agent, paths, maxChanges, maxSpend)` — carrying **authorization**
   (operator's sig), **scope** (path globs), and **budget** (caps) at once.
   `operator` is the signer's derived did (mirroring how provenance/contribution
   derive their signer dids), so a record can't claim an operator it wasn't
   signed by. A change authored by the agent + a valid delegation is verifiably
   attributed to the operator — closing P04's deferred authorization gap.

3. **Enforcement is a fail-closed `LandPolicy`, read-only on the meter.**
   `delegationPolicy(registry)` rejects an incoming op unless its author has a
   non-revoked delegation covering the op's `path` and within budget. It is a
   pure decision over the proposal + registry state; it **does not** mutate the
   meter (so a dry-run or a rejected land never consumes budget). The caller
   calls `registry.record(agent, spend)` _after_ a successful land — the same
   post-land decoupling P07 uses for minting contributions. Substrate-enforced
   at the one boundary where changes enter shared state.

4. **`AgentRegistry` is an enforcement authority, not keep-and-label.** Unlike
   `ReputationLog` (which keeps every record, valid or not, for a verifier to
   judge), the registry **must not** confer authority from an unverified grant:
   `register(d)` verifies and **throws** on an invalid delegation. One active
   delegation per agent (re-register replaces). `delegationFor` returns the
   stored (already-verified) grant; the policy additionally gates on
   `isRevoked`.

5. **Revocation has two halves, both named in the brief.** Convergence
   blast-radius: `registry.revoke(agent)` quarantines the agent so
   `delegationPolicy` rejects all its ops at land. Decryption blast-radius:
   `store.revoke` (P01) rotates the agent's content keys. The package owns the
   first; the demo shows both. "Authorship becomes signed, scoped, … and
   revocable."

6. **Budget is a total count cap + caller-reported spend (spike model).**
   `maxChanges` caps the number of ops the agent may land (the brief's "N
   changes an hour" without the per-hour window, which needs wall-clock —
   deferred). `maxSpend` caps caller-reported `spend` units, since the substrate
   cannot know a change's dollar cost; the caller reports it via
   `record(agent, spend)`. Both are hard caps the policy enforces — "a budget it
   cannot exceed."

### 4.1 Why this is almost no new machinery (honest claim)

Agents-as-principals is mostly _composition_ of primitives P01/P06/P07
established:

| P09 capability                 | Mechanism (existing)                                   |
| ------------------------------ | ------------------------------------------------------ |
| agent / operator identity      | `did:key` via `@thaddeus.run/identity` (P01)           |
| signed grant (authorization)   | the domain-tagged signed-record pattern (P04/P07)      |
| enforcement at the land border | `Repo.land({ policy })` — the `LandPolicy` seam (P06)  |
| reject quarantined/forged      | fail-closed `LandResult`, exactly like blockOnConflict |
| key-rotation revocation        | `store.revoke` (P01)                                   |
| agent reputation (later)       | the attested contribution set (P07)                    |

P09's genuinely new code is small: the `Delegation` record + canonical encoding,
the `AgentRegistry` (a map of verified grants + a quarantine set + a meter), the
`delegationPolicy` checks, and a minimal path-glob matcher.

### 4.2 The path-glob matcher (the one subtle rule)

Scope is checked with a deliberately minimal matcher (`matchGlob(glob, path)`):
a glob ending in `/**` matches any path under that prefix (`src/**` covers
`src/auth.rs` and `src/a/b.rs`); a bare `**` matches everything; otherwise the
glob must equal the path exactly. An op is in scope iff **any** of the
delegation's globs match its `path`. This is enough to express "these paths, not
those" without pulling in a full glob library; richer patterns (`*`, `?`, brace
expansion) and per-symbol scope (P08) are out of scope (§5).

## 5. Scope

**In (this release):**

- Package `@thaddeus.run/agent` with `Delegation`, `DelegationFields`,
  `canonicalDelegation`, `signDelegation`, `verifyDelegation`.
- `AgentRegistry` (`register`/`revoke`/`isRevoked`/`delegationFor`/`operatorOf`/
  `usage`/`record`) and `delegationPolicy(registry): LandPolicy`.
- `examples/agent/` demo; north-star P09 step; `ARCHITECTURE.md` +
  `CHANGELOG.md`.

**Out (deferred, named so scope stays honest):**

- **Reputation score / tiers (P09→P10).** P07 supplies the attested contribution
  records; the derived score that "earns autonomy" feeds P10's merge policy.
- **Economy / paid attestation (P09→later).** A priced third-party verification
  verdict that travels with a change, and any payment rail.
- **Per-symbol capability scoping (P09→P08).** Scope is path-glob only until the
  semantic graph exists.
- **Per-hour rate windowing (P09→later).** Needs wall-clock; the spike caps
  total change count (`maxChanges`).
- **Sub-delegation chains & time-expiry (`not_after`) (P09→later).** Flat,
  non-expiring delegations only (time-expiry needs wall-clock).
- **Auto-recording spend from the land pipeline.** `delegationPolicy` is
  read-only on the meter; wiring `record` into a landing helper is left to the
  caller (the demo/north-star call it explicitly).
- Persistence, production hardening, multi-process concurrency.

## 6. The seam (public API delta)

New package. No changes to existing packages — `agent` consumes their public
surfaces (and the `LandPolicy`/`LandProposal`/`Op` types).

### `@thaddeus.run/agent`

```ts
import type { Identity } from '@thaddeus.run/identity';
import type { LandPolicy, LandProposal } from '@thaddeus.run/platform';

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

// A metered agent's running totals against its caps.
export interface Usage {
  readonly changes: number;
  readonly spend: number;
}

// Canonical bytes the operator's signature covers: domain tag + (operator, agent,
// paths, maxChanges, maxSpend). Throws on non-canonical input.
export function canonicalDelegation(
  core: DelegationFields & { operator: string }
): Uint8Array;

// Build a signed delegation; the operator did is derived from the signer.
export function signDelegation(
  fields: DelegationFields,
  operator: Identity
): Delegation;

// Verify the operator's signature over the canonical core. Fail-soft: a
// malformed did, wrong-length sig, or non-canonical field yields false.
export function verifyDelegation(d: Delegation): boolean;

// The enforcement authority: verified delegations + a quarantine set + a
// per-agent meter. Spike — in-memory, single process. Unlike ReputationLog it
// rejects invalid grants rather than keeping them.
export class AgentRegistry {
  // Verify and store a delegation (one active per agent; re-register replaces).
  // Throws TypeError on an invalid delegation — a forged grant confers nothing.
  register(d: Delegation): void;

  // Quarantine an agent: delegationPolicy then rejects all its ops at land.
  revoke(agent: string): void;
  isRevoked(agent: string): boolean;

  // The active (verified) delegation for an agent, or undefined.
  delegationFor(agent: string): Delegation | undefined;

  // Attribution: the operator did the agent acts for, or undefined.
  operatorOf(agent: string): string | undefined;

  // Metered totals (default { changes: 0, spend: 0 }).
  usage(agent: string): Usage;

  // After a successful land: += changes (# ops landed) and += spend. The policy
  // never calls this — recording is the caller's post-land step. Throws on an
  // unregistered agent or non-finite/negative values.
  record(agent: string, changes: number, spend?: number): void;
}

// Enforcement as a LandPolicy — pass to Repo.land({ policy }). Fail-closed:
// rejects an incoming op whose author is revoked, undelegated, out of scope, or
// over budget. Read-only on the meter (dry-run safe).
export function delegationPolicy(registry: AgentRegistry): LandPolicy;

export type { Delegation, DelegationFields, Usage };
```

### 6.1 Signing & verifying

`signDelegation(fields, operator)`: `assertCanonical(fields)` (agent non-empty
string; `paths` a non-empty array of non-empty strings; `maxChanges`/`maxSpend`
finite numbers ≥ 0); derive `operator.did`;
`bytes = canonicalDelegation({ ...fields, operator: operator.did })`; return
`{ ...fields, operator: operator.did, sig: operator.sign(bytes) }`.

`verifyDelegation(d)`: recompute the canonical bytes from `d`'s own fields and
check `PublicIdentity.fromDid(d.operator).verify(bytes, d.sig)`, wrapped so a
malformed did or non-canonical field returns `false` rather than throwing (the
fail-soft convention of P04/P07).

### 6.2 The registry

`register(d)` throws unless `verifyDelegation(d)` — the registry never confers
authority from an unverified grant. It stores a FROZEN DEEP COPY of `d` keyed by
`d.agent`, so a caller mutating `paths`/caps after registration cannot widen an
already-verified grant (the policy enforces these fields without re-checking the
signature). `revoke` adds the agent to a quarantine `Set`; revocation is
TERMINAL — `register` does NOT clear quarantine, so a revoked agent stays
blocked even if re-registered; replace a compromised agent with a new identity
(there is no unrevoke). `delegationFor` returns the stored grant (or
`undefined`); `operatorOf` returns `delegationFor(agent)?.operator`. `usage`
returns the agent's meter (default zeros). `record(agent, changes, spend = 0)`
increments `changes` by the explicit count (matching `delegationPolicy`'s
`incomingOps` count, so multi-op lands meter correctly) and `spend` by the
argument; it throws on an unregistered agent or non-finite/negative values;
re-registering does NOT reset the meter (the budget is a lifetime cap). The
meter is the registry's only mutable state besides the grant map and quarantine
set.

### 6.3 The policy

`delegationPolicy(registry)` returns a `LandPolicy`. For the proposal's
`incomingOps`, grouped by `op.author`:

1. `registry.isRevoked(author)` →
   `{ allow: false, reason: 'agent <author> is revoked' }`.
2. `registry.delegationFor(author)` is undefined →
   `{ allow: false, reason: 'no delegation for agent <author>' }`.
3. any op whose `path` is not covered by the delegation's globs (§4.2) →
   `{ allow: false, reason: '<path> is outside <author>'s delegated scope' }`.
4. budget: `usage(author).changes + (this author's op count) > maxChanges`, or
   `usage(author).spend >= maxSpend` →
   `{ allow: false, reason: 'agent <author> is over budget' }`. Note: `maxSpend`
   is enforced RETROSPECTIVELY — because a change's spend is only known after
   the land (caller-reported via `record`), the landing that first
   reaches/exceeds the cap still completes and the NEXT land is blocked; the
   effective ceiling is `maxSpend + (last land's spend)`.

Otherwise `{ allow: true }`. The policy reads `registry` but never mutates it;
it composes with other policies by simple conjunction (a caller can land under
`blockOnConflict` and the delegation policy by checking both — a combinator is
not shipped, matching P06).

## 7. Data model

```
Delegation (wire record) {
  operator, agent: string         // did:key of the operator / the agent
  paths:           string[]       // path globs the agent may touch
  maxChanges:      number          // total-change cap
  maxSpend:        number          // caller-reported spend cap
  sig:             Uint8Array      // operator's ed25519 over the canonical core
}
AgentRegistry (in-memory) {
  grants:     Map<agentDid, Delegation>   // verified, one active per agent
  quarantine: Set<agentDid>
  meter:      Map<agentDid, Usage>        // running { changes, spend }
}
```

There is nothing new to encrypt or store — a delegation is signed cleartext
metadata, verified from the dids.

## 8. Crypto choices

**None new.** P09 composes `Identity.sign` / `PublicIdentity.fromDid` /
`PublicIdentity.verify` (P01) and the domain-tag + canonical-tuple discipline of
`op.ts`/`provenance.ts`/`contribution.ts`. `canonicalDelegation` uses the domain
tag `thaddeus.delegation.v1`, distinct from op/provenance/contribution tags so a
delegation signature can never be confused with another record's. Revocation's
key-rotation half is `store.revoke` (P01); the package adds no crypto of its
own. `ready()` (from `@thaddeus.run/identity`) must be awaited before use.

## 9. The demo — agents as bounded principals (CLI)

`examples/agent/` (sibling to `reputation/`, `platform/`), deterministic via
seeded identities. Four acts:

**Act 1 — delegate.** An operator signs a `Delegation` to an agent
(`paths: ['src/**']`, `maxChanges: 2`, `maxSpend: 10`); print `verifyDelegation`
→ true; `registry.register(d)`.

**Act 2 — bounded autonomy.** The agent opens a `Workspace` over a repo, commits
a change to `src/auth.rs`, and lands it under `delegationPolicy(registry)` →
`landed: true`; print `registry.operatorOf(agent)` (attribution) and
`registry.record(agent, 4)` then `registry.usage(agent)`.

**Act 3 — scope + budget enforced.** The agent commits a change to
`secrets/key.env` and lands → rejected (outside `src/**`). Then it exhausts
`maxChanges` and a further landing → rejected (over budget). "A budget it cannot
exceed."

**Act 4 — kill switch.** `registry.revoke(agent)`; the agent's next landing →
rejected (quarantined from the converging state); note `store.revoke` rotates
its content keys (the decryption half). Print the acceptance facts.

## 10. Acceptance criteria (measurable; written test-first)

1. **Round-trip** — `signDelegation(fields, operator)` then `verifyDelegation` →
   true; `d.operator === operator.did`.
2. **Tamper** — mutating any covered field (`agent`/`paths`/`maxChanges`/
   `maxSpend`/`operator`) renders `verifyDelegation` false.
3. **Register rejects forgery** — `register` of an invalid delegation throws; a
   valid one registers and is returned by `delegationFor`.
4. **In-scope within budget lands** — a proposal whose op is authored by a
   delegated agent on a covered path → `delegationPolicy` allows.
5. **Out-of-scope path rejected** — an op on a path no glob covers → reject; the
   reason names the path. _(Pins §4.2.)_
6. **Over `maxChanges` rejected** — with `usage.changes` at the cap, a further
   op → reject.
7. **Over `maxSpend` rejected** — with recorded `spend` ≥ `maxSpend` → reject.
   (`maxSpend` is a retrospective/soft cap: the land that first records spend
   reaching the cap still succeeds; only the next land is blocked.)
8. **Quarantine** — after `registry.revoke(agent)`, `delegationPolicy` rejects
   every op by that agent. _(Pins decision 5.)_
9. **Attribution** — `operatorOf(agent)` returns the operator did; `undefined`
   for an unknown agent.
10. **Dry-run-safe metering** — calling `delegationPolicy` (allow or reject)
    does not change `usage`; only `record` does. _(Pins decisions 3 + 6.)_
11. **Composition (north-star)** — an agent lands a change under its delegation
    (`delegationPolicy`); after `registry.revoke(agent)`, a second landing by
    the same agent is rejected; the flow is **7 pass / 0 todo**.

## 11. Honest limitations (stated, not hidden)

- **No reputation score.** Delegation is static authority; an agent does not yet
  "earn autonomy" from outcomes — that tier logic is P10 over P07's records.
- **No economy.** No priced attestation or payment; the economy leg is deferred.
- **Path-glob scope only.** No per-symbol scope (P08); the matcher handles
  `prefix/**`, bare `**`, and exact paths only.
- **Total-count rate, not per-hour.** `maxChanges` is a lifetime cap on the
  in-memory meter; per-hour windowing needs wall-clock.
- **Spend is caller-reported and `maxSpend` is a retrospective (soft) cap.** The
  substrate cannot know a change's cost; `maxSpend` enforces only what the
  caller `record`s. Because spend is known only after a land, the landing that
  first reaches/exceeds `maxSpend` still completes — only the NEXT land is
  blocked. The effective ceiling is `maxSpend + (last land's spend)`.
- **Flat, non-expiring delegations.** No sub-delegation chains, no `not_after`
  time-expiry. Revocation is the only way to end a delegation.
- **Enforcement is at land only.** A `delegationPolicy` gate runs when changes
  enter shared state via `Repo.land`; it does not police a private workspace's
  in-progress edits (which are the agent's own, unlanded).
- **In-memory, single process.** No persistence, no concurrency safety.
- **Gates the whole incoming closure.** `delegationPolicy` requires _every_ op
  in `LandProposal.incomingOps` (the source-minus-target closure, across all
  authors) to have a valid delegation — so it assumes a single-agent-authored
  branch. A mixed human/agent closure trips "no delegation" on the human's ops;
  compose `delegationPolicy` with policies for other authors when that arises.

## 12. Seeded/updated docs

- **`CHANGELOG.md`** — under `[Unreleased] → Added`: the P09 agent layer
  (`@thaddeus.run/agent`: the signed `Delegation`, `signDelegation`/
  `verifyDelegation`, `AgentRegistry`, and `delegationPolicy` as a fail-closed
  `LandPolicy` enforcing scope + budget + quarantine; revocation = quarantine +
  `store.revoke`; attribution via `operatorOf`). In the **Deferred ledger**:
  reputation score/tiers (→P10), economy/paid attestation, per-symbol scope
  (→P08), per-hour rate windowing, sub-delegation/time-expiry.
- **`ARCHITECTURE.md`** — flip the **Pillar 09** row `planned → built` (package
  `agent`); update the `Identity` shared-primitive row's "Reused by" to note P09
  is realized (it already lists `P09 agents`).
- **North-star** — add a P09 step: an agent lands under its delegation, and a
  post-revocation landing is rejected. The flow goes to **7 pass / 0 todo**.

## 13. Open items / next primitives

- **Pillar 10 (review as policy)** is the direct consumer: it turns P07's
  contribution records into a reputation **tier** and composes it with
  `delegationPolicy` and verification gates into the merge function — "a
  high-reputation agent's change merges under policy; an untrusted agent's
  escalates." The autonomy-score deferred here lands there.
- **Pillar 08 (semantic graph)** upgrades capability scope from path globs to
  per-symbol, and is the last substrate primitive (Part III).
- **The economy leg** (priced third-party attestation) and **per-hour rate /
  time-expiry** are the agent-specific refinements left after this release.
