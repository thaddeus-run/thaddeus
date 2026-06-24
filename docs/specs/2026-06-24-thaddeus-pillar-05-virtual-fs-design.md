# Thaddeus — Pillar 05: a virtual, API-first filesystem (design)

**Date:** 2026-06-24 **Status:** Design — pending user review, then
implementation plan **Product:** Strata (working name) · **Company/monorepo:**
Thaddeus (`@thaddeus.run/*`) **Source of truth (vision):**
`the-new-age-of-source-control.html`, Pillar 05 **Builds on:**
`docs/specs/2026-06-23-thaddeus-pillar-03-operation-log-design.md`,
`docs/specs/2026-06-23-thaddeus-pillar-02-membrane-design.md`,
`docs/specs/2026-06-22-thaddeus-pillar-01-encrypted-capability-store-design.md`

---

## 1. Context — why this primitive, why now

Strata is an 11-pillar replacement for Git+GitHub, built **one primitive at a
time** (Pillar 01 spec §4). Tier 0 shipped (`@thaddeus.run/identity`,
`@thaddeus.run/store`). Tier 1 — the spine — shipped: the **membrane** (P02,
timed reveal) and the **operation log** (P03, signed `Op` records with
continuous convergence). Tier 2 began with **provenance** (P04, the signed
"why"), which took the seeded north-star to **5 pass / 0 todo**.

**Pillar 05 — the virtual filesystem** is the next Tier-2 primitive, chosen now
because:

- **The substrate has truth but no hands.** P03 already projects the op-log to a
  `path → Ref` tree (`OpLog.materialize`) and gives every actor a zero-copy
  branch (`OpLog.fork` — "so every agent can have its own view for free"). What
  is missing is the _editing surface_: the thing an agent or human reads, edits
  in isolation, and lands — without checking files out to a real disk. P05 is
  that surface, and it is the pillar that makes the substrate _usable_ rather
  than only _correct_.
- **It consumes Tier 0/1 across their public APIs only**, and adds almost no new
  machinery (§4.1). The pinned working copy, the worktree-killer, falls out of
  two facts P03 already established: views are zero-copy head-sets, and
  `append()` (peer ingest) **never moves a view**. A workspace bound to its own
  forked view is therefore isolated from concurrent peers _by construction_.
- **It is the right size for one release.** No research frontier sits on its
  critical path. The genuinely hard problems it touches — 3-way content merge,
  landing/merge policy — are already deferred by P03 and owned by later pillars,
  so P05 inherits those limits rather than re-opening them (§11).

It resolves the brief's substrate complaints around the real-filesystem
assumption and the cost of working copies (`ARCHITECTURE.md` lists P05 against
the P6/P7/P8/P11 problem cluster): a working copy becomes an O(1) in-memory
view, not a multi-gigabyte checkout, and edits enter the system through an API,
not a CLI dragging bytes across a disk.

## 2. Governing principle — _stable seams, playground interiors_

Unchanged from Pillars 01–04 (§2): **rigid** = the new package's public API
(`Workspace` and its method shapes), and the north-star flow; **loose** =
everything behind those seams. Consequences here: in-memory only, single
process, no persistence, no network transport, no production hardening, no
index. Tests pin the contract and the acceptance facts (§10), not the throwaway
internals.

The genuinely rigid, expensive-to-reverse calls in this release are: **(a)** the
workspace binds to a _private forked view_ rather than editing a shared view in
place (§4, decision 2) — this is what gives isolation and a pinned base; and
**(b)** `commit` is a _non-blocking append_ that never rebases or rejects (§4,
decision 4) — convergence stays the log's job. Both are decided here on purpose
rather than left to emerge from code.

### 2.1 What the brief asks for, and what is buildable now

The brief's Pillar 05 makes three claims. This release takes a clear position on
each:

1. **A virtual, in-memory, API-first filesystem — no real OS or disk**
   (buildable now). A `Workspace` exposes `read`/`list`/`grep`/`write`/`rm` over
   the op-log projection; nothing touches a real filesystem.
2. **Working copies are cheap copy-on-write views** (buildable now). A workspace
   _is_ a forked view (zero-copy head-set, via `OpLog.fork`) plus a small
   in-memory edit overlay. `fork()` branches a workspace in O(head-set +
   overlay), never copying the tree.
3. **The interface is API (read, write, list, grep), not a CLI against files**
   (buildable now). The surface is the `Workspace` class; the CLI demo
   (§9) only _renders_ it.

