# Thaddeus — Pillar 06: the platform, where landing gets its policy (design)

**Date:** 2026-06-24 **Status:** Design — pending user review, then
implementation plan **Product:** Strata (working name) · **Company/monorepo:**
Thaddeus (`@thaddeus.run/*`) **Source of truth (vision):**
`the-new-age-of-source-control.html`, Pillar 06 **Builds on:**
`docs/specs/2026-06-24-thaddeus-pillar-05-virtual-fs-design.md`,
`docs/specs/2026-06-23-thaddeus-pillar-03-operation-log-design.md`,
`docs/specs/2026-06-23-thaddeus-pillar-04-provenance-design.md`,
`docs/specs/2026-06-22-thaddeus-pillar-01-encrypted-capability-store-design.md`

---

## 1. Context — why this primitive, why now

Strata is an 11-pillar replacement for Git+GitHub, built **one primitive at a
time** (Pillar 01 spec §4). Tier 0 shipped (`@thaddeus.run/identity`,
`@thaddeus.run/store`). Tier 1 — the spine — shipped: the **membrane** (P02) and
the **operation log** (P03). Tier 2 added the **provenance** layer (P04, the
signed "why") and the **virtual filesystem** (P05, the copy-on-write
`Workspace`). The seeded north-star runs at **5 pass / 0 todo**.

**Pillar 06 — the platform** is the last Tier-2 primitive, chosen now because:

- **It closes the two stages the spine names but never exercises.**
  `ARCHITECTURE.md` describes the north-star as
  `write → snapshot → Op → provenance → policy → mirror`. Today the test stops
  after provenance + reveal; the **`policy`** and **`mirror`** stages have no
  assertion. P06 is the pillar that supplies them: landing under policy, and the
  landed op as a mirror-servable ciphertext.
- **Every prior spec defers "landing" to exactly here.** P05 §5/§11/§13 and the
  CHANGELOG ("Landing / merge onto a shared view (P05→P06/P10)") all hand the
  act of turning a workspace's private commits into part of `main` to the
  platform. `commit` (P05) puts ops on a private view; nothing yet re-points a
  shared view to include them. P06 is that operation — and the **policy seam**
  that decides whether it happens.
- **It consumes Tier 0/1/2 across their public APIs only**, and adds almost no
  new machinery (§4.1). Landing is one re-point of a named view — a capability
  the op-log already exposes (`OpLog.view(name, heads)`) — wrapped in a
  dry-run/decision/commit envelope. No new persisted record, no new crypto.
- **It is the right size for one release.** The genuinely large facets of the
  brief's Pillar 06 — the throughput envelope, discoverability-as-query, typed
  releases, mirror transport — are deferred by name (§5), each for a concrete
  reason, not a shrug.

It resolves the brief's repo-creation friction (`ARCHITECTURE.md` lists P06
against the P9/P10/P11 problem cluster): a scope is allocated in **one call**
(`createRepo`) or brought into being by bare reference, where the gh-CLI took
nine prompts (P11). The throughput _numbers_ behind P9 are code.store's
existence proof to reproduce, not load this spike generates (§2.1, §11).

## 2. Governing principle — _stable seams, playground interiors_

Unchanged from Pillars 01–05 (§2): **rigid** = the new package's public API
(`Platform`, `Repo`, the `LandPolicy` shape) and the north-star flow; **loose**
= everything behind those seams. Consequences here: in-memory only, single
process, no persistence, no network transport, no production hardening.

The genuinely rigid, expensive-to-reverse calls in this release are: **(a)**
`land` decides on a **throwaway dry-run view** and re-points the target _only_
on allow, so a rejected landing leaves the target untouched (§4, decision 4 —
fail-closed); **(b)** landing is the **only** operation that re-points a shared
view (§4, decision 3); and **(c)** conflict _resolution_ stays P03's LWW — P06
**surfaces** conflicts to the policy and re-points, it does not 3-way merge (§4,
decision 5). All three are decided here on purpose rather than left to emerge
from code.

### 2.1 What the brief asks for, and what is buildable now

