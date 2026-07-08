# Thaddeus — Pillar 03: an operation log with continuous convergence (design)

**Date:** 2026-06-23 **Status:** Design — pending user review, then
implementation plan **Product:** Thaddeus (working name) · **Company/monorepo:**
Thaddeus (`@thaddeus.run/*`) **Source of truth (vision):**
`the-new-age-of-source-control.html`, Pillar 03 **Builds on:**
`docs/specs/2026-06-23-thaddeus-pillar-02-membrane-design.md`,
`docs/specs/2026-06-22-thaddeus-pillar-01-encrypted-capability-store-design.md`

---

## 1. Context — why this primitive, why now

Thaddeus is an 11-pillar replacement for Git+GitHub, built **one primitive at a
time**, each release swapping one stub in the north-star integration test for a
real package (Pillar 01 spec §4).

Tier 0 shipped: `@thaddeus.run/identity` and `@thaddeus.run/store` (Pillar 01,
encrypted objects + per-object capabilities). The first Tier-1 primitive shipped
too: the **membrane** (Pillar 02, payload timed-reveal). **Pillar 03 — the
operation log** is the other Tier-1 Spine primitive, and it is chosen now
because:

- **It is the source-of-truth inversion the whole architecture rests on.** The
  brief's decision-before-anything (Part III, "Gen 3 leaves Git"): the truth is
  a log of signed, CRDT-ordered **operations**; content-addressed snapshots
  still exist but as a _derived projection_ of that log. Until the `Op` record
  exists, every pillar above Tier 1 has nothing to attach to.
- **It unblocks the half of Pillar 02 we explicitly deferred.** The membrane
  spec (§2.1, §11) and the CHANGELOG research ledger both defer
  **metadata-gating** onto "P03's `Op` record, which does not exist yet."
  Sealing an embargoed change's _bytes_ is not enough; its path, author, and
  timing leak the vulnerability. You cannot gate operation metadata until
  operations exist. This release builds the **structural seam** for that gating
  (§6.4), closing the other half of the membrane.
- **It consumes Tier 0 across its public API only** — `store.put` for the
  capability-gated payload, `store.scheduleReveal`/`reveal` to gate an embargoed
  op's metadata, `identity` to sign. No new store internals leak across the
  seam, which is why it earns a **new package** rather than another store
  extension (§4, decision 2).

It resolves complaints **P5** (commits/branches are the wrong base unit), **P6**
(parallel working copies without worktrees), and **begins P12** (history records
the _what_ and now the _who/causal-order_; the _why/intent_ is completed by
Pillar 04). Three frontiers are named and deferred, not waved away (§11).

## 2. Governing principle — _stable seams, playground interiors_

Unchanged from Pillars 01–02 (§2): **rigid** = the new package's public API, the
`Op` record in `ARCHITECTURE.md`, and the north-star flow; **loose** =
everything behind those seams. Consequences here: in-memory only, single
process, no persistence, no network transport, no production hardening. Tests
pin the contract and the acceptance facts (§10), not the throwaway internals.

The two genuinely rigid, expensive-to-reverse calls in this release are the
**addressable unit of an op** and the **view-membership model**. Both are
decided here on purpose (§4.3, §4.4) rather than left to emerge from code.

### 2.1 What the brief asks for, and what is buildable now

The brief's Pillar 03 makes four claims. This release takes a clear position on
each:

1. **The log is the truth; snapshots are a projection** (buildable now). The
   `Op` record is the primitive; `materialize()` derives the file tree from it.
2. **Continuous convergence with CRDT semantics** (buildable now, bounded).
   Operations carry a DAG (`parents`) and a Lamport clock; a deterministic total
   order `(lamport, id)` plus **last-writer-wins per path** gives an
   order-independent projection — a real CRDT (an LWW-element map keyed by
   path). What is **deferred** is _3-way content/text merge_: when two
   concurrent ops touch the same path, LWW picks a deterministic winner and
   `conflicts()` surfaces the collision, but the loser's bytes are dropped at
   the materialized layer rather than merged. "Content merge deferred" is
   load-bearing — said plainly here, not buried (§11).
