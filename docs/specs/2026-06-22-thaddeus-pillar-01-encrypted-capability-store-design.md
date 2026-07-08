# Thaddeus — Pillar 01: encrypted objects with per-object capabilities (design)

**Date:** 2026-06-22 **Status:** Design — pending user review, then
implementation plan **Product:** Thaddeus (working name) · **Company/monorepo:**
Thaddeus (`@thaddeus/*`) **Source of truth (vision):**
`the-new-age-of-source-control.html`, Pillar 01 **Builds on:**
`docs/superpowers/specs/2026-06-22-thaddeus-monorepo-design.md` (the scaffold)

---

## 1. Context — why this primitive, why first

Thaddeus is an 11-pillar replacement for Git+GitHub. You cannot spec 11 pillars
at once, so we build **one primitive at a time, releasing each on its own**, and
we build the machinery that guarantees the separately-built pieces converge into
one substrate (§4).

The first primitive is **Pillar 01 — encrypted objects with per-object
capabilities.** The brief calls it the disease-and-cure and names its canonical
wedge: _"why can't you commit a `.env` file?"_ It is chosen first because:

- **Maximally differentiated.** No Gen-2 clone (GitLab/Bitbucket/Forgejo)
  touched the permission primitive (P18). This is the thing none of them dared
  replace.
- **Foundational.** Its `did:key` identity is reused by provenance (P04),
  reputation (P07), and agents (P09); its capability/encryption is reused by the
  membrane (P02) and agent revocation (P09). _One primitive, many uses._
- **Buildable now, zero open research.** Envelope encryption, libsodium sealed
  boxes, blake3 addressing — all off-the-shelf. (Contrast the CRDT/encryption
  frontier or the semantic graph, which the brief flags as the hard problems.)

It resolves complaints **P1, P2, P4, P18, P21**.

## 2. Governing principle — _stable seams, playground interiors_

This is an experimental build. We get to play with the tech. The discipline that
keeps "play" from becoming "11 things that never fit together" is a single rule:

> **Rigid:** each package's public API, the records in `ARCHITECTURE.md`, and
> the north-star integration flow. **Loose:** everything behind those seams —
> the crypto internals, the in-memory store, the CLI plumbing — is a spike,
> freely rewritten or swapped.

Consequences for this spec: no production hardening, no perf tuning, no
persistence, no key recovery. Tests pin the **contract and the acceptance
facts** (§10), not the throwaway internals.

### 2.1 Corollary — language is an interior decision

"Is TypeScript right, given performance?" is answered _by_ the principle above:
the language is an **interior** choice, protected by the seam, so it can change
later without breaking consumers.

- **TS now, for this primitive.** The scaffold is TS/Bun; the brief's own
  throughput existence-proof — code.store/Pierre, ~9M repos in 30 days, ~15K
  repos/min — _is a TS/Bun system_, so "TS can't hit the numbers" is
  contradicted by the brief's own evidence. just-bash (the in-memory FS model)
  is JS/TS, agents live in JS/TS sandboxes, and for **Pillar 01 specifically the
  hot path is in compiled crypto** (libsodium C/WASM + noble), not a TS
  interpreter loop. For a spike whose job is to prove the shape, velocity wins
  decisively.
- **The seam protects the future.** Because the contract is the public API plus
  a **language-agnostic record/wire format** (blake3, ed25519, xchacha20,
  canonical bytes for signatures), a hot interior can be reimplemented in Rust
  (→ WASM/NAPI) later, behind the same API. That is exactly the brief's
  "Protocol layer anyone can implement."
- **The brief's proof points already draw the language line.** code.store (TS)
  proves the API-first store/throughput layer (P01, P05, P06). jj and Delta DB
  (Rust) prove the op-log/CRDT convergence core (P03); rust-analyzer-class
  servers back the semantic graph (P08). So expect **TS for P01/P05/P06 and
  likely Rust for P03/P08**, interoperating through the protocol.
- **Decision rule:** move an interior to Rust only when a _measured_ hot path
  demands it. Never pre-optimize the spike.

## 3. The release's job

A **thesis-proving primitive + demo** (the smallest real thing). Deliverable:

- `@thaddeus/identity` + `@thaddeus/store` — two foundation packages (§6).
- An **offboarding CLI demo** that makes the `.env`/firing story undeniable
  (§8).
- The **convergence machinery** seeded: `ARCHITECTURE.md`, `CHANGELOG.md`, and a
  (mostly-stubbed) north-star integration test (§4).

Not the job: an adoptable product, a documented protocol spec, or any pillar
beyond 01. Those are later releases.

## 4. The convergence machinery (how 11 separate primitives become one substrate)