What the brief gestures at but this release does **not** build: landing/merging
a working copy onto a shared view, and 3-way content merge (§5, §11). Those are
P03-deferred (content merge) and P06/P10 (landing policy).

## 3. The release's job

Introduce `@thaddeus.run/fs`: the `Workspace` class — a copy-on-write working
copy over a P03 op-log. Deliverables:

- The **`Workspace`** class (§6): `open` (factory), `read`, `list`, `grep`,
  `write`, `rm`, `status`, `commit`, `fork`.
- **Pinned base via a private forked view**: `open` calls
  `log.fork(privateView, source)`; reads project from
  `log.materialize(privateView, reader)`; peer ops never shift it (§4.2, §6.1).
- **A copy-on-write edit overlay**: `write`/`rm` stage into an in-memory
  `Map<path, Staged>`; reads layer the overlay over the materialized base
  (§6.2).
- **`commit`**: fold the overlay into signed ops via `log.write` / `log.remove`
  on the private view, return the ops, clear the overlay (§6.3).
- **Decryption-bounded `grep`** and `read`: bounded by what the workspace
  `reader` identity can decrypt; `AccessDenied`/absent ⇒ skip/`null`, never
  throw (§6.4).
- A **workspace CLI demo** (`examples/workspace/`) enacting open→grep→commit, a
  `fork` into two divergent COW workspaces, and a decryption-bounded grep (§9).
- The north-star integration test's **first step rerouted** to originate in a
  `Workspace`; `ARCHITECTURE.md` Pillar 05 row flipped `planned → built`; the
  flow stays **5 pass / 0 todo** (§12).

Not the job: landing/merge onto a shared view, 3-way content merge, `mv`/`mkdir`,
`sync()` of the pinned base, a search index, persistence, network/federation
(§5, §11).

## 4. Decisions taken (brainstorm outcomes)

1. **Home — a new package `@thaddeus.run/fs`** (primary export `Workspace`).
   Neutral, product-agnostic name per the scope convention (AGENTS.md "Naming");
   matches the brief's "virtual filesystem" and the `ARCHITECTURE.md` Pillar 05
   label. It consumes `@thaddeus.run/log` (the `OpLog` and `Op` type),
   `@thaddeus.run/store` (`Store`, `Ref`, `AccessDenied`), and
   `@thaddeus.run/identity` across their public APIs only — no internals cross
   the seam.

2. **A workspace binds to its own private forked view.** On `open`, the
   workspace calls `log.fork(privateView, source)` — a zero-copy branch at the
   source view's current heads. All reads project that private view; all commits
   advance only that private view. This is the rigid call: it gives **isolation
   between workspaces** (two workspaces over `main` never interfere) and a
   **pinned base** (below) for free, reusing the exact machinery P03 built for
   "every agent gets a view for free." The alternative — editing a shared view
   in place — was rejected: it loses isolation the moment two actors commit.

3. **Pinned base, achieved without snapshotting.** P03's `append()` (peer
   ingest) explicitly **does not move any view** — "peer ops land in the graph; a
   view advances only on write/re-point." Therefore a workspace's private view
   advances _only_ by that workspace's own commits; concurrent peer ops cannot
   shift its materialized base. No cached snapshot is needed:
   `materialize(privateView, reader)` is already stable against peers. Advancing
   the base to absorb new source-view heads is an explicit `sync()` — minimal
   and **deferred** (§5).

4. **`commit` is a non-blocking append; convergence is the log's job.** `commit`
   creates ops whose `parents` are the workspace's (pinned) heads — an honest
   record of what the author saw — signs them via `log.write`/`log.remove`, and
   appends. It never detects-and-blocks, never rebases, never rejects. If a peer
   edited the same path concurrently, that surfaces as a P03 `conflict()` _at the
   point a shared view is re-pointed to include both frontiers_ (landing), not at
   commit time. P05 adds no merge logic; it inherits P03's LWW + `conflicts()`
   and P03's deferral of 3-way content merge. This kills the "push rejected, pull
   first" friction by construction.

5. **Edits stage in a COW overlay; signing is off the edit path.** `write`/`rm`
   mutate only an in-memory overlay and are synchronous and cheap (no crypto, no
   store, no log). Signing and `store.put` happen once, in `commit`. This makes a
   workspace a true _working copy_ (a series of cheap edits, landed as a coherent
   change) rather than a live wire to the log, and gives a natural unit for a
   future P04 "why" (one provenance per commit).