3. **Branches and the repository dissolve** (half now). _Branches_ dissolve: a
   view is a name over a head-set, not a copy (§4.4, §6.3). The _repository_
   dissolution (a capability-scoped slice of a global graph, materialized on
   touch) is the brief's own Pillar 05 territory ("materialized on touch (Pillar
   05)") and is **deferred to P05**, recorded in the CHANGELOG ledger.
4. **Metadata-gating for embargoed ops** (structural seam now). An embargoed op
   publishes only an opaque ordering token to the public mirror; its real
   metadata is sealed and released at T via the P02 membrane (§6.4). The
   _convergence over sealed metadata_ — how peers who cannot read an op's
   metadata still merge content-aware — stays the named Part VI frontier (§11).

## 3. The release's job

Introduce `@thaddeus.run/log`: the `Op` record and an in-memory `OpLog` that
records edits as signed operations, converges them deterministically, projects
them to a file tree, and gates embargoed ops' metadata through the membrane.
Deliverables:

- The **`Op` record** (§7.1) and `OpLog` class (§6) in a new package
  `@thaddeus.run/log`, depending on `@thaddeus.run/identity` and
  `@thaddeus.run/store` (public APIs only).
- **Convergence**: Lamport clocks, DAG `parents`, deterministic `(lamport, id)`
  order, LWW-per-path `materialize()`, concurrency/`conflicts()` detection.
- **Named views**: `view`/`fork`/`heads` — branches as zero-copy pointers (P6).
- **Delete tombstones** (`payload: null`); rename deferred (§11).
- **Metadata-gating seam**: `write(…, { embargoUntil })`, `publicView` (opaque
  token), `reveal` — reusing `store.scheduleReveal`/`reveal` verbatim (§6.4).
- An **operation-log CLI demo** (`examples/oplog/`) enacting convergence + an
  embargoed op (§9).
- The north-star integration test's **P03 `test.todo` swapped** for a real
  assertion; `ARCHITECTURE.md` Op row and Pillar 03 row flipped
  `planned → built` (§12).

Not the job: 3-way content merge, convergence over sealed metadata, the
repository-as-slice, persistence, network/federation, vector clocks,
symbol-level ops (§5, §11).

## 4. Decisions taken (brainstorm outcomes)

1. **Release scope — op log + the metadata-gating _seam_.** Build the `Op`
   primitive and wire the structural embargo seam that closes Pillar 02's other
   half. 3-way content merge and convergence-over-sealed-metadata stay named
   frontiers.
2. **Home — a new package `@thaddeus.run/log`** (not a store extension). The
   `Op`/DAG/ordering is a distinct primitive with its own data model and its own
   `ARCHITECTURE.md` row; it consumes the store across its _public_ API (`put`,
   `scheduleReveal`, `reveal`, `get`), so no store internals cross the seam —
   unlike P02, which needed the store's private content-key custody.
3. **Op model — snapshot-pointer + LWW-per-path.** An op records "at this DAG
   position, `path` := object `Ref`" (the payload is a capability-gated store
   object). Concurrent ops on the same path resolve by last-writer-wins under
   the `(lamport, id)` order and are surfaced by `conflicts()`. A real CRDT, no
   text-CRDT needed.
4. **Views — named views as materializations.** A view is `{ name, heads }`; a
   branch is a saved pointer over the converging graph, not a copy. Repository
   dissolution deferred to P05 (ledger).

### 4.1 P12 is _begun_, not resolved (honest claim)

Pillar 03's record carries `author` and causal context (`parents`), so it
durably records the _who_ and the _what-before-what_ that Git discards. It does
**not** carry intent/reasoning — there is no `intent` field on `Op`. The "why"
layer (intent, prompt-ref, reasoning, signed) is **Pillar 04 (provenance)**.
ARCHITECTURE attributes P12 to both pillars; the precise split is: P03 records
who + causal order, P04 records why. This spec claims only the former.

### 4.2 No `view` field on the `Op` (changed during review)

An earlier draft stamped each op with the view it extended (`view: "main"`).
That contradicts the zero-copy claim: if an op intrinsically names its view, the
same op cannot appear under a second view without copying it or making the field
a lie — and as drafted the field was unsigned and thus relay-malleable.

**Decision:** ops are **view-agnostic DAG nodes**. A view is purely
`{ name, heads }`. `write(view, …)` advances _that view's_ heads but stamps
nothing on the op. Materializing a view = LWW over the ancestor-closure of its
heads. The same op participates identically in every view whose head-set reaches
it (pinned by acceptance test 11). The signature covers every field on the
record, so nothing on an op is relay-malleable.