The brief's Pillar 06 bundles four claims. This release takes a clear position
on each:

1. **Merge becomes a function with a policy, not a human gesture** (buildable
   now, the core). `land` runs a `LandPolicy` predicate over a proposed merge
   and re-points the shared view only if it passes. The _seam_ is the
   deliverable; rich review/reputation policy is Pillar 10, which plugs into
   this exact seam.
2. **Repos created in code, one call — or a bare push** (buildable now).
   `Platform.createRepo(name)` allocates a scope in ~ms; `open(name)`
   auto-vivifies on first reference. Resolves the nine-prompt gh-CLI friction
   (P11).
3. **An API-first remote at agent throughput** (existence proof, not built). The
   code.store envelope (~9M repos/30d, ~15K repos/min, zero downtime) is the bar
   to _reproduce_; the spike builds the API _shape_ that envelope proves, not
   the load (§11; CHANGELOG research ledger).
4. **Discoverability-as-query** (deferred, named). Date-range history,
   release-to-release diff, and `next <tag>` need a wall-clock timestamp on `Op`
   (today only a Lamport clock) or the P08 semantic graph. Deferred to a later
   P06/P11 slice (§5).

## 3. The release's job

Introduce `@thaddeus.run/platform`: the `Platform` and `Repo` classes and the
landing-as-policy operation. Deliverables:

- The **`Platform`** class (§6): `createRepo`, `open` (auto-vivify), `repos`.
- The **`Repo`** class (§6): owns its own `OpLog` + `Store`, seeds a `main`
  shared view, exposes `.log`/`.store` (so the existing `Workspace` opens over
  it unchanged), `land`, `conflicts`, `heads`.
- **`land`** (§6.2): dry-run the merge on a throwaway view → build a
  `LandProposal` → run the `LandPolicy` → re-point the target view on allow,
  fail-closed on reject; return a `LandResult`.
- **Three bundled policies** (§6.3) demonstrating the seam: `allowAll`,
  `blockOnConflict` (the default), and `requireVerifiedProvenance(prov)` — a
  concrete taste of Pillar 10's "merge is a function of verification +
  identity", built on P04.
- A **platform CLI demo** (`examples/platform/`) enacting one-call scopes, a
  clean land, a policy-blocked land, and the mirror property (§9).
- The north-star integration test **rerouted** so the seeded edit originates in
  a `Workspace` over a `Repo` and **lands into `main` under policy** (the
  `policy` stage), with the landed op asserted **mirror-servable** (the `mirror`
  stage); `ARCHITECTURE.md` Pillar 06 row flipped `planned → built`; the flow
  stays green (§12).

Not the job: the throughput envelope, discoverability-as-query, typed `Release`
objects, mirror/peer transport & federation, 3-way content merge,
repository-as-capability-scoped-slice (§5, §11).

## 4. Decisions taken (brainstorm outcomes)

1. **Home — a new package `@thaddeus.run/platform`** (primary exports
   `Platform`, `Repo`, the policies and types). Neutral, product-agnostic name
   per the scope convention (AGENTS.md "Naming"); matches the `ARCHITECTURE.md`
   Pillar 06 label. It consumes `@thaddeus.run/log` (`OpLog`, `Op`, `Conflict`),
   `@thaddeus.run/store` (`Store`, `MemoryStore`), `@thaddeus.run/identity`, and
   `@thaddeus.run/provenance` (`ProvenanceLog`, for one policy) across their
   public APIs only — no internals cross the seam.

2. **A `Repo` owns its own `OpLog` + `Store`.** `createRepo` constructs a fresh
   `MemoryStore`, an `OpLog` over it, and seeds an empty `main` view. This gives
   **hard isolation** between repos (the spike-honest choice) and lets the
   existing `Workspace` open over `repo.log`/`repo.store` with no change to
   `@thaddeus.run/fs`. The brief's "repository is a capability-scoped slice of a
   global graph" is the richer model; it is **deferred** (already CHANGELOG-cut
   as "Repository-as-capability-scoped-slice"), and named again in §5 so the
   simplification stays honest.