This is the part that answers "it needs to come together." It is a small
documentation + planning system plus one always-on integration test.

### 4.1 The doc system — 5 roles, single responsibility each

| Doc                                           | Single job                                                                                            | How it forces convergence                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The brief (`*.html`)                          | _Why_ — the vision (fixed)                                                                            | The north star every spec traces back to.                                                            |
| `thaddeus/ARCHITECTURE.md`                    | _How it fits_ — shared primitives, dependency graph, north-star flow, **status + traceability table** | The composition contract. Packages `import` the shared foundations listed here, so they can't drift. |
| `thaddeus/CHANGELOG.md`                       | _What shipped, when_ (chronological)                                                                  | The "what we did" ledger.                                                                            |
| Per-primitive spec + plan (`docs/.../specs/`) | _What this piece is_ + how to build it                                                                | Each piece designed against the architecture, not in a vacuum.                                       |
| Per-package `README`                          | _How to use this package_ (public API)                                                                | That API **is** the contract others depend on.                                                       |

The status/traceability table lives _inside_ `ARCHITECTURE.md` (not a separate
file — YAGNI). It lists every pillar → package → `built / stub / planned`, what
it depends on, and whether it is independently useful yet. It is how "what's
missing" is always answerable.

### 4.2 The dependency-ordered build order (the plan)

Each tier depends only on tiers below it, so a primitive's dependencies always
already exist as real packages — never a forward reference to vapor.

- **Tier 0 — Foundation (this release):** `@thaddeus/identity` (did:key) ·
  `@thaddeus/store` (Object + Capability, **P01**)
- **Tier 1 — The spine:** membrane/time (P02, extends capabilities) · operation
  log (P03, the `Op` record)
- **Tier 2 — Why + surface:** provenance (P04) · virtual FS (P05) · platform
  (P06)
- **Tier 3 — Home + authors:** identity federation & reputation (P07) · agents
  (P09)
- **Tier 4 — Meaning + governance:** semantic graph (P08) · review (P10) · live
  DB (P11)

### 4.3 The north-star flow — a continuous integration test

The brief's _"one edit, end to end"_ (write → snapshot → `Op` → provenance →
policy → mirror) is committed as a single integration test from day one,
**mostly stubbed**. The rule: _after each primitive ships, the flow swaps one
more stub for the real package._ Composition is verified continuously and
incrementally; when the last stub is gone, the substrate is whole — and we
watched it happen one green test at a time. In this release the flow exercises
the real `@thaddeus/identity` and `@thaddeus/store` (encrypt → store → grant →
mirror-holds-ciphertext) and stubs everything above.

### 4.4 The per-primitive loop (the process)

> read `ARCHITECTURE.md` → brainstorm → spec → plan → build (TDD) → extend the
> north-star flow to use the new real package → update `CHANGELOG.md` + the
> status/traceability table.

### 4.5 Dual-purpose — standalone for others, melted-together for Thaddeus

Each package has two lives, and the design must serve both:

1. **Standalone, usable by anyone.** `@thaddeus/store` is _"an encrypted,
   capability-based object store"_ — installable and useful to someone who has
   never heard of Thaddeus. Each package gets its own README and value
   proposition, stays dependency-light, and **leaks no Thaddeus-product
   assumptions**.
2. **Melted together in Thaddeus.** Inside our system the same packages compose
   into the substrate — via the shared primitives, the north-star flow, and the
   hosted Commons layer. Melting happens by **composition, not coupling**:
   Thaddeus depends on the packages; the packages never depend on Thaddeus.

This is not a tension to manage — it _is_ the brief's Part VIII three-layer
model: **Protocol** (open spec) + **Substrate** (open, adoption-tuned
packages) + **Commons** (the hosted product where they melt and where revenue
lives). The standalone-vs-melted duality is the monetization architecture,
already designed in.

### 4.6 GitHub repo layout

For now: **one public monorepo — `thaddeus/` — and nothing else.** Standalone
usability for others comes from **publishing each package to npm**
(`@thaddeus/*`), not from separate repos. (One repo, many published packages —
how Pierre, Vite, and Babel ship.) A polyrepo would fight the convergence
machinery, which is the whole point. Only `thaddeus/` is under git; the root
workspace stays local, so all planning docs live **inside** the repo to be
tracked.