### 4.3 Addressable unit = `path` now, staged to symbol-id at P08

LWW keyed on `path` is file-unit granularity — coarser than Thaddeus's
per-object pitch. This is a **deliberate staging choice, not a regression to fix
later**: the brief itself generalizes the unit at Pillar 08 ("the Op targets a
symbol id instead of a path"). Going finer _now_ requires either P08's semantic
graph (a later tier needing a language server) or line/byte deltas (the
text-CRDT frontier already deferred). So `path` is the correct spike unit; the
`Op.path` field generalizes to a symbol-id under P08 without a record reshape.
The cost is named (§11): concurrent same-path edits drop the loser's bytes at
the materialized layer.

### 4.4 Convergence model — Lamport + DAG, not vector clocks

Causality is captured structurally by `parents` (the DAG); the Lamport clock
provides a deterministic, monotone tiebreak for total ordering. Vector clocks
(precise concurrency detection across many authors) are unnecessary for the
spike: concurrency is detected directly from the DAG (two ops are concurrent iff
neither is in the other's ancestor-closure). Vector/interval clocks are a
later-tier optimization, ledgered.

## 5. Scope

**In (this release):**

- Package `@thaddeus.run/log` with the `Op` record and `OpLog` class (§6).
- `write`, `remove` (tombstone), `append` (peer ingest), `view`, `fork`,
  `heads`, `ops`, `materialize`, `conflicts`, `verify`, `reveal`, `publicView`.
- Lamport clock (root = 0), DAG parents, `(lamport, id)` total order,
  LWW-per-path projection, concurrency detection.
- Embargo seam: opaque ordering token on the public mirror, sealed metadata,
  timed reveal via the P02 membrane.
- `examples/oplog/` demo; north-star P03 swap; `ARCHITECTURE.md` +
  `CHANGELOG.md`.

**Out (deferred, named so scope stays honest):**

- **3-way content/text merge.** Conflicts are surfaced and LWW-resolved, not
  merged (§11).
- **Convergence over sealed metadata.** Part VI frontier — peers who cannot read
  an embargoed op's metadata cannot do content-aware placement during embargo
  (§11).
- **Repository-as-capability-scoped-slice** → Pillar 05 (virtual FS).
- **Rename/move as a first-class op** → Pillar 08 (`move-definition`); faking it
  as two unlinked path-ops loses the move (§11).
- **Symbol-level addressing** (`Op.path` → symbol-id) → Pillar 08.
- **Provenance/intent** (`why`) → Pillar 04.
- Persistence, network transport, federation, multi-process concurrency, vector
  clocks.

## 6. The seam (public API delta)

New package. No changes to `@thaddeus.run/identity`. No changes to
`@thaddeus.run/store`'s API — the log consumes its existing public surface.

### `@thaddeus.run/log`

```ts
import type { Identity } from '@thaddeus.run/identity';
import type { Ref, Store } from '@thaddeus.run/store';

// A signed operation. View-agnostic: an op is a DAG node, not a branch member.
interface Op {
  readonly id: string; // blake3(canonical) — mergeable WITHOUT decryption
  readonly path: string; // addressable unit; → symbol-id at P08
  readonly parents: readonly string[]; // the DAG; root = []
  readonly lamport: number; // root = 0; else 1 + max(parents.lamport)
  readonly author: string; // did:key — same identity that holds caps (P01)
  readonly payload: Ref | null; // capability-gated store object; null = delete tombstone
  readonly sig: Uint8Array; // ed25519(author, canonical(path,parents,lamport,author,payload))
}

// What a public mirror sees for an op. For an embargoed op, only an opaque
// ordering token + a pointer to the sealed metadata object are exposed.
type PublicOp =
  | { readonly kind: 'open'; readonly op: Op }
  | {
      readonly kind: 'embargoed';
      readonly id: string;
      readonly ordering_token: string; // opaque; lets peers order, names nothing
      readonly sealed_meta: Ref; // capability-gated metadata object (membrane-revealed at T)
    };

interface Conflict {
  readonly path: string;
  readonly ops: readonly string[]; // concurrent op ids on the same path
  readonly winner: string; // the (lamport, id) LWW winner
}

class OpLog {
  constructor(store: Store);

  // Record an edit: store the bytes as a capability-gated object, then append a
  // signed Op extending `view`'s heads. Returns the new Op. With embargoUntil,
  // the op's metadata is sealed and a timed reveal is scheduled (§6.4).
  write(
    view: string,
    path: string,
    bytes: Uint8Array,
    author: Identity,
    opts?: { embargoUntil?: string }
  ): Promise<Op>;

  // Record a delete (payload: null tombstone) extending `view`'s heads.
  // (Embargoed deletes are out of scope for this spike — only `write` embargoes.)
  remove(view: string, path: string, author: Identity): Promise<Op>;

  // Ingest a signed op from a peer (the convergence entry point). Verifies the
  // signature and id, recomputes nothing about lamport (trusts the signed value),
  // and links it into the DAG. Idempotent on op id.
  append(op: Op): void;

  // Create or re-point a named view. With no heads, an empty view (heads = []).
  view(name: string, heads?: readonly string[]): void;

  // Zero-copy branch: a new view whose heads start equal to fromView's heads.
  fork(name: string, fromView: string): void;

  // With a view name: that view's heads. With no view: the global frontier —
  // every op that is no other known op's parent (the DAG's sink nodes). The
  // global frontier is deterministic given the op set, which is what lets the
  // no-view materialize() be the CRDT-determinism check (acceptance 4).
  heads(view?: string): readonly string[];
  ops(): readonly Op[]; // deterministic (lamport, id) order

  // Project the log to a path → { ref, op } tree by LWW over the ancestor-
  // closure of the view's heads. Uses CLEARTEXT METADATA ONLY — it never
  // decrypts a payload, so it cannot return plaintext; reading content is a
  // separate `store.get(ref, reader)` call. `as` lets a capability-holder place
  // embargoed ops whose sealed metadata they can unseal; without it (the public
  // mirror view) embargoed ops are unplaced until revealed.
  materialize(
    view?: string,
    as?: Identity
  ): Map<string, { ref: Ref | null; op: Op }>;

  conflicts(view?: string): readonly Conflict[];
  verify(opId: string): boolean; // signature + id integrity

  // Release an embargoed op's sealed metadata at/after T (the membrane key-
  // release). After this, materialize() places the op publicly. Returns true if
  // anything was released.
  reveal(opId: string, now?: string): Promise<boolean>;

  // What a public mirror sees for an op (opaque token if still embargoed).
  publicView(opId: string): PublicOp;
}
```

The `now` parameter on `reveal` is the same trusted/test-only clock injection
documented on `Store.get`/`reveal` — never wired to untrusted callers.

### 6.1 Writing an edit

`write(view, path, bytes, author)`:

1. `ref = await store.put(bytes, author)` — bytes become a capability-gated
   object, granted to `author` (Pillar 01).
2. `parents = heads(view)`;
   `lamport = parents.length ? 1 + max(parents.lamport) : 0`.
3. Build `Op { path, parents, lamport, author: author.did, payload: ref }`,
   compute `id = blake3(canonical(...))`, sign it.
4. Store the op; set `view`'s heads to `[op.id]`. History captured as a side
   effect (P5) — no stage/commit ritual.

`remove` is identical with `payload: null`.

### 6.2 Convergence and ordering

- `ops()` returns all known ops sorted by `(lamport, id)` — a deterministic
  total order independent of arrival/ingest order.
- Two ops are **concurrent** iff neither is in the other's ancestor-closure
  (computed over `parents`).
- `append(op)` is the peer-ingest path: verify, link into the DAG, idempotent on
  id. The order-independence property (acceptance 4) is what makes this a CRDT:
  any permutation of `append` calls yields an identical `materialize()`.

### 6.3 Named views — branches dissolve (P6)

A view is `{ name, heads: string[] }` held in the `OpLog`, not on any op.

- `fork(name, fromView)` copies only the _head-set_ (a few ids) — zero op
  copying. The two views then diverge as each is `write`-extended.
- "Merging" two views is not a special event: it is an ordinary op whose
  `parents` union both views' heads. Continuous convergence is the normal
  condition; the rare event is a genuine same-path conflict, surfaced not
  blocked.
- `materialize(view)` walks the ancestor-closure of `view`'s heads in
  `(lamport, id)` order and applies LWW per path. A `null` payload tombstones
  the path (removed from the map). The winner's `{ ref, op }` is returned so
  callers can trace provenance and cross-reference `conflicts()` without
  re-deriving.

### 6.4 The metadata-gating seam — Pillar 02's other half

For `write(…, { embargoUntil: T })`:

1. The payload object is stored capability-gated as usual (granted to `author`/
   maintainers only).
2. The op's **metadata** (`path`, `parents`, `lamport`, `author`, `payload` ref,
   `sig`) is serialized and stored as a **second** capability-gated object
   `metaRef` (granted to maintainers), and
   `store.scheduleReveal(metaRef, T, author)` schedules its release.
3. `publicView(opId)` returns
   `{ kind: 'embargoed', id, ordering_token, sealed_meta: metaRef }`. The
   `ordering_token` is an opaque, capability-gated handle sufficient for peers
   to _place_ the op in sequence, naming neither path nor timing.
4. At T, `reveal(opId)` fires `store.reveal(metaRef)` — the membrane key-release
   — and the op's real metadata becomes readable; the op "lands" publicly and
   `materialize()` (public) now places it.

The reuse of the P02 membrane **verbatim** is the strongest evidence the pillar
decomposition was cut at the right joint: P02 gates content for grantees; here
the same mechanism gates an op's metadata against the _absence_ of a cap on the
public mirror — no special-casing.

#### 6.4.1 Threat model (what embargo protects, and what still leaks)

**Protects:** coordinated disclosure — an attacker must not be able to derive
the vulnerability or its fix before T. This is the brief's P3 ("public-on-merge
manufactures zero-days"): today an agent reads the patch the instant it lands
and derives the exploit before the fix ships. Under embargo, the patch's bytes
(payload) **and** its locating metadata (path/symbol, author, timing, intent)
are sealed until T.

**Does not hide (stated, not assumed):** the embargoed op's `id` and `parent`
ids are public, and ops that land on top reference its id, so an observer learns
that **an op exists at a given DAG position and that N ops have landed on top of
it** — causal topology and op cadence leak. Path, payload, author, and timing
stay sealed. Under the coordinated-disclosure threat model this is acceptable:
that _activity is happening_ is visible; _what and where_ is not, which is the
property that defeats the diff-to-zero-day pipeline. A threat model that must
also hide the existence/shape of in-flight work is out of scope and would need
cover traffic or a different transport — ledgered, not claimed.

#### 6.4.2 Reveal is a materialization-changing event

A revealed op is not merely "now readable" — it **changes the projection**.
Before T, the public `materialize()` (no `as`) cannot place the op (it has no
public path), so the op is invisible to the path map. At T, it acquires its path
and may **retroactively become the LWW winner** for that path. Acceptance test
10 pins this transition explicitly, separately from the key-release/readability
check.

## 7. Data model

### 7.1 The `Op` record

```
Op {
  id:       blake3(canonical)                   // address; mergeable WITHOUT decryption
  path:     "src/auth.rs"                        // addressable unit; → symbol-id at P08
  parents:  [opId, ...]                          // the DAG; root has []
  lamport:  42                                   // root = 0; else 1 + max(parents.lamport)
  author:   did:key:z6Mk...                      // same identity that holds caps (P01)
  payload:  Ref | null                           // capability-gated object; null = delete tombstone
  sig:      ed25519(author, canonical(...))      // over path, parents, lamport, author, payload
}
```

`canonical(op)` is a single deterministic encoding of
`(path, parents, lamport, author, payload)` used for **both**
`id = blake3(canonical)` and the signed bytes, so the id and signature bind the
same tuple and no field is malleable. `parents` is encoded in a fixed (sorted)
order so the id is stable regardless of head enumeration order. `payload`
encodes as the `Ref` (its `id` + `plaintext_id`) or an explicit null sentinel.

### 7.2 State transitions

- **`write(view, path, bytes, author)`** → `store.put` → append
  `Op{payload: ref}` → advance `view.heads = [op.id]`.
- **`remove(view, path, author)`** → append `Op{payload: null}` → advance heads.
- **`append(peerOp)`** → verify → insert into DAG (idempotent on id); views are
  unchanged (peer ops land in the graph; a view only moves when it is written or
  explicitly re-pointed).
- **`fork(name, from)`** → `views[name] = [...views[from]]` (head-set copy
  only).
- **embargoed `write`** → as above, plus seal metadata to `metaRef` +
  `store.scheduleReveal(metaRef, T)`; `publicView` shows the opaque token.
- **`reveal(opId, now≥T)`** → `store.reveal(metaRef)` → metadata public → op
  placeable by public `materialize()`.

### 7.3 Materialization (the projection)

```
materialize(view, as?) =
  heads        = view ? views[view] : globalFrontier()   // no view → DAG sinks
  reachable    = ancestor-closure(heads) over parents
  visible      = reachable filtered to ops whose metadata is readable
                 (open ops always; embargoed ops only if `as` can unseal metaRef)
  ordered      = visible sorted by (lamport, id)
  acc: Map<path, {ref, op}> = {}
  for op in ordered:
    if op.payload == null: acc.delete(op.path)     // tombstone
    else:                  acc.set(op.path, {ref: op.payload, op})   // LWW
  return acc
```

Decryption never happens here — the map holds `Ref`s; content is a later
`store.get(ref, reader)`. This makes the no-plaintext property a consequence of
the return type, not a runtime check.

## 8. Crypto choices

Unchanged from Pillars 01–02 (§8): `@noble/hashes/blake3` for the op id and for
content addressing, ed25519 (via `@thaddeus.run/identity`) for op signatures,
the store's `libsodium` envelope encryption for payloads and sealed metadata. No
new primitives, no hand-rolled crypto, no native deps. `OpLog` calls
`await ready()` transitively via the identity/store packages; the package
documents that `ready()` must be awaited before use (consistent with Tier 0).

## 9. The demo — operation log (CLI)

`examples/oplog/` (sibling to `offboarding/`, `disclosure/`), deterministic via
an injected clock. Two acts:

**Act 1 — convergence and views (P5/P6).**

1. `write('main', 'a.ts', …)` and `write('main', 'b.ts', …)` — print the two
   signed ops, their lamport/parents, and `materialize('main')`.
2. `fork('feature', 'main')` — print that only the head-set was copied (zero op
   copy). `write('feature', 'a.ts', …)` — show the two views diverge with no
   duplicated ops.
3. **Order independence:** build a second `OpLog`, `append` the same ops in
   reversed order, and assert byte-identical `materialize()` — the load-bearing
   CRDT property.
4. Create a same-path conflict across two views; print `conflicts()` and the
   deterministic LWW winner.

**Act 2 — embargoed op (P02's other half, P03 seam).**

5. `write('main', 'src/auth.ts', fixBytes, maintainer, { embargoUntil: T })`.
6. Print `publicView(op.id)` → only `{ id, ordering_token, sealed_meta }`; show
   that public `materialize('main')` does **not** place `src/auth.ts`.
7. Advance the injected clock to T; `reveal(op.id, T)`; show public
   `materialize('main')` now places `src/auth.ts` and reads its content.
8. Print the acceptance facts.

## 10. Acceptance criteria (measurable; written test-first)

1. **Signed op** — `write` produces an `Op` whose `verify` passes; mutating any
   field (path, parents, lamport, author, payload) makes `verify` fail.
2. **Lamport + DAG** — a child op's `lamport = 1 + max(parents.lamport)`;
   `ops()` is sorted deterministically by `(lamport, id)`.
3. **Materialize from cleartext** — `materialize()` resolves `path → {ref, op}`
   using metadata only (no decryption); content reads back via
   `store.get(ref, grantee)`.
4. **CRDT determinism** — appending the same op set in different orders into two
   `OpLog`s yields identical `materialize()` output. _(The load-bearing test.)_
5. **Conflict surfaced** — two concurrent ops on the same path appear in
   `conflicts()`; `materialize()` picks the `(lamport, id)` winner
   deterministically.
6. **Views are zero-copy** — `fork` copies only the head-set; advancing one view
   does not change the other's `materialize()`; a "merge" op with both heads as
   `parents` converges them.
7. **Embargo seam** — `publicView` of an embargoed op exposes only
   `{ id, ordering_token, sealed_meta }` (no path/author/timing); before T the
   sealed metadata is unreadable and public `materialize()` does not place the
   op.
8. **Reveal fires** — at/after T, `reveal()` releases the metadata via the
   membrane and the op's metadata becomes readable.
9. **Root lamport** — an op with `parents = []` has `lamport = 0` (max-of-empty
   edge defined and tested).
10. **Reveal → materialization transition** — pre-reveal, public `materialize()`
    places the embargoed op at _no_ path; post-reveal, it deterministically
    acquires its path and can become the LWW winner. _(Distinct from 8's
    readability check.)_
11. **View-agnostic op** — one op participates identically in two views whose
    head-sets both reach it; there is no `view` field influencing the
    projection. _(The test that would have caught the stamped-view
    contradiction.)_
12. **Delete tombstone** — `remove` writes a `payload: null` op; `materialize()`
    drops the path.
13. **Composition (north-star)** — the P03 `test.todo` becomes a real assertion:
    a write is recorded as a signed `Op` in the log, and `materialize` shows the
    edit at its path.

## 11. Honest limitations (stated, not hidden)

- **3-way content merge deferred — and load-bearing.** Concurrent same-path
  edits are LWW-resolved and surfaced by `conflicts()`, but the loser's bytes
  are dropped at the materialized layer, not merged. Real content merge needs
  the text-CRDT work the brief defers to Part VI.
- **Convergence over sealed metadata.** During embargo, peers see only the
  opaque ordering token, so they can order but cannot do content-aware
  (path-level) placement of the embargoed op. This is the brief's Part VI
  frontier — fast convergence wants cleartext metadata, a true embargo wants it
  sealed. The seam is built; the convergence-under-seal is not solved.
- **Embargo leaks topology/cadence.** Existence, DAG position, and op cadence of
  an embargoed op are public (§6.4.1). Acceptable under the coordinated-
  disclosure threat model; out of scope for a threat model that must hide
  in-flight activity at all.
- **Rename/move not represented.** A rename is two unlinked path-ops here, which
  loses the move. First-class move is Pillar 08 (`move-definition`).
- **File-unit granularity.** LWW keys on `path`; finer (symbol) granularity is
  Pillar 08. Named staging, not a bug.
- **Lamport, not vector, clocks.** Deterministic total order + DAG-based
  concurrency detection; no precise cross-author concurrency vectors.
- **In-memory, single process.** No persistence, no network transport, no
  multi-process concurrency. Inherits Tier 0's limits (no recovery; revocation
  cannot un-read).
- **Reveal is store-honest, not trustless.** Inherits the P02 membrane's honesty
  assumption — a dishonest store could promote a metadata reveal early.

## 12. Seeded/updated docs

- **`CHANGELOG.md`** — under `[Unreleased] → Added`: the P03 operation log
  (signed `Op` records, convergence, named views, delete tombstones, the embargo
  metadata seam). In the **Deferred ledger**: graduate the "P03 operation log"
  scope-cut line; move "Metadata-gating for embargoed changes (P02)" from
  blocked-research to **seam delivered, convergence-under-seal still open**; add
  new ledger entries for **repository-as-slice (→P05)**, **rename/move (→P08)**,
  **symbol- level addressing (→P08)**, **3-way content merge (Part VI)**, and
  **vector clocks**.
- **`ARCHITECTURE.md`** — flip the `Op (operation log entry)` row from
  _(planned)_ to its package `@thaddeus.run/log`; flip the **Pillar 03** row
  `planned → built` (Resolves P5 P6 P12); the membrane row's deferred
  metadata-gating note becomes "seam built".
- **North-star** —
  `test.todo('P03: the edit is recorded as a signed Op in the operation log')`
  becomes a real assertion; P04 stays `test.todo`.

## 13. Open items / next primitives

- **Pillar 04 (provenance)** is the natural next primitive: it attaches the
  signed _why_ (intent, prompt-ref, reasoning) to an `Op.id`, completing P12.
  P03 deliberately leaves `Op` without an intent field for P04 to add alongside,
  not inside, the record.
- **Convergence over sealed metadata** returns as real research once a network
  transport and a second peer exist (P06 platform).
- **Symbol-level ops** (`Op.path` → symbol-id; `rename-symbol`,
  `change-signature`) arrive with Pillar 08's semantic graph.
- Confirm whether `Conflict`/view types graduate into a shared types package
  once a second consumer (P06 platform, P10 review) appears.
