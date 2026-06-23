# Thaddeus — Pillar 04: a first-class, signed "why" layer (design)

**Date:** 2026-06-23 **Status:** Design — pending user review, then
implementation plan **Product:** Strata (working name) · **Company/monorepo:**
Thaddeus (`@thaddeus.run/*`) **Source of truth (vision):**
`the-new-age-of-source-control.html`, Pillar 04 **Builds on:**
`docs/specs/2026-06-23-thaddeus-pillar-03-operation-log-design.md`,
`docs/specs/2026-06-23-thaddeus-pillar-02-membrane-design.md`,
`docs/specs/2026-06-22-thaddeus-pillar-01-encrypted-capability-store-design.md`

---

## 1. Context — why this primitive, why now

Strata is an 11-pillar replacement for Git+GitHub, built **one primitive at a
time**, each release swapping one stub in the north-star integration test for a
real package (Pillar 01 spec §4).

Tier 0 shipped (`@thaddeus.run/identity`, `@thaddeus.run/store` — encrypted
objects + per-object capabilities). Both Tier-1 Spine primitives shipped too:
the **membrane** (Pillar 02, timed reveal) and the **operation log** (Pillar 03,
signed `Op` records with continuous convergence). **Pillar 04 — provenance** is
the first Tier-2 primitive, and it is chosen now because:

- **It is the smallest, best-scoped next primitive, and its seam is already
  cut.** P03 deliberately left `Op` without an `intent` field so P04 could
  attach the why _alongside, not inside_, the record (P03 spec §4.1, §13). The
  data model is already fully specified in the brief's Pillar 04. There is no
  research frontier on its critical path.
- **It completes P12 and closes the seeded north-star.** P03 _began_ P12
  (history records the _who_ and the causal order Git discards); P04 finishes it
  by recording the _why_ (intent, reasoning, task, prompt). P04 is the last
  `test.todo` in `one-edit-end-to-end.test.ts`; shipping it turns the seeded
  one-edit flow **5 pass / 0 todo** — the milestone ARCHITECTURE calls "every
  stub is gone, the substrate is whole" for that path.
- **It consumes Tier 0/1 across their public APIs only** — `store.put` for the
  capability-gated prompt, `identity` to sign, and the `Op` type from `log` as
  the thing it attaches to. No internals leak across the seam, which is why it
  earns a **new package** (`@thaddeus.run/provenance`) rather than an extension
  of `log` (§4, decision 1).

It resolves complaint **P12** (change provenance records _what_ changed but
never a verified _who_ or _why_). The reputation half of the brief's trust rule
("never counts toward an agent's reputation") is forward-looking to **Pillar 09**
and is named-and-deferred, not claimed (§4.4, §11).

## 2. Governing principle — _stable seams, playground interiors_

Unchanged from Pillars 01–03 (§2): **rigid** = the new package's public API, the
`Provenance` record shape in `ARCHITECTURE.md`, and the north-star flow; **loose**
= everything behind those seams. Consequences here: in-memory only, single
process, no persistence, no network transport, no production hardening. Tests
pin the contract and the acceptance facts (§10), not the throwaway internals.

The genuinely rigid, expensive-to-reverse calls in this release are the
**signature scope** (what bytes the actor signs) and the **trust surface** (that
an invalid record is _kept and labelled_, not rejected). Both are decided here
on purpose (§4.2, §4.4) rather than left to emerge from code.

### 2.1 What the brief asks for, and what is buildable now

The brief's Pillar 04 makes three claims. This release takes a clear position on
each:

1. **Every operation carries structured, signed provenance** (buildable now). A
   `Provenance` record — actor, actor_kind, intent, reasoning, task, prompt_ref
   — signed by the actor and bound to an `Op.id`.