3. **Landing is the only operation that re-points a shared view.** A `Workspace`
   commits to its own private view (P05); a shared view like `main` advances
   _only_ through `land`. `land` computes
   `mergedHeads = dedup(heads(into) ∪ heads(from))` and, on allow, calls
   `log.view(into, mergedHeads)` — the single re-point that _is_ the landing.
   Because P03's `append` (peer ingest) never moves a view, and `Workspace`
   never touches a shared view, `main` is stable except through this one path.
   The alternative — letting `commit` target a shared view directly — was
   rejected: it loses the policy gate and the isolation P05 bought.

4. **`land` decides on a dry-run view and is fail-closed.** Rather than re-point
   `into` and roll back on rejection, `land` re-points a _throwaway_ view to
   `mergedHeads`, computes `conflicts`, `incomingOps`, and the materialized
   result there, and builds the `LandProposal` — all without touching `into`.
   Only if `policy(proposal).allow` is true does it re-point `into`. A rejected
   landing therefore leaves `into`'s heads byte-for-byte unchanged, with no
   rollback semantics to get wrong. This is the rigid call that makes "fail
   closed" structural, not a code path.

5. **P06 surfaces conflicts; it does not resolve them.** When `from` and `into`
   diverge on the same path, `land` reports P03 `conflicts` in the proposal and
   re-points to the merged head-set; `materialize` then yields P03's
   deterministic LWW winner. Whether a conflict _blocks_ the landing is the
   **policy's** decision (`blockOnConflict` rejects; `allowAll` lands and lets
   LWW stand). 3-way content merge stays a P03 deferral; P06 adds no merge
   logic.

6. **The policy is a pure predicate over a proposal — the Pillar 10 seam.**
   `LandPolicy = (LandProposal) => LandDecision | Promise<LandDecision>`. It
   receives everything a gate needs (incoming ops, conflicts, both head-sets)
   and returns allow/reject with a reason. Pillar 10's review/reputation gates
   are _just richer policies_ over this same shape; P06 ships three simple ones
   to prove the seam and stops there.

7. **Scopes come into being in one call — or by bare reference.**
   `createRepo(name)` is the explicit one-call create (vs the gh-CLI's nine
   prompts, P11). `open(name)` auto-vivifies an absent repo — the "a bare push
   brings the scope into being" trick — so a fleet stands up thousands in a
   loop, one call each, inside the (deferred) throughput envelope.

### 4.1 Why this is almost no new machinery (honest claim)

Landing-as-policy is mostly _composition_ of primitives P03 already shipped:

| P06 capability            | Mechanism (existing)                                |
| ------------------------- | --------------------------------------------------- |
| dry-run a proposed merge  | `OpLog.view(tmp, mergedHeads)` — zero-copy head-set |
| surface merge conflicts   | `OpLog.conflicts(tmp)` (P03)                        |
| the landing itself        | `OpLog.view(into, mergedHeads)` — one re-point      |
| incoming op set           | ancestor-closure diff via `OpLog.heads`/`ops` (P03) |
| mirror property of a land | `Store.verify` + `OpLog.publicView` (P01/P02/P03)   |
| verified-"why" policy     | `ProvenanceLog.status` (P04)                        |

P06's genuinely new code is small: the `Platform`/`Repo` shells, the
dry-run/decision/commit envelope of `land`, the three policies, and the
incoming-op diff. That is the point — the substrate was designed so the platform
is a thin policy seam over the log, not a parallel source of truth.

### 4.2 The incoming-op set (the one subtle computation)

`proposal.incomingOps` is "what this landing actually adds": the
ancestor-closure of `from`'s heads minus the ancestor-closure of `into`'s heads,
returned in P03's deterministic `(lamport, id)` order. It is computed from the
public log surface (`heads` + walking `ops`/parents), needs no log internals,
and is what a provenance- or reputation-based policy iterates over.

## 5. Scope

**In (this release):**

- Package `@thaddeus.run/platform` with `Platform` (`createRepo`, `open`,
  `repos`) and `Repo` (`log`, `store`, `land`, `conflicts`, `heads`).