6. **`read`/`grep` are decryption-bounded and fail soft.** The workspace carries
   a `reader` identity. `read` returns the overlay bytes if staged, else
   `store.get(ref, reader)`; on `AccessDenied` or an absent path it returns
   `null` (never throws). `grep` scans the overlay (as plaintext) plus every base
   object the reader can decrypt, skipping any it cannot. This is honest to the
   capability model — you can only search what you are allowed to read — and an
   embargoed (pre-reveal) object simply does not match until its key releases
   (P02), with no special-casing in P05.

### 4.1 Why this is almost no new machinery (honest claim)

The worktree-killer is mostly _composition_ of primitives P03 already shipped:

| P05 capability               | Mechanism (existing)                                          |
| ---------------------------- | ------------------------------------------------------------- |
| cheap working copy / branch  | `OpLog.fork(privateView, source)` — zero-copy head-set        |
| pinned base                  | `append()` never moves a view (P03 §convergence)              |
| read projection (path→bytes) | `OpLog.materialize(view, reader)` + `store.get`               |
| commit edits → history       | `OpLog.write` / `OpLog.remove` on the private view            |
| embargo-aware reads          | `materialize`'s `as` gating + store reveal (P02)              |

P05's genuinely new code is small: the edit overlay, the read/grep layering over
materialize, and the commit fold. That is the point — the substrate was designed
so the filesystem is a thin, honest surface, not a parallel source of truth.

### 4.2 `read` resolution order (the one subtle rule)

A path resolves in this order: **(1)** if the overlay has a tombstone for the
path ⇒ `null`; **(2)** if the overlay has staged bytes ⇒ those bytes; **(3)**
else the base — `store.get(materialize(privateView, reader).get(path).ref,
reader)`, or `null` if the path is absent or the reader cannot decrypt it.
`list`/`grep`/`status` use the same layering so a staged write is visible
everywhere before commit, and a staged `rm` hides the base path everywhere.

## 5. Scope

**In (this release):**

- Package `@thaddeus.run/fs` with the `Workspace` class and its `open` factory.
- `read`, `list`, `grep` (decryption-bounded, overlay-layered).
- `write`, `rm` (COW overlay staging), `status` (staged vs base).
- `commit` (fold overlay → signed ops via `log.write`/`log.remove`, return
  `Op[]`, clear overlay), `fork` (branch the workspace: `log.fork` + shallow
  overlay copy).
- `examples/workspace/` demo; north-star first-step reroute; `ARCHITECTURE.md` +
  `CHANGELOG.md`.

**Out (deferred, named so scope stays honest):**