2. **The prompt is stored by reference, not inline** (buildable now). When a
   prompt is supplied, its bytes are stored as a capability-gated store object;
   the record carries `prompt_ref = blake3(prompt_text)` (a tamper-evident
   binding) and a store `Ref` (the gated pointer). A prompt containing secrets
   never enters world-readable history.
3. **Unsigned or invalid provenance renders as `unverified` and never counts
   toward reputation** (half now). The `verified` / `unverified` _label_ is
   built and pinned by tests now; the _reputation accrual_ it gates is Pillar
   09 territory and is deferred (§4.4, §11).

## 3. The release's job

Introduce `@thaddeus.run/provenance`: the `Provenance` record and an in-memory
`ProvenanceLog` that builds and signs provenance for an `Op`, stores prompts
capability-gated, attaches records to op ids, and renders each as `verified` or
`unverified`. Deliverables:

- The **`Provenance` record** (§7.1) and the pure module functions
  `canonicalProvenance` / `signProvenance` / `verifyProvenance` (mirroring
  `op.ts`), in a new package `@thaddeus.run/provenance`, depending on
  `@thaddeus.run/identity`, `@thaddeus.run/store`, and `@thaddeus.run/log`
  (public APIs only).
- The **`ProvenanceLog`** class (§6): `record`, `append`, `forOp`, `verify`,
  `status`.
- **Capability-gated prompt storage**: an optional prompt is stored via
  `store.put` (granted to the actor); the record binds it by hash + Ref (§6.2).
- The **trust rule**: `status()` returns `unverified` for a missing/invalid
  signature, `verified` otherwise; invalid records are kept and labelled, not
  rejected (§4.4, §6.3).
- A **provenance CLI demo** (`examples/provenance/`) enacting a signed why on a
  real op, the `--why` render, a tamper → `unverified` transition, and a gated
  prompt that is unreadable without the capability (§9).
- The north-star integration test's **P04 `test.todo` swapped** for a real
  assertion; `ARCHITECTURE.md` Pillar 04 row flipped `planned → built`; the
  flow reaches **5 pass / 0 todo** (§12).

Not the job: reputation accrual/outcomes, delegation/attestation, a real
`--why` query surface, prompt-cap granting/revocation flows, persistence,
network/federation (§5, §11).

## 4. Decisions taken (brainstorm outcomes)

1. **Home — a new package `@thaddeus.run/provenance`** (not an extension of
   `log`). Provenance is a distinct primitive with its own data model and its
   own `ARCHITECTURE.md` row; it consumes `log` only as a _type_ (the `Op` it
   attaches to) and Tier 0 across public APIs, so no internals cross the seam.
   Keeping the _why_ in its own package preserves the separation P03 cut on
   purpose between the _what_ (the `Op`) and the _why_ (P03 spec §4.1).
2. **Signature scope — sign the FULL record.** The brief's illustrative formula
   `sig: ed25519(actor, canonical(op‖intent‖task‖prompt_ref))` signs only four
   fields, leaving `actor_kind` and `reasoning` unsigned and therefore
   relay-malleable. This release **deliberately hardens** that: `canonical`
   covers _all_ semantic fields (`op`, `actor`, `actor_kind`, `intent`,
   `reasoning`, `task`, `prompt_ref`, `prompt`), matching P03's "nothing on the
   record is relay-malleable" discipline. This closes a real downgrade hole — a
   relay flipping `actor_kind` from `agent:…` to `human`, or rewriting
   `reasoning`, would otherwise pass verification. The brief's subset is treated
   as illustrative, and the deviation is stated plainly (§11).
3. **Prompt storage — full, capability-gated, optional.** When a prompt is
   supplied, its bytes are stored via `store.put(prompt, actor)` (a
   capability-gated object granted to the actor); the record carries both
   `prompt_ref = blake3(prompt_text)` and the store `Ref`. The hash is the
   tamper-evident binding (a cap-holder who reads the prompt can confirm it
   matches the signed hash); the `Ref` + store caps are the gate. A prompt is
   optional; absent ⇒ `prompt_ref = null` and `prompt = null`. This
   _demonstrates_ "prompts with secrets don't leak into world-readable history"
   rather than merely claiming it.