- `land`: dry-run proposal → `LandPolicy` → re-point on allow (fail-closed) →
  `LandResult`.
- Policies `allowAll`, `blockOnConflict` (default), and
  `requireVerifiedProvenance(prov)`.
- `examples/platform/` demo; north-star reroute through a `Repo` + `land`;
  `ARCHITECTURE.md` + `CHANGELOG.md`.

**Out (deferred, named so scope stays honest):**

- **Throughput envelope at scale (P06)** → code.store's existence proof to
  reproduce, not spike-tested load. We build the API shape, not the numbers.
- **Discoverability-as-query (P06→P03/P08/P11)** → `log --since/--until`,
  release-to-release `diff`, `next <tag>` need a wall-clock timestamp on `Op` or
  the P08 graph. Deferred.
- **Typed `Release` objects (P06)** → a signed
  `Release { tag, at, signed_by, commits, artifacts }` and its page; a clean
  follow-on slice. Landing-as-policy is already "a release is a policy event" in
  miniature.
- **Mirror / peer transport & federation (P06→P07)** → this release asserts the
  mirror _property_ (a landed op is ciphertext `publicView` can serve) but ships
  no network, peer pull/push, or instance federation.
- **3-way content merge** → already P03-deferred; P06 surfaces `conflicts`, LWW
  resolves, policy decides whether to block.
- **Repository-as-capability-scoped-slice** → a `Repo` owns its own log+store
  (hard isolation), not a slice of a global graph.
- **`sync()` of a workspace's pinned base (P05)** → unchanged; a workspace is
  open → edit → commit → land → discard.
- Persistence, production hardening, multi-process concurrency.

## 6. The seam (public API delta)

New package. No changes to `@thaddeus.run/identity`, `@thaddeus.run/store`,
`@thaddeus.run/log`, `@thaddeus.run/provenance`, or `@thaddeus.run/fs` — the
platform consumes their existing public surfaces.

### `@thaddeus.run/platform`

```ts
import type { Identity } from '@thaddeus.run/identity';
import type { Conflict, Op, OpLog } from '@thaddeus.run/log';
import type { ProvenanceLog } from '@thaddeus.run/provenance';
import type { Store } from '@thaddeus.run/store';

// A proposed landing, computed on a dry-run view before any policy decision.
interface LandProposal {
  readonly into: string; // the shared target view (e.g. 'main')
  readonly intoHeads: readonly string[]; // target heads before the landing
  readonly incomingHeads: readonly string[]; // the source view's heads
  readonly mergedHeads: readonly string[]; // dedup(into ∪ from), the proposed heads
  readonly incomingOps: readonly Op[]; // from's closure minus into's closure, ordered
  readonly conflicts: readonly Conflict[]; // same-path collisions in the merged set
}

// The policy seam: the exact point Pillar 10 fills with review/reputation gates.
type LandPolicy = (p: LandProposal) => LandDecision | Promise<LandDecision>;
interface LandDecision {
  readonly allow: boolean;
  readonly reason?: string; // why it was rejected (surfaced in LandResult)
}

// The outcome of a land() call. `landed === false` ⇒ `into` is untouched.
interface LandResult {
  readonly landed: boolean;
  readonly into: string;
  readonly heads: readonly string[]; // into's heads after (unchanged if rejected)
  readonly conflicts: readonly Conflict[];
  readonly reason?: string; // the policy's reason when landed === false
}

// A named home: its own op-log + store, with a seeded `main` shared view. The
// existing Workspace opens over repo.log/repo.store unchanged. Spike — in-memory,
// single process, not durable, not concurrency-safe.
class Repo {
  readonly name: string;
  readonly log: OpLog;
  readonly store: Store;

  // Land a workspace's committed view onto a shared view, gated by policy.
  // Dry-runs the merge, runs the policy, and re-points `into` ONLY on allow
  // (fail-closed). Default policy: blockOnConflict.
  land(opts: {
    from: string; // a workspace's committed (private) view name
    into?: string; // shared target; default 'main'
    author: Identity; // who proposes the landing
    policy?: LandPolicy; // default: blockOnConflict
  }): Promise<LandResult>;

  // P03 passthroughs for a shared view: collisions and current heads.
  conflicts(view?: string): readonly Conflict[];
  heads(view?: string): readonly string[];
}

// Top-level: scopes come into being in one call (P11).
class Platform {
  createRepo(name: string): Repo; // one call, ~ms, no wizard
  open(name: string): Repo; // auto-vivifies if absent (bare-push trick)
  repos(): readonly string[];
}

// Bundled policies (the seam, demonstrated).
declare const allowAll: LandPolicy; // always allow
declare const blockOnConflict: LandPolicy; // allow iff proposal.conflicts is empty
declare function requireVerifiedProvenance(prov: ProvenanceLog): LandPolicy; // P04 tie-in

export { Platform, Repo, allowAll, blockOnConflict, requireVerifiedProvenance };
export type { LandProposal, LandPolicy, LandDecision, LandResult };
```

