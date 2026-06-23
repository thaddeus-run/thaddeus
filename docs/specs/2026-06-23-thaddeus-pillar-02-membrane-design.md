# Thaddeus — Pillar 02: visibility as a time-varying policy, "the membrane" (design)

**Date:** 2026-06-23
**Status:** Design — pending user review, then implementation plan
**Product:** Strata (working name) · **Company/monorepo:** Thaddeus (`@thaddeus.run/*`)
**Source of truth (vision):** `the-new-age-of-source-control.html`, Pillar 02
**Builds on:** `docs/specs/2026-06-22-thaddeus-pillar-01-encrypted-capability-store-design.md`

---

## 1. Context — why this primitive, why now

Strata is an 11-pillar replacement for Git+GitHub, built **one primitive at a
time**, each release swapping one stub in the north-star integration test for a
real package (the convergence machinery; Pillar 01 spec §4).

Pillar 01 (encrypted objects + per-object capabilities) shipped: `@thaddeus.run/identity`
and `@thaddeus.run/store`, with the offboarding demo and a green north-star test
carrying three `test.todo`s for the pillars above. **Pillar 02 — visibility as a
time-varying policy ("the membrane")** is the next Tier-1 primitive. It is chosen
now because:

- **It is the smallest real leap from Tier 0.** The `Capability` record already
  carries `not_before`, `issueCapability` already accepts it, and the store
  already enforces `not_before ≤ now`. P02 reuses all of it.
- **It consumes Tier 0 unchanged** (Pillar 01 spec §13) — no forward references to
  unbuilt pillars on its critical path.
- **It unlocks the second hero demo** — the coordinated-disclosure (CVE) flow the
  brief calls "the flow Git cannot" — which strengthens the narrative the brief
  sells, without new open research on its payload path.