- **Landing / merge onto a shared view** (re-pointing a target view to include a
  workspace's heads, and the conflict resolution that implies) → P06 platform /
  P10 review; the ops exist in the log after `commit`, but P05 does not define
  the policy by which they become part of `main`.
- **3-way content merge** → already deferred by P03; P05 inherits LWW +
  `conflicts()`.
- **`sync()`** to advance a workspace's pinned base to newer source-view heads →
  deferred; a workspace is opened, edited, committed, discarded.
- **`mv` / rename as a first-class op** → path-level move is `rm(old)` +
  `write(new, read(old))`; _semantic_ rename is Pillar 08 (symbol-level ops).
- **`mkdir` / empty directories** → paths are keys; directories are implied by
  prefixes (matches P03). No empty-dir concept.
- **A search index** → `grep` is a linear scan over the readable view + overlay.
- **Workspace-view garbage collection** → ephemeral private views accumulate in
  the log's view map; cleanup is a spike non-goal.
- Persistence, network transport, federation, multi-process concurrency.

## 6. The seam (public API delta)

New package. No changes to `@thaddeus.run/identity`, `@thaddeus.run/store`, or
`@thaddeus.run/log` — `fs` consumes their existing public surfaces.

### `@thaddeus.run/fs`

```ts
import type { Identity } from '@thaddeus.run/identity';
import type { OpLog, Op } from '@thaddeus.run/log';
import type { Store } from '@thaddeus.run/store';

// A change staged in the copy-on-write overlay, not yet committed to the log.
type Staged =
  | { readonly kind: 'write'; readonly bytes: Uint8Array }
  | { readonly kind: 'tombstone' };

// What `status()` reports for a path with an uncommitted edit.
interface Change {
  readonly path: string;
  readonly change: 'write' | 'rm';
}

// A grep hit. `path` + 1-based `line` + the matching line `text`.
interface Match {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

// A copy-on-write working copy over a P03 op-log. Reads project a private,
// pinned view of the log; edits stage in an in-memory overlay; commit folds the
// overlay into signed ops on that private view. Spike — in-memory, single
// process, not durable, not concurrency-safe.
class Workspace {
  // Open a workspace over `source`. Forks a private zero-copy view at source's
  // current heads (pinned: peer ops never shift it). `reader` bounds what reads
  // and grep can decrypt. `name`, if given, is the private view's name; else a
  // unique name is derived.
  static open(
    log: OpLog,
    store: Store,
    opts: { source: string; reader: Identity; name?: string }
  ): Workspace;

  // Decrypted bytes at `path`, or null if absent, staged-removed, or the reader
  // cannot decrypt it. Never throws on AccessDenied.
  read(path: string): Promise<Uint8Array | null>;

  // Paths visible in the workspace (base ∪ staged writes, minus staged
  // tombstones), under an optional prefix, in deterministic (sorted) order.
  list(prefix?: string): Promise<readonly string[]>;

  // Lines matching `pattern` across every readable path (base the reader can
  // decrypt + staged writes as plaintext). Undecryptable base objects are
  // silently skipped. Deterministic order (by path, then line).
  grep(pattern: string | RegExp): Promise<readonly Match[]>;

  // Stage a write into the overlay. Synchronous, isolated, unsigned.
  write(path: string, bytes: Uint8Array): void;

  // Stage a tombstone into the overlay. read/list/grep treat the path as absent.
  rm(path: string): void;

  // Uncommitted edits vs the base, deterministic order. Empty ⇒ nothing staged.
  status(): readonly Change[];

  // Fold the overlay into signed ops on the private view: each staged write →
  // log.write, each tombstone → log.remove (in deterministic path order).
  // Returns the ops created, then clears the overlay. A no-op overlay returns [].
  commit(author: Identity): Promise<readonly Op[]>;

  // Branch this workspace: a fresh private view forked at this workspace's
  // current heads + a shallow copy of the overlay (in-flight edits carry over).
  // O(head-set + overlay) — never copies the tree.
  fork(opts?: { reader?: Identity; name?: string }): Workspace;
}

export { Workspace };
export type { Change, Match };
```

### 6.1 Opening — the pinned, forked view

`Workspace.open(log, store, { source, reader, name })`:

1. Derive `privateView = name ?? uniqueName(source)` (a process-local counter
   keeps it unique; no real filesystem, no global registry).
2. `log.fork(privateView, source)` — zero-copy branch at `source`'s current
   heads. (If `source` has no heads, the fork is an empty head-set; the workspace
   starts empty.)
3. Hold `log`, `store`, `reader`, `privateView`, and an empty
   `overlay: Map<string, Staged>`.

Because peer `append()` never moves `privateView`, the base the workspace reads
is fixed until this workspace commits. That is the pinned base; no snapshot copy.

### 6.2 Editing — the copy-on-write overlay

`write(path, bytes)` sets `overlay[path] = { kind: 'write', bytes }`.
`rm(path)` sets `overlay[path] = { kind: 'tombstone' }`. Both overwrite any
prior staged entry for the path. Nothing is signed, stored, or logged. The
overlay is the only mutable state a workspace owns; everything else is a
projection.

### 6.3 Committing — folding the overlay into history

`commit(author)`:

1. If the overlay is empty, return `[]`.
2. For each `(path, staged)` in deterministic path order:
   - `write` ⇒ `op = await log.write(privateView, path, staged.bytes, author)`.
   - `tombstone` ⇒ `op = await log.remove(privateView, path, author)`.
   - Each `log.write`/`log.remove` advances `privateView`'s heads, so a batch's
     ops chain correctly (the second op parents the first).
3. Clear the overlay. Return the ops in the order created.

`commit` is the only path that signs or touches the store. Its ops parent at the
workspace's pinned heads (decision 4), so concurrent peer edits remain genuinely
concurrent in the DAG — to be surfaced by P03 `conflicts()` if and when a shared
view is re-pointed to include them (landing — deferred, §5).

### 6.4 Reading under capabilities (no-leak, fail-soft)

`read`, `list`, and `grep` are bounded by the `reader` identity:

- `read` resolves per §4.2; a base lookup is `store.get(ref, reader)` wrapped to
  return `null` on `AccessDenied` (the store's denial error) or an absent path.
- `grep` decrypts each base object the reader holds a capability for and scans it
  line by line; objects that raise `AccessDenied` are skipped, not errored.
  Staged overlay writes are scanned directly as plaintext (they are already in
  hand). A staged tombstone removes the path from the scan set.

`list` is **not** decryption-bounded: P03 keeps paths (op metadata) cleartext and
gates only payloads, so `list` shows every base path that exists, including ones
whose _content_ the reader cannot decrypt. Existence is visible; content is not.
`read` of such a path returns `null` and `grep` skips it — so a reader can learn
a file exists without reading it, which is the intended capability boundary.

A pre-reveal embargoed object (P02) is a different case: its op is gated out of
`materialize` for a non-grantee, so the path is absent from `read`/`list`/`grep`
entirely until its key releases — capability semantics, not a P05 special case.

### 6.5 Forking — the cheap branch

`fork()` creates a new `Workspace` whose private view is
`log.fork(newPrivateView, this.privateView)` (a zero-copy branch at this
workspace's _current committed_ heads) and whose overlay is a shallow copy of
this workspace's overlay (`Staged` entries are immutable, so a shallow copy is
safe). In-flight staged edits therefore carry into the fork, but subsequent edits
and commits diverge. This is the headline copy-on-write working-copy story.

## 7. Data model

P05 introduces no persisted record type. Its only state is the in-memory overlay:

```
Workspace (in-memory) {
  log:         OpLog                 // the source of truth (P03)
  store:       Store                 // content (P01); read via store.get
  reader:      Identity              // bounds read/grep decryption
  privateView: string                // a forked view name in the log
  overlay:     Map<path, Staged>     // uncommitted edits (the only mutable state)
}
Staged = { kind: 'write', bytes } | { kind: 'tombstone' }
```

The durable artifacts of a workspace are entirely P03 `Op`s (produced by
`commit`) and P01 store objects (produced by `log.write` → `store.put`). There is
nothing new on the wire and nothing new to sign.

## 8. Crypto choices

**None new.** P05 performs no encryption, signing, or hashing of its own. It
composes:

- `store.get` / `store.put` (P01) for content decryption/encryption — through
  `log.write` on commit and directly on read.
- `log.write` / `log.remove` (P03) for signing ops — the author identity signs;
  P05 never holds signing logic.
- `materialize`'s capability gating (P01/P02) for embargo-aware reads.

`Workspace` methods that touch identity/store/log `await ready()` transitively;
the package documents that `ready()` must be awaited before use (consistent with
Tier 0/1).

## 9. The demo — the virtual filesystem / working copy (CLI)

`examples/workspace/` (sibling to `oplog/`, `provenance/`, `offboarding/`,
`disclosure/`), deterministic via injected identities/seeds. Three acts:

**Act 1 — a working copy with no disk.**

1. Seed an op-log + store; `Workspace.open(log, store, { source: 'main', reader })`.
2. `ws.write('src/auth.rs', bytes)`; show `ws.list()` and a `ws.grep('refresh')`
   hit on the _staged, uncommitted_ content; `ws.status()` shows one `write`.
3. `await ws.commit(author)`; show `status()` now empty and `log.materialize`
   reflects the op — the edit entered the log through the filesystem.

**Act 2 — cheap copy-on-write branches.**

4. `const b = ws.fork()`; edit `a` in `ws` and `b` divergently; show each
   workspace reads its own content and neither sees the other's edit — isolation
   with no checkout, no copy of the tree.

**Act 3 — grep stops at the capability boundary.**

5. Add an object the `reader` cannot decrypt (ungranted, or pre-reveal
   embargoed); show `grep` returns hits only from readable paths and silently
   skips the rest; `read` of the gated path returns `null`, not an error.
6. Print the acceptance facts.

## 10. Acceptance criteria (measurable; written test-first)

1. **Edit with no disk** — `write` then `read` returns the staged bytes; nothing
   touches a real filesystem (the suite uses only `MemoryStore` + `OpLog`).
2. **Staged before commit** — after `write`, the path appears in `list`/`grep`
   and `status` shows it, but `log.materialize(source)` does **not** contain it.
3. **Commit folds overlay → ops** — `commit` returns one op per staged change,
   clears the overlay (`status()` empty), and the ops are in the log; a no-op
   overlay returns `[]`.
4. **Commit parents = pinned heads** — an op produced by `commit` has `parents`
   equal to the workspace's heads at the time of commit (the forked base for the
   first commit), i.e. it does not parent on concurrent peer ops. _(Pins
   decision 4.)_
5. **Pinned base** — a peer `log.append` (or a `log.write` to `source`) after
   `open` does **not** change what the workspace `read`/`list` returns. _(Pins
   decision 3.)_
6. **COW isolation across forks** — `fork`, then divergent edits in parent and
   child; each reads its own content; neither sees the other's staged or
   committed edit. _(Pins decision 2 / §6.5.)_
7. **Fork carries in-flight edits** — a staged (uncommitted) write present at
   `fork()` is visible in the child immediately after forking.
8. **`rm` tombstones** — `rm(path)` makes `read` return `null` and removes the
   path from `list`/`grep`; `commit` emits a `payload:null` remove op; after
   commit `materialize(privateView)` lacks the path.
9. **Decryption-bounded grep** — an object the reader cannot decrypt
   (ungranted/embargoed) yields no `grep` hits and `read` returns `null` (no
   throw); a staged overlay write matches `grep` as plaintext.
10. **Read fails soft** — `read` of a denied or absent path returns `null` rather
    than throwing `AccessDenied`.
11. **Deterministic order** — `list`, `grep`, and `status` return results in a
    stable order independent of insertion/edit order.
12. **Composition (north-star)** — the seeded one-edit flow's first step
    originates in a `Workspace`: `ws.write(path, bytes)` + `await ws.commit(author)`
    yields the `Op` the rest of the flow (provenance, reveal, mirror) consumes;
    the flow stays **5 pass / 0 todo**.

## 11. Honest limitations (stated, not hidden)

- **No landing/merge.** `commit` puts ops in the log on a private view; P05 does
  **not** define how those ops become part of a shared view like `main`
  (re-pointing + conflict resolution). That is P06/P10. A workspace's work is
  visible to others only once a later pillar lands it.
- **No 3-way content merge.** Inherited from P03: concurrent same-path edits
  resolve by LWW and surface via `conflicts()`; P05 adds no content merge.
- **Pinned base does not advance.** Without `sync()` (deferred), a long-lived
  workspace drifts from `source`; the intended lifecycle this release is
  open → edit → commit → discard.
- **No `mv`/`mkdir`.** Path-level move is `rm` + `write`; semantic rename is P08.
  Directories are implied by path prefixes.
- **`grep` is a linear scan, no index**, and decrypts every readable object on
  each call — fine for a spike, not for scale.
- **Workspace views leak.** Each `open`/`fork` adds a private view to the log's
  view map; there is no GC. A spike non-goal.
- **In-memory, single process.** No persistence, no network transport, no
  multi-process concurrency. Inherits Tier 0/1 spike limits.

## 12. Seeded/updated docs

- **`CHANGELOG.md`** — under `[Unreleased] → Added`: the P05 virtual filesystem
  (`@thaddeus.run/fs` `Workspace`: COW working copy over the op-log, pinned
  forked-view base, overlay staging, `commit` fold, `fork`, decryption-bounded
  `read`/`grep`). In the **Deferred ledger**: add **landing/merge onto a shared
  view (→P06/P10)**, **`sync()` of the pinned base**, **`mv`/rename (→P08)**,
  **workspace-view GC**, and **grep index**.
- **`ARCHITECTURE.md`** — flip the **Pillar 05** row `planned → built` (package
  `@thaddeus.run/fs`); add an `fs` consumer note to the `Op` primitive row
  ("Reused by … P05 virtual FS"), since the workspace produces and reads ops.
- **North-star** — reroute the seeded edit's first step to originate in a
  `Workspace` (`ws.write` + `ws.commit`) producing the `Op` the downstream
  assertions already consume. The flow stays **5 pass / 0 todo**.

## 13. Open items / next primitives

- **Pillar 06 (platform)** is the natural next primitive: the API-first remote
  that serves views and ops at throughput, and the home where **landing/merge**
  (deferred here) gets its policy. P05's `commit` produces the ops a platform
  would land.
- **Pillar 08 (semantic graph)** turns `path`-addressed ops into symbol-addressed
  ones; the `Workspace` surface (`read`/`write` by path) is the projection P08
  renders text from. First-class `mv`/rename arrives there.
- Confirm whether `Workspace` grows a `sync()` and a landing helper once P06
  exists, or whether those live entirely in the platform layer.