### 6.1 Creating scopes — one call, or bare reference

`Platform.createRepo(name)`:

1. Construct a fresh `MemoryStore` and an `OpLog` over it.
2. Seed an empty `main` view (`log.view('main', [])`).
3. Register the `Repo` under `name`; return it. Re-creating an existing name
   returns the existing repo (idempotent — no double-allocation).

`Platform.open(name)` returns the repo if it exists, else **auto-vivifies** it
via the same path — the "a bare push brings the scope into being" trick. A fleet
loop (`for (const r of runs) platform.open(r.id)`) stands up thousands of
scopes, one call each, with no provisioning UI.

### 6.2 Landing — dry-run, decide, re-point (fail-closed)

`repo.land({ from, into = 'main', author, policy = blockOnConflict })`:

1. `intoHeads = log.heads(into)`, `incomingHeads = log.heads(from)`.
2. `mergedHeads = dedup(intoHeads ∪ incomingHeads)`.
3. On a throwaway view name, `log.view(tmp, mergedHeads)`; compute
   `conflicts = log.conflicts(tmp)` and `incomingOps` (§4.2). Build the
   `LandProposal`. **`into` is untouched.**
4. `decision = await policy(proposal)`.
5. If `!decision.allow` → return
   `{ landed: false, into, heads: intoHeads, conflicts, reason: decision.reason }`.
   `into` never moved (**fail-closed**).
6. Else `log.view(into, mergedHeads)` — the single re-point that _is_ the
   landing — and return `{ landed: true, into, heads: mergedHeads, conflicts }`.

`land` signs nothing and stores nothing: the ops it lands were already signed
and stored by the workspace's `commit` (P05). Landing is purely a re-point under
a gate. The `author` is recorded for the policy's use (e.g. reputation) and for
the demo's narration; it does not author a new op in this release (no "merge
commit" — a deliberate non-goal; the merge _is_ the head-set).

### 6.3 The policies — the seam, demonstrated

- **`allowAll`** — `() => ({ allow: true })`. Lands unconditionally; LWW
  resolves any conflict and `conflicts('main')` surfaces it afterward.
- **`blockOnConflict`** (default) —
  `p => ({ allow: p.conflicts.length === 0, reason: … })`. The safe default: a
  landing that would collide on a path is rejected, leaving `main` clean.
- **`requireVerifiedProvenance(prov)`** — allow iff **every** op in
  `p.incomingOps` has at least one `verified` `Provenance` record
  (`prov.forOp(op.id)` contains a record with
  `prov.status(rec) === 'verified'`). This is the concrete taste of Pillar 10:
  merge gated on a signed "why", not a human reading a diff. Composable with the
  others by simple conjunction (a caller can write
  `p => and(blockOnConflict, requireVerifiedProvenance(prov))`; P06 ships the
  parts, not a combinator DSL).

### 6.4 The mirror property (the north-star `mirror` stage)