4. **Actor need not equal op.author; trust rule keeps-and-labels.** `verify`
   checks the signature under whatever `actor` signed and that the record binds
   an `Op.id`; it does **not** require `actor == op.author`. This admits the
   agent-acting-for-a-human model the brief's `actor_kind` anticipates;
   full delegation/attestation semantics are deferred to P09. Separately, an
   _invalid_ provenance record is **kept and rendered `unverified`**, not
   rejected — because the brief's rule is "renders as `unverified`," i.e. the
   unsigned claim is still shown (so a reader sees it _as untrustworthy_), it
   just never feeds reputation.

### 4.1 P12 is _completed_ here (honest claim)

P03 recorded the _who_ (`author`) and the _what-before-what_ (`parents`); it
explicitly did **not** carry intent/reasoning (P03 spec §4.1). P04 adds the
signed _why_ — intent, reasoning, task, prompt — bound to the `Op.id`.
ARCHITECTURE attributes P12 to both pillars; the precise split is unchanged from
P03's statement: **P03 records who + causal order, P04 records why.** With P04
shipped, P12 is resolved for the seeded one-edit path.

### 4.2 Why the signature scope is a rigid, decided-now call

The signed bytes are the whole security value of the pillar — "provenance is
signed so the record is trustworthy rather than a vector for fabricated
history." Widening the signed set after records exist would invalidate every
record signed under the narrower scope, so the scope is fixed here (full record,
domain-tagged) rather than left to emerge. See §8 for the canonical encoding.

### 4.3 `actor` is a signing key; `actor_kind` is a descriptive label

`actor` is a `did:key` (the same self-owned key that wraps capabilities in P01
and accrues reputation in P07/P09 — one primitive, three uses). `actor_kind` is
a free-text label describing _what kind_ of actor signed: `"human"` or an agent
build string like `"agent:claude-code@1.2"`. The brief's `--why` render shows
both — `actor agent:claude-code@1.2 (operator: did:key:z6Mk…)`. Because
`actor_kind` is now signed (§4.2), it cannot be forged or downgraded on relay.

### 4.4 The reputation half is deferred to P09 (not claimed)

The brief's trust rule has two clauses: (a) invalid provenance renders as
`unverified`, and (b) it "never counts toward an agent's reputation (Pillar
09)." Clause (a) is delivered and tested here as the `status()` label. Clause
(b) requires the reputation/outcomes machinery that does not yet exist; it is
ledgered to P09. This release does not implement, mock, or imply reputation
scoring — it delivers only the label that the later machinery will read.

## 5. Scope

**In (this release):**

- Package `@thaddeus.run/provenance` with the `Provenance` record, the pure
  `canonicalProvenance` / `signProvenance` / `verifyProvenance` functions, and
  the `ProvenanceLog` class (§6).
- `record` (build + sign + store prompt + attach), `append` (peer ingest,
  keep-and-label), `forOp` (records for an op id, deterministic order),
  `verify` (signature integrity over the bound op), `status`
  (`verified`/`unverified`).
- Capability-gated optional prompt storage with hash + `Ref` binding.
- `examples/provenance/` demo; north-star P04 swap; `ARCHITECTURE.md` +
  `CHANGELOG.md`.

**Out (deferred, named so scope stays honest):**