It resolves complaints **P2, P3, P4** (per the brief's Pillar 02), with the
metadata-leak half of P3 explicitly deferred (§5, §11).

## 2. Governing principle — *stable seams, playground interiors*

Unchanged from Pillar 01 (§2): **rigid** = each package's public API, the records
in `ARCHITECTURE.md`, and the north-star flow; **loose** = everything behind those
seams. Consequences here: no production hardening, no real time-lock crypto, no
persistence, in-memory only. Tests pin the contract and acceptance facts (§10),
not the throwaway internals.

### 2.1 What the brief asks for, and what is buildable now

The brief's Pillar 02 has two halves:

1. **Timed key-release (buildable now).** Visibility is `(object × identity ×
   time)`. A future grant is not a flag flip — because bytes are encrypted (P01),
   revealing is a **key-release event**: at the trigger, the object's content key
   is re-wrapped to a well-known `public` identity. Ciphertext can sit in a public
   mirror the entire embargo and only become readable at T.
2. **Metadata-gating (deferred — research).** Sealing the payload is not enough: an
   op's path, symbol, author, and timing leak the vulnerability. True gating
   publishes only an opaque, capability-gated ordering token until T. This needs
   **P03's `Op` record** (which does not exist yet) and owns the brief's Part VI
   frontier — fast CRDT convergence wants cleartext metadata; a real embargo wants
   it sealed. Out of scope here; see §11.

**This release builds half 1 (payload timed-reveal) and explicitly defers half 2.**

## 3. The release's job

Extend `@thaddeus.run/store` with scheduled, withheld key-release; prove the
coordinated-disclosure story end to end. Deliverables:

- `scheduleReveal` + `reveal` on `Store`, a well-known `public` identity, and the
  `#pending` withheld-reveal queue (§6).
- A small deterministic-identity addition to `@thaddeus.run/identity`
  (`Identity.fromSeed`) so the `public` keypair is reproducible (§6).
- A **disclosure CLI demo** (`examples/disclosure/`) enacting the CVE timeline (§9).
- The north-star integration test's P02 `test.todo` swapped for a real assertion;
  `ARCHITECTURE.md` Pillar 02 row flipped `planned → built` (§12).

Not the job: metadata-gating, release/event triggers, time-lock crypto, persistence
(§5, §11).

## 4. Decisions taken (brainstorm outcomes)

1. **Embargo fidelity — withheld key-release** (not honor-system, not time-lock).
   The public key-release does not exist on the mirror until T; the store holds it
   back in a private queue and materializes it at the trigger.
2. **Home — extend `@thaddeus.run/store`** (not a new package). P02 extends
   `Capability` and needs the store's content-key custody and rotation internals;
   a separate package would force the store to leak those internals across a seam.
3. **Trigger — injected clock + both `timestamp` and `manual` triggers, lazy
   materialization.** Reads take an explicit `now`; reveals fire on the first read
   at-or-after T, or on an explicit `reveal()` call. `release(tag)`/`event`
   triggers deferred.
4. **Scope — payload timed-reveal only**; metadata-gating deferred to post-P03.

### 4.1 Why "withheld" and not "honor-system" — the honest trust statement

An *unattended* reveal at T means the key-release must be pre-computed and held by
**some** trusted holder before T — otherwise no one is present to release it.
A genuinely trustless unattended embargo needs time-lock crypto (deferred, §11).
So "withheld key-release" here means: the public-wrapped capability is held in a
private `#pending` queue the mirror never sees, and the trigger **promotes** it
into the served set (the "key-release event"). The demonstrable property: *during
the embargo the public mirror provably holds only ciphertext, and no served
structure wraps a key to `public`.* The honest limitation — a dishonest store
could promote early — is stated, not hidden (§11), matching the brief's candor
about revocation.

The two rejected alternatives:

- **Escrow principal** — escrow the content key to an automated "membrane"
  identity that re-seals to `public` at T. Strictly stronger (no public-wrapped key
  exists during embargo at all) but the same trust shape (a trusted automated
  holder) with more moving parts.
- **Re-key-on-reveal** — the maintainer re-supplies the key at T. No escrow, but
  requires them online at T, defeating the scheduled-deadline point.

## 5. Scope

**In (this release):**

- `Store.scheduleReveal(ref, at, by)` and `Store.reveal(ref, now?)`.
- `get(ref, reader, now?)` — optional injected clock; lazy reveal-on-read.
- A well-known `public` identity (deterministic keypair, world-known secret).
- `Identity.fromSeed(seed)` in `@thaddeus.run/identity`.
- `revoke` interaction: re-key pending reveals; cancel a pending reveal via
  `revoke(ref, PUBLIC_IDENTITY)`.
- Disclosure CLI demo; north-star P02 swap; `ARCHITECTURE.md` + `CHANGELOG.md`.

**Out (deferred, named so scope stays honest):**

- **Metadata-gating** (path/symbol/author/timing). Needs P03's `Op`; research
  frontier (§11).
- **Trustless timed reveal** (time-lock / VDF). Open research (§11).
- **`release(tag)` and `event` triggers** — only `timestamp` + `manual` now.
- Persistence, federation, multi-process concurrency.

## 6. The seam (public API delta)

### `@thaddeus.run/identity` (small addition)

```ts
class Identity {
  static create(): Identity              // existing — random keypair
  static fromSeed(seed: Uint8Array): Identity   // NEW — deterministic keypair
  // ... unchanged: did, sign, unseal, toPublic
}
```

`fromSeed` is generally useful (reproducible test identities, well-known
identities) and Strata-agnostic — it does not leak product assumptions.

### `@thaddeus.run/store` (the membrane)

```ts
// A well-known identity whose secret key is world-known. A capability served to
// PUBLIC means "world-readable". Built from a fixed published seed.
export const PUBLIC_IDENTITY: Identity;     // and PUBLIC_DID: string

interface Store {
  // ... existing: put, grant, revoke, rawObject, current, verify

  // now is optional; defaults to current time. Tests/demo inject it so a
  // security outcome never depends on hidden wall-clock. Before resolving the
  // key, promotes any due (#pending, not_before ≤ now) reveals into the served
  // set (the lazy timestamp trigger).
  get(ref: Ref, reader: Identity, now?: string): Promise<Uint8Array>;

  // Schedule a withheld reveal: `by` (must hold the content key) seals it to
  // PUBLIC_IDENTITY with not_before = at, parked in #pending. Nothing served or
  // mirrored yet.
  scheduleReveal(ref: Ref, at: string, by: Identity): Promise<void>;

  // Manual trigger. Promotes due pending reveals for this object into the served
  // set. Returns true if anything was released.
  reveal(ref: Ref, now?: string): Promise<boolean>;
}
```

A **pending reveal is just a `Capability`** (grantee = `PUBLIC_DID`,
`not_before = at`), reusing `issueCapability`/`verifyCapability` verbatim. The only
new state is where it is held:

```
MemoryStore adds:
  #pending: Map<plaintext_id, Capability[]>   // withheld; never served, never mirrored
```

The mirror view (`rawObject`, `current`, `verify`) is unchanged — it exposes
ciphertext only — so the embargo holds by construction.

## 7. Data model

No new record type. Reuses the Pillar 01 `Capability` exactly (object =
`plaintext_id`, grantee = `PUBLIC_DID`, `wrapped_key` = seal(content_key →
PUBLIC x25519), `not_before` = reveal time T, `sig` = granter signature over
`canonical(object‖grantee‖not_before)`).

State transitions:

- **`scheduleReveal(ref, T, by)`** → append a `public` `Capability` (not_before=T)
  to `#pending[plaintext_id]`. Not in `#caps`, not in the mirror view.
- **trigger** (lazy `get` with `now ≥ T`, or `reveal()`) → move due pending
  capabilities from `#pending` into `#caps` (served). This is the key-release.
- **`revoke(ref, who)`** → rotate key, re-encrypt, re-issue served caps for
  remaining grantees, **and re-seal each pending reveal to the new key** (a
  pending reveal is a "future grantee"; it survives rotation, pinned to
  `plaintext_id`, not a ciphertext `id`).
- **`revoke(ref, PUBLIC_IDENTITY)`** → if a reveal is still pending, **remove** it
  (cancel the disclosure); if already fired, ordinary rotation-away-from-public.

## 8. Crypto choices

Unchanged from Pillar 01 (§8): `libsodium-wrappers-sumo` sealed boxes for
`wrapped_key`, ed25519 for capability signatures, `@noble/hashes/blake3` for
addressing. `Identity.fromSeed` uses libsodium's seeded keypair
(`crypto_sign_seed_keypair`) then the existing ed25519→x25519 derivation. No
hand-rolled crypto, no native deps.

## 9. The demo — coordinated disclosure (CLI)

`examples/disclosure/` (sibling to `offboarding/`), deterministic via an injected
clock:

1. **Maintainer commits a fix** as an object, granted only to `@maintainer`. Print
   raw stored bytes → ciphertext.
2. **An untrusted public mirror** holds the object and `verify()`s it by
   `blake3(ciphertext)` **without decrypting** — the whole embargo.
3. **Schedule the reveal** (`scheduleReveal(ref, T, maintainer)`). Print proof that
   **no public-readable key-release exists in any served structure** — the mirror
   still shows only ciphertext. *(The line honor-system could not honestly print.)*
4. **Before T**: `get(ref, PUBLIC, now<T)` → `AccessDenied`.
5. **At T** (advance the injected clock): `get(ref, PUBLIC, now≥T)` → plaintext.
6. Print the acceptance facts.

The `@distros`-before-public rung of the brief's ladder is shown as an ordinary
`grant(@distros, not_before=release)` — demonstrating the *named-set* rungs already
work from Pillar 01, and the membrane adds only the `public` rung.

## 10. Acceptance criteria (measurable; written test-first)

1. **Embargo holds** — before T, `PUBLIC_IDENTITY` cannot read (`AccessDenied`);
   the mirror view exposes only ciphertext; no served capability wraps to `PUBLIC_DID`.
2. **Reveal fires** — at/after T, `PUBLIC_IDENTITY` reads the plaintext, both via
   lazy `get` and via manual `reveal()`.
3. **Withheld, not honor-system** — a scheduled-but-unfired reveal is absent from
   the served capability set and mirror view; it exists only in `#pending`.
4. **Survives rotation** — a `revoke` between schedule and T re-keys the pending
   reveal; it still reveals the live object at T.
5. **Cancellable** — `revoke(ref, PUBLIC_IDENTITY)` before T removes the pending
   reveal; nothing reveals at T.
6. **Determinism** — outcomes depend only on injected `now`, never wall-clock.
7. **Signed & verifiable** — the reveal capability verifies under `verifyCapability`.
8. **Composition** — the north-star test runs the real P02 reveal (schedule →
   mirror-holds-only-ciphertext → advance clock → `public` reads).

## 11. Honest limitations (stated, not hidden)

- **Reveal is store-honest, not trustless.** The public key-release is
  pre-computed and withheld by the store until T; a dishonest store could promote
  it early. A trustless unattended embargo needs time-lock crypto — deferred.
- **Payload only — metadata still leaks.** This release gates the bytes, not the
  path/symbol/author/timing. True metadata-gating needs P03's `Op` and owns the
  brief's Part VI convergence-vs-embargo frontier.
- **No `release(tag)`/`event` triggers** — only `timestamp` and `manual`.
- **In-memory only**, single process; inherits Pillar 01's limits (no recovery,
  revocation cannot un-read, third-party claims unverified).

## 12. Seeded/updated docs

- **`CHANGELOG.md`** — under `[Unreleased] → Added`: the P02 membrane (scheduled
  reveal). The "Deferred — known gaps we owe" ledger already tracks the research
  and scope-cut items; graduate the membrane line when it lands.
- **`ARCHITECTURE.md`** — flip the Pillar 02 row `planned → built`; the
  `Capability` row's "P02 reveal" reuse note becomes real.
- **North-star** — `test.todo('P02: a scheduled reveal re-wraps the content key to
  public at T')` becomes a real assertion.

## 13. Open items / next primitives

- P02 metadata-gating returns once P03's `Op` record exists (Tier 1, the other
  Spine primitive).
- `release(tag)`/`event` triggers layer on once there is a release/event concept
  (P06 platform / P03 op log).
- Confirm whether the `public` identity belongs in `@thaddeus.run/store` (current
  choice, as a membrane concept) or graduates to `@thaddeus.run/identity` once a
  second consumer appears.