```
thaddeus/                     # public monorepo · the open "Substrate" layer · git root
├─ packages/                  # published to npm as @thaddeus/* (standalone-usable)
│  ├─ identity/               # @thaddeus/identity — did:key (Tier 0)          [new]
│  ├─ store/                  # @thaddeus/store    — P01 objects+caps (Tier 0) [rename of core]
│  └─ theme/                  # @thaddeus/theme    — site tokens (existing)
├─ apps/                      # private (not published)
│  ├─ docs/  landing/         # existing sites
├─ examples/                  # private · standalone usage demos               [new]
│  └─ offboarding/            # the P01 CLI demo
├─ integration/               # private · the north-star end-to-end test       [new]
├─ docs/
│  ├─ specs/                  # per-primitive design specs (moved here, versioned) [new]
│  └─ protocol/               # language-agnostic wire-format spec (later)      [new]
├─ ARCHITECTURE.md  CHANGELOG.md                                               [new]
├─ README  AGENTS.md  CLAUDE.md  CONTRIBUTING.md  LICENSE       # existing
├─ .github/workflows/ci.yml   # lint + typecheck + test; publish later
└─ (moon · bun · tsconfig · oxlint · …)                         # existing tooling
```

- **Names:** brand/domain **thaddeus.run** · GitHub org **`thaddeus-run`**
  (GitHub org slugs can't contain dots) · repo **`thaddeus`** →
  `github.com/thaddeus-run/thaddeus` · npm scope **`@thaddeus.run/*`** (chosen —
  the literal dotted scope; it may not be claimable as an npm org at publish
  time, which is deferred, and the GitHub org keeps the hyphen). The scaffold's
  `@thaddeus/*` packages are re-scoped during the rename.
- **Licensing by layer (Part VIII):** the substrate (packages/CLI/SDK) ships
  permissive — **Apache-2.0** (chosen; includes a patent grant). The hosted
  **Commons** arrives later as a _separate, source-available_ repo (FSL/BSL), so
  the open substrate and the protected product never share one license.
- **Later repos, named now so it stays coherent:** `thaddeus` (now, open) → a
  `commons`/cloud repo (later, source-available) → optionally a foundation-held
  `protocol` repo once the spec is extracted. Not now.
- **Branch/release (spike-light):** `main` trunk + short feature branches;
  per-package semver tags (`@thaddeus/store@0.1.0`); no release automation yet.

## 5. Scope

**In (this release):**

- `@thaddeus/identity`: create identity, sign/verify, seal/unseal, `did:key`.
- `@thaddeus/store`: `Object`, `Capability`, an in-memory `Store`, and the four
  operations `put` / `get` / `grant` / `revoke`.
- Offboarding CLI demo.
- Seeded `ARCHITECTURE.md`, `CHANGELOG.md`, north-star integration test.
- Rename the scaffold's placeholder `@thaddeus/core` → `@thaddeus/store`;
  extract `@thaddeus/identity` as a new package.

**Out (deferred, named so scope stays honest):**

- Time-varying reveal / the membrane (P02). _We keep the `not_before` field in
  the data model so the format is stable; scheduled key-release is a later
  release._
- Operation log / CRDT (P03), provenance (P04), virtual FS & COW views (P05),
  git gateway, semantic graph (P08), and all of Tiers 1–4.
- Key **recovery / escrow / threshold / device-subkeys** (the brief's named
  landmine). v1 is single-keypair, no recovery: lose the key, lose the data.
- Persistence backends, federation, agent reputation/economy.

## 6. The two foundation packages (the seams)

### `@thaddeus/identity`

```ts
class Identity {
  static create(): Identity; // generates ed25519 + derived x25519
  readonly did: string; // did:key:z6Mk…
  sign(bytes: Uint8Array): Uint8Array; // ed25519 detached signature
  unseal(box: Uint8Array): Uint8Array; // open a sealed box addressed to me
  toPublic(): PublicIdentity; // the shareable half
}

class PublicIdentity {
  // what you hold about someone else
  static fromDid(did: string): PublicIdentity;
  readonly did: string;
  verify(bytes: Uint8Array, sig: Uint8Array): boolean;
  seal(bytes: Uint8Array): Uint8Array; // seal a message only this identity can open
}
```

### `@thaddeus/store`

```ts
interface Store {
  // in-memory now; backend drops in later
  put(plaintext: Uint8Array, owner: Identity): Promise<Ref>;
  get(ref: Ref, reader: Identity): Promise<Uint8Array>; // throws AccessDenied without a capability
  grant(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void>;
  revoke(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void>;
  // mirror view — proves an untrusted holder can verify without decrypting:
  rawObject(id: string): Object | undefined;
  verify(id: string): boolean; // recompute blake3(ciphertext) === id
}
type Ref = { id: string; plaintext_id: string };
```

`@thaddeus/store` **depends on** `@thaddeus/identity`. That import is the seam
that keeps them composing.

## 7. Data model (records — straight from the brief)

```
Object {
  id:           blake3(ciphertext)   // the address; a mirror can verify without decrypting
  plaintext_id: blake3(plaintext)    // dedup + identity, stable across re-wraps
  alg:          "xchacha20poly1305"
  nonce:        <24 bytes>
  ciphertext:   <bytes>              // never stores plaintext or the content key
}

Capability {
  object:      plaintext_id          // what it unlocks (stable across rotations)
  grantee:     did:key:…             // human OR agent
  wrapped_key: seal(content_key → grantee.x25519)   // libsodium sealed box
  granted_by:  did:key:…
  not_before:  <timestamp>           // field kept for P02; v1 enforces only "≤ now"
  sig:         ed25519(granted_by, canonical(object‖grantee‖not_before))
}
```

**`grant(obj, who)`** = append a `Capability` wrapping `content_key` for `who`
(granter must already hold the key). **`revoke(obj, who)`** = new `content_key`
→ re-encrypt plaintext → new `Object` (new `id`, same `plaintext_id`) → re-issue
capabilities for remaining grantees only. Old ciphertext stays addressable but
inert.

## 8. Crypto choices

- `libsodium-wrappers-sumo` for the audited primitives the brief names:
  `crypto_box_seal` / `crypto_box_seal_open` (sealed box),
  `crypto_aead_xchacha20poly1305_ietf_*` (object encryption), `crypto_sign_*`
  (ed25519), and `crypto_sign_ed25519_{pk,sk}_to_curve25519` (derive the x25519
  sealing key from the ed25519 identity — one identity, both uses).
- `@noble/hashes/blake3` for addressing (libsodium has no blake3).
- `did:key` = multibase(`z`, base58btc) over multicodec-prefixed ed25519 key.

**No hand-rolled crypto. No native deps** — so it runs in the in-memory agent
sandboxes the thesis cares about.

## 9. The demo — the offboarding story (CLI)

A script (`offboarding.ts`) that prints, step by step:

1. **Alice stores a secret** (`DATABASE_URL=…`). Print the raw stored bytes →
   gibberish. _(Acceptance: zero plaintext at rest.)_
2. **An untrusted mirror** holds the object and verifies it by
   `blake3(ciphertext)` **without decrypting**.
3. **Bob can't read it** (`AccessDenied` — he holds only ciphertext).
4. **Alice grants Bob** → Bob decrypts → sees the secret.
5. **"Fire Bob":** one `revoke` call, sub-second. Bob can no longer read the
   current object; his old capability opens nothing.
6. Print the acceptance facts (zero plaintext; revoke = one op; addressing
   holds).

The CVE/coordinated-disclosure flow is more dramatic but needs the time-membrane
(P02), so it is the _second_ demo, not this one.

## 10. Acceptance criteria (measurable; written test-first)

The Part II "floor" for this primitive, as tests against the public API:

1. **Zero plaintext at rest** — no stored bytes equal the known plaintext.
2. **Access control** — a non-grantee cannot decrypt; a grantee can.
3. **Revocation (forward-only)** — after `revoke`, the revoked party cannot read
   the rotated object; remaining grantees still can.
4. **Addressing + integrity** — `id === blake3(ciphertext)`; tampering with the
   ciphertext is detected via `verify`.
5. **Identity across rotation** — `plaintext_id` is stable before/after a
   rotation.
6. **Speed** — `revoke` completes sub-second on a single object.
7. **Composition** — the north-star integration test runs `@thaddeus/identity` +
   `@thaddeus/store` for real (encrypt → store → grant → mirror-verifies).

## 11. Honest limitations (stated, not hidden)

- **Revocation cannot un-read.** It stops _future_ decryption of the rotated
  object; it cannot recall plaintext a party already read, and an offline
  grantee keeps the old key until re-sync. (Brief, Pillar 01.)
- **No key recovery.** Single keypair; lose it, lose the data. By design for v1.
- **In-memory only**, single process. Not durable, not concurrent-safe.
- **Third-party crypto/throughput claims** in the brief are targets to
  reproduce, not verified here.

## 12. Seeded docs (created during implementation, specified here)

- **`ARCHITECTURE.md`** — shared-primitives reuse table (Identity/Object/
  Capability/Op + consumers), the Tier 0–4 dependency graph, the north-star
  flow, and the status/traceability table with Tier 0 = `in progress` and the
  rest = `planned`.
- **`CHANGELOG.md`** — Keep-a-Changelog format; `[Unreleased]` →
  `@thaddeus/identity` and `@thaddeus/store` under _Added_.

## 13. Open items / next primitives

- Tier 1: membrane (P02) extends `Capability` with time-released key-wrapping;
  operation log (P03) introduces the `Op` record. Both consume Tier 0 unchanged.
- Confirm final package names once more primitives land (the monorepo doc
  flagged `core` as a placeholder; this release replaces it with `store` +
  `identity`).