- **Reputation accrual / outcomes** (the trust rule's second clause) → Pillar
  09 (§4.4, §11).
- **Delegation / attestation** (proving an agent acts _for_ a principal, not
  merely that some key signed) → Pillar 09.
- **A real `--why` query surface** across history → Pillars 06/11; here the
  render exists only in the demo.
- **Granting the prompt capability to reviewers, and revoking a "why"** → uses
  existing store primitives (`grant`/`revoke`); not wired beyond `put` here.
- **Provenance over a symbol-level op** (`Op.path` → symbol-id) → arrives with
  Pillar 08; the record binds an `Op.id`, which is stable across that change.
- Persistence, network transport, federation, multi-process concurrency.

## 6. The seam (public API delta)

New package. No changes to `@thaddeus.run/identity`, `@thaddeus.run/store`, or
`@thaddeus.run/log` — provenance consumes their existing public surfaces and
imports `Op` as a type.

### `@thaddeus.run/provenance`

```ts
import type { Identity } from '@thaddeus.run/identity';
import type { Ref, Store } from '@thaddeus.run/store';
import type { Op } from '@thaddeus.run/log';

// A signed "why" attached to an Op.id (P03). View-agnostic and op-agnostic: it
// references the op by id, it is never embedded in the op (P03 left no intent
// field on Op on purpose). All semantic fields are signed (§4.2).
interface Provenance {
  readonly op: string; // the Op.id this explains
  readonly actor: string; // did:key that SIGNED — human OR agent
  readonly actor_kind: string; // "human" | "agent:claude-code@1.2"
  readonly intent: string; // short why
  readonly reasoning: string; // longer why
  readonly task: string | null; // issue/task link; optional
  readonly prompt_ref: string | null; // blake3(prompt_text); null if no prompt
  readonly prompt: Ref | null; // capability-gated store pointer; null if none
  readonly sig: Uint8Array; // ed25519(actor, canonical(ALL fields above))
}

// The signable fields, before sig is computed.
interface ProvenanceFields {
  readonly op: string;
  readonly actor_kind: string;
  readonly intent: string;
  readonly reasoning: string;
  readonly task: string | null;
  readonly prompt_ref: string | null;
  readonly prompt: Ref | null;
}

type ProvenanceStatus = 'verified' | 'unverified';

// Deterministic bytes for the signature — domain-tagged 'thaddeus.provenance.v1'
// so a provenance signature can never be confused with an op signature or any
// other protocol's payload (§8). Rejects non-canonical field values (§8).
function canonicalProvenance(fields: ProvenanceFields, actor: string): Uint8Array;

// Build the full signed record. sig = actor over the canonical bytes.
function signProvenance(fields: ProvenanceFields, actor: Identity): Provenance;

// Valid iff the signature verifies under actor's did:key over the canonical
// bytes. Fails closed: any malformed input (undecodable did:key, wrong-length
// sig, non-canonical field) returns false rather than throwing.
function verifyProvenance(p: Provenance): boolean;

// In-memory registry of provenance keyed by Op.id. Spike — not durable, not
// concurrency-safe, single process.
class ProvenanceLog {
  constructor(store: Store);

  // Build + sign provenance for `op`, optionally storing a prompt
  // capability-gated. If `prompt` bytes are given: ref = store.put(prompt,
  // actor); prompt_ref = blake3(prompt). Records the (verified) result and
  // returns it.
  record(
    op: Op,
    fields: {
      intent: string;
      reasoning: string;
      actorKind: string;
      task?: string;
      prompt?: Uint8Array;
    },
    actor: Identity
  ): Promise<Provenance>;

  // Ingest a provenance record from a peer. Unlike OpLog.append (which REJECTS
  // unverifiable ops), this KEEPS the record regardless of validity so it can be
  // rendered `unverified` (§4.4). Idempotent on (op, actor, sig).
  append(p: Provenance): void;

  // All provenance records known for an op id, in a deterministic order
  // (by actor, then sig bytes).
  forOp(opId: string): readonly Provenance[];

  // Signature integrity over the bound op id (delegates to verifyProvenance).
  // Whether the bound op actually exists is the log's concern, not this check.
  verify(p: Provenance): boolean;

  // The render-time trust label: 'verified' if verify(p), else 'unverified'.
  status(p: Provenance): ProvenanceStatus;
}
```

### 6.1 Recording a why

`record(op, fields, actor)`:

1. If `fields.prompt` is given:
   `promptRef = await store.put(fields.prompt, actor)` (capability-gated,
   granted to `actor`); `prompt_ref = bytesToHex(blake3(fields.prompt))`.
   Otherwise both are `null`.
2. Assemble `ProvenanceFields { op: op.id, actor_kind, intent, reasoning,
   task ?? null, prompt_ref, prompt: promptRef }`.
3. `p = signProvenance(fields, actor)` — `sig = actor.sign(canonical(...))`,
   `actor = actor.did`.
4. Store `p` under `op.id` in the registry. Return `p`.

History captures the why as a side effect of the same edit flow — no separate
"annotate" ritual.

### 6.2 The prompt binding (no-leak property)

The record carries two prompt fields with distinct jobs:

- **`prompt_ref` = `blake3(prompt_text)`** — a signed, tamper-evident binding.
  Anyone who later obtains the prompt bytes can confirm they match the record.
- **`prompt` = `Ref`** — the capability-gated pointer into the store. The bytes
  are readable only by a holder of a capability for that object (`store.get`).
  The public mirror sees the `Ref` (an address) but cannot decrypt it.

Because the prompt lives in the store as ciphertext and only its hash + address
appear on the (potentially world-readable) provenance record, a prompt that
contains secrets never enters readable history. Granting the prompt capability
to a reviewer is an ordinary `store.grant` (deferred wiring, §5).

### 6.3 The trust rule — keep and label

`status(p)` returns `verified` iff `verify(p)` is true, else `unverified`.
`verify` recomputes the canonical bytes and checks `sig` under `actor`'s
`did:key`; any tamper to any signed field, a missing/short signature, or an
undecodable actor yields `unverified` (fail-closed). Critically, `append` and
the registry **retain** invalid records — the rule is that they _render_ as
`unverified`, so a reader sees the unsigned/forged claim flagged as
untrustworthy rather than silently dropped. (Contrast: `OpLog.append` throws on
an unverifiable op, because an unverifiable op would poison convergence; an
unverifiable _why_ poisons nothing — it is just a claim to disbelieve.)

## 7. Data model

### 7.1 The `Provenance` record

```
Provenance {
  op:         blake3(…)                        // the Op.id this explains (P03)
  actor:      did:key:z6Mk...                  // the did:key that SIGNED (human OR agent)
  actor_kind: "agent:claude-code@1.2"          // or "human" — descriptive label, signed
  intent:     "fix race in token refresh"      // short why
  reasoning:  "refresh() re-entered before lock; added a mutex"
  task:       "STRATA-417" | null              // issue/task link, optional
  prompt_ref: blake3(prompt_text) | null       // tamper-evident hash; null if no prompt
  prompt:     Ref | null                        // capability-gated pointer; null if no prompt
  sig:        ed25519(actor, canonical(...))    // over ALL fields above (§4.2)
}
```

`canonical(fields, actor)` is a single deterministic encoding of
`(op, actor, actor_kind, intent, reasoning, task, prompt_ref, prompt)` used for
the signed bytes, so no field is malleable (§8). `prompt` encodes as the `Ref`
pair (`id` + `plaintext_id`) or an explicit null sentinel — the same convention
`Op.payload` uses.

### 7.2 State transitions

- **`record(op, fields, actor)`** → (optional `store.put` prompt) → assemble
  fields → `signProvenance` → store under `op.id` → return record.
- **`append(peerProvenance)`** → store under `p.op` (idempotent on
  `(op, actor, sig)`); validity is **not** a gate (kept-and-labelled, §6.3).
- **`forOp(opId)`** → all records for that op id in deterministic order.
- **`verify(p)` / `status(p)`** → pure read; no mutation.

## 8. Crypto choices

Unchanged primitives from Pillars 01–03 (§8): `@noble/hashes/blake3` for
`prompt_ref` and as the hash family, ed25519 (via `@thaddeus.run/identity`) for
the provenance signature. No new primitives, no hand-rolled crypto, no native
deps.

`canonicalProvenance` mirrors `canonicalOp` (P03 `op.ts`):

- **Domain tag** `thaddeus.provenance.v1` is the first element of the signed
  tuple, so a provenance signature can never be confused with an op signature
  (`thaddeus.log.op.v1`) or another protocol's payload.
- **Canonical field rejection** before hashing/signing: `op`, `actor_kind`,
  `intent`, `reasoning` must be non-empty strings; `task` and `prompt_ref` are
  string-or-null; `prompt` is a `Ref` (string `id` + string `plaintext_id`) or
  null. This makes `verifyProvenance` (try/catch) reject malformed input and
  `signProvenance` fail fast — the same defense `canonicalOp` applies so a peer
  can't sign a coerced form while carrying a poisoning value.

`ProvenanceLog` calls `await ready()` transitively via identity/store; the
package documents that `ready()` must be awaited before use (consistent with
Tier 0/1).

## 9. The demo — provenance / the "why" layer (CLI)

`examples/provenance/` (sibling to `oplog/`, `offboarding/`, `disclosure/`),
deterministic via injected identities/seeds. Three acts:

**Act 1 — a signed why on a real op (P12 completed).**

1. Reuse `@thaddeus.run/log`: `write('main', 'src/auth.rs', fixBytes, author)`
   to produce a real `Op`.
2. `record(op, { intent, reasoning, task, actorKind: 'agent:claude-code@1.2',
   prompt }, actor)`.
3. Render a `strata log src/auth.rs --why`-style block: the op id + lamport, the
   actor/actor_kind/operator, intent and task, and `✓ verified`.

**Act 2 — the trust rule (tamper → unverified).**

4. Tamper a signed field on the record (e.g. rewrite `reasoning`, or downgrade
   `actor_kind` to `"human"`); show `status()` flips to `unverified` and the
   render marks it untrusted. Show an unsigned/peer record is **kept** and shown
   `unverified`, not dropped.

**Act 3 — the prompt does not leak.**

5. Show the public mirror sees only `prompt_ref` (a hash) and the `Ref` (an
   address) — `store.get` of the prompt **fails** for a non-grantee, and
   **succeeds** for the actor, confirming the hash matches `prompt_ref`.
6. Print the acceptance facts.

## 10. Acceptance criteria (measurable; written test-first)

1. **Signed why** — `record` produces a `Provenance` whose `verify` passes;
   `status` is `verified`.
2. **Full-record signature (hardening)** — mutating _any_ signed field (`op`,
   `actor`, `actor_kind`, `intent`, `reasoning`, `task`, `prompt_ref`, `prompt`)
   makes `verify` fail and `status` return `unverified`. _(The test that pins
   the deviation from the brief's narrower subset — §4.2.)_
3. **Bound to the op** — the record's `op` equals the `Op.id` it was recorded
   for; `forOp(op.id)` returns it.
4. **Prompt stored capability-gated** — with a prompt supplied,
   `prompt_ref = blake3(prompt)` and `store.get(prompt, actor)` returns the
   bytes whose hash equals `prompt_ref`; `store.get(prompt, stranger)` is denied.
5. **No prompt** — with no prompt, `prompt_ref` and `prompt` are both `null` and
   the record still verifies.
6. **Actor need not be author** — a record signed by an `actor` distinct from
   `op.author` still verifies (binding is to `op.id`, not to authorship). _(Pins
   §4 decision 4.)_
7. **Keep-and-label** — `append` of an invalid (tampered/unsigned) record does
   **not** throw; `forOp` returns it; `status` is `unverified`. _(Contrast with
   `OpLog.append`, which rejects — §6.3.)_
8. **Fail-closed verify** — a malformed record (undecodable `actor`,
   wrong-length `sig`, non-canonical field) returns `unverified` rather than
   throwing.
9. **Deterministic `forOp` order** — multiple records for one op id return in a
   stable order independent of insertion order.
10. **Domain separation** — a provenance signature does not verify as, and is not
    confused with, an op signature over structurally similar bytes (domain tag
    `thaddeus.provenance.v1`).
11. **Composition (north-star)** — the P04 `test.todo` becomes a real assertion:
    a signed `Provenance` attaches the why to the seeded edit's `Op`, `verify`
    passes, and tampering flips it to `unverified`. The flow reaches 5 pass /
    0 todo.

## 11. Honest limitations (stated, not hidden)

- **Reputation accrual deferred — and the trust rule is only half-built.** This
  release delivers the `verified`/`unverified` label but not the
  reputation/outcomes machinery that label gates ("never counts toward an
  agent's reputation"). That is Pillar 09; until it exists, the second clause of
  the brief's trust rule is named, not enforced (§4.4).
- **Signature scope deviates from the brief's literal formula — deliberately.**
  The brief shows `sig` over `op‖intent‖task‖prompt_ref`; this release signs the
  full record so `actor_kind` and `reasoning` cannot be forged or downgraded on
  relay (§4.2). The deviation is a hardening, stated here so the divergence from
  the source of truth is explicit.
- **No delegation/attestation.** `verify` proves _some_ `did:key` signed and
  bound an op id; it does not prove an agent was authorized to act _for_ a
  principal. The agent-for-human model is admitted (actor ≠ author allowed) but
  its authorization semantics are Pillar 09.
- **Unverified records are a spam vector.** Keep-and-label means a peer can
  attach unlimited unsigned "why" claims to any op id; they render `unverified`
  but still consume memory. Rate-limiting / scoping is out of scope for the
  spike, ledgered.
- **No real `--why` query surface.** The render exists only in the demo;
  querying provenance across history is Pillars 06/11.
- **Prompt-cap lifecycle not wired.** Storing the prompt capability-gated is
  built; granting it to reviewers and revoking a "why" reuse `store.grant`/
  `revoke` but are not wired in this release.
- **In-memory, single process.** No persistence, no network transport, no
  multi-process concurrency. Inherits Tier 0/1 spike limits.

## 12. Seeded/updated docs

- **`CHANGELOG.md`** — under `[Unreleased] → Added`: the P04 provenance layer
  (signed `Provenance` records bound to `Op.id`, full-record signature,
  capability-gated prompt storage, the `verified`/`unverified` trust label, the
  `ProvenanceLog` registry). In the **Deferred ledger**: add **reputation
  accrual / outcomes (→P09)**, **delegation/attestation (→P09)**, **`--why`
  query surface (→P06/P11)**, **prompt-cap grant/revoke wiring**, and
  **unverified-record spam control**.
- **`ARCHITECTURE.md`** — flip the **Pillar 04** row `planned → built` (package
  `@thaddeus.run/provenance`; Resolves P12); update the shared-primitives note
  if needed so the `Op` row's "Reused by … P04 provenance" points at the new
  package.
- **North-star** —
  `test.todo('P04: a signed Provenance record attaches the why to the Op')`
  becomes a real assertion. After this swap the seeded one-edit flow is **5
  pass / 0 todo**.

## 13. Open items / next primitives

- **Pillar 05 (virtual FS / COW views)** is the natural next primitive: the
  `code.store`-style in-memory API (cheap per-agent working copies, the
  worktree-killer). It is more user-facing and a larger build; it does not close
  any remaining north-star stub (the seeded flow is whole after P04).
- **Pillar 09 (agents as principals)** returns to finish the trust rule's
  reputation clause and to add delegation/attestation on top of this record.
- Confirm whether `Provenance`/`ProvenanceStatus` types graduate into a shared
  types package once a second consumer (P06 platform, P10 review, P09
  reputation) appears.