P06 ships no transport, but a landed op already satisfies the brief's mirror
claim — "ciphertext is replicated immediately" — and the release asserts it:
after `land`, for each landed op, `store.verify(op.payload.id)` is true (the
payload is mirror-verifiable ciphertext) and `log.publicView(op.id)` returns
`{ kind: 'open', … }` (a non-embargoed op is fully servable to a public mirror).
An embargoed op (P02) would instead return `{ kind: 'embargoed', … }` — only an
ordering token — until its reveal at T. This is the `mirror` stage of the spine,
satisfied by composition, with the transport itself deferred (§5).

## 7. Data model

P06 introduces **no persisted record type**. A `Repo` is in-memory state:

```
Repo (in-memory) {
  name:  string
  log:   OpLog            // own operation log (P03)
  store: Store            // own content store (P01)
}
Platform (in-memory) {
  repos: Map<name, Repo>  // the scope registry
}
```

The durable artifacts of a landing are entirely the P03 `Op`s already produced
by the workspace's `commit`; landing only changes which head-set a named view
points at (`OpLog`'s existing `#views` map). There is nothing new on the wire
and nothing new to sign.

## 8. Crypto choices

**None new.** P06 performs no encryption, signing, or hashing of its own. It
composes:

- `OpLog.view`/`heads`/`conflicts`/`ops`/`publicView` (P03) for the merge
  mechanics and the mirror property.
- `Store.verify` (P01) for the mirror-verifiable-ciphertext assertion.
- `ProvenanceLog.status`/`forOp` (P04) for `requireVerifiedProvenance`.

`Platform`/`Repo` methods that touch the log/store `await ready()` transitively;
the package documents that `ready()` must be awaited before use (consistent with
Tier 0/1/2).

## 9. The demo — the platform / landing-as-policy (CLI)

`examples/platform/` (sibling to `workspace/`, `oplog/`, `provenance/`,
`offboarding/`, `disclosure/`), deterministic via injected identities/seeds.
Four acts:

**Act 1 — scopes in one call (P11).** `platform.createRepo('acme/web')`; show
`platform.open('acme/agent-run-8f2a')` auto-vivifying a never-created scope; a
fleet loop creating N scopes, one call each — no wizard, no provisioning.

**Act 2 — landing as policy (clean).** Open two `Workspace`s over the repo, edit
_different_ paths, `commit` each; `repo.land({ from: a })` and
`repo.land({ from: b })` under `blockOnConflict`; show `main` now materializes
both files, `landed === true`, no conflicts.

**Act 3 — policy blocks (fail-closed).** Two workspaces edit the _same_ path
divergently; land the first (ok); land the second under `blockOnConflict` → show
`landed === false`, a reason, and `main` unchanged. Then swap in
`requireVerifiedProvenance(prov)`: an op with no verified "why" is rejected; the
same op with a verified `Provenance` (P04) lands.

**Act 4 — the mirror property.** For a landed op, print `store.verify` true and
`log.publicView(op.id).kind === 'open'` — ciphertext a mirror can serve. Print
the acceptance facts.

## 10. Acceptance criteria (measurable; written test-first)

1. **One-call create** — `createRepo(name)` returns a `Repo` whose `main` view
   exists and is empty; `open(name)` on an absent name auto-vivifies an
   equivalent repo; `repos()` lists created names.
2. **Repo isolation** — two repos share no ops: an op landed in repo A is absent
   from repo B's `log.ops()`, and their stores are distinct.
3. **Clean land** — landing a workspace's committed view into `main` yields
   `landed === true`, `result.heads === mergedHeads`, `log.materialize('main')`
   contains the edited path, and `conflicts` empty.
4. **Dry-run purity / fail-closed** — a landing whose policy returns
   `allow: false` leaves `log.heads('into')` exactly equal to its pre-land value
   (no re-point, no rollback). _(Pins decision 4.)_
5. **`blockOnConflict`** — two concurrent same-path edits: the first lands; the
   second is rejected with a non-empty `reason`; `proposal.conflicts` is
   non-empty; `main` reflects only the first. _(Pins decisions 5/6.)_
6. **`allowAll`** — the same scenario under `allowAll` lands the second;
   `main`'s heads include both frontiers; `repo.conflicts('main')` reports the
   collision with a deterministic LWW `winner` (surfaced, not merged).
7. **`requireVerifiedProvenance`** — an incoming op with a `verified` P04 record
   lands; an op with no record (or only an `unverified` one) is rejected.
8. **`incomingOps`** — equals the ancestor-closure of `from`'s heads minus that
   of `into`'s heads, in `(lamport, id)` order; ops already in `into` are
   excluded.
9. **Mirror property** — every landed op satisfies `store.verify(op.payload.id)`
   and `log.publicView(op.id).kind === 'open'`. _(Pins §6.4.)_
10. **Deterministic** — `mergedHeads`, `incomingOps`, and `conflicts` are
    returned in a stable order independent of land-call order.
11. **Composition (north-star)** — the seeded one-edit flow's edit originates in
    a `Workspace` over a `Repo` and is landed into `main` under
    `blockOnConflict` (the `policy` stage); the landed op is mirror-servable
    (the `mirror` stage); downstream provenance + reveal still pass; the flow
    stays green.

## 11. Honest limitations (stated, not hidden)

- **Throughput is the API shape, not the load.** The code.store envelope is the
  bar to reproduce; this spike tests correctness of `createRepo`/`land`, not
  ~15K repos/min.
- **No mirror transport.** The mirror _property_ is asserted; no network, peer
  pull/push, or federation ships (P07).
- **No discoverability-as-query.** No date filters, release diffs, or `next` —
  blocked on a missing `Op` timestamp or P08 (§5).
- **No merge commit, no 3-way content merge.** A landing is a head-set re-point;
  conflicts are surfaced and LWW-resolved, never content-merged (P03 deferral).
- **Hard repo isolation, not capability-scoped slices.** Each `Repo` owns its
  own log+store; the global-graph slice model is deferred.
- **No GC.** Throwaway dry-run views (and workspace views) accumulate in the
  log's view map; cleanup is a spike non-goal.
- **In-memory, single process.** No persistence, no concurrency safety. Inherits
  Tier 0/1/2 spike limits.

## 12. Seeded/updated docs

- **`CHANGELOG.md`** — under `[Unreleased] → Added`: the P06 platform
  (`@thaddeus.run/platform`: `Platform`/`Repo`, one-call `createRepo` +
  bare-push `open`, `land` as a dry-run/policy/re-point operation, `allowAll` /
  `blockOnConflict` / `requireVerifiedProvenance` policies, the mirror
  property). The deferred ledger already carries the P06 cuts (throughput
  envelope, discoverability-as-query, typed releases, mirror transport); move
  none up except landing, which lands here — update the "Landing / merge onto a
  shared view (P05→P06/P10)" item to note P06 ships the platform half (policy
  seam), with rich review policy still owed to P10.
- **`ARCHITECTURE.md`** — flip the **Pillar 06** row `planned → built` (package
  `@thaddeus.run/platform`); add a `platform` consumer note to the `Op`
  primitive row ("Reused by … P06 landing").
- **North-star** — reroute the seeded edit to originate in a `Workspace` over a
  `Repo` and land into `main` under policy (the `policy` stage), asserting the
  landed op is mirror-servable (the `mirror` stage). The downstream provenance +
  reveal assertions consume the landed op unchanged; the flow stays green.

## 13. Open items / next primitives

- **Pillar 10 (review-as-policy)** is the direct continuation: richer
  `LandPolicy` implementations — semantic/behavioral diff gates, test/proof
  verification, reputation tiers, and the standing human veto — all plug into
  the `LandProposal → LandDecision` seam shipped here.
- **Pillar 07 (federation)** adds the mirror _transport_: serving views/ops
  between instances and a shared identity/reputation layer; the mirror property
  P06 asserts is the local half.
- **Pillar 11 (live database)** and a P03 `Op` timestamp unlock
  discoverability-as-query (`log --since`, release diffs, `next`) deferred here.
- Confirm whether `Repo` later grows a typed `Release` object and a landing that
  emits a merge record, or whether both stay out until P10/P11.
