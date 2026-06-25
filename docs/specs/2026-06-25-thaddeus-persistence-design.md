# Thaddeus — Persistence: durable Store + OpLog (design)

**Date:** 2026-06-25 **Status:** Design — pending user review, then
implementation plan **Product:** Strata (working name) · **Company/monorepo:**
Thaddeus (`@thaddeus.run/*`) **Source of truth (vision):**
`the-new-age-of-source-control.html`, Pillar 06 ("API-first remote", the
code.store "in-memory writes, cold storage" model) **Builds on:**
`docs/specs/2026-06-22-thaddeus-pillar-01-encrypted-capability-store-design.md`
(the `Store`),
`docs/specs/2026-06-23-thaddeus-pillar-03-operation-log-design.md` (the
`OpLog`), `docs/specs/2026-06-24-thaddeus-pillar-06-platform-design.md` (the
`Platform`/`Repo`)

---

## 1. Context — why this, why now

Every package shipped so far is an **in-memory spike** — `CHANGELOG.md` states
it plainly: _"In-memory only, single process — not durable, not
concurrency-safe."_ The substrate is correct and proven, but **nothing survives
a process restart**, so it is not yet a source control you can run for real
repos. This is the load-bearing first step toward "runnable": **a repo that
survives a restart.**

Persistence is **not a pillar** — it is the production substrate the pillars
deliberately deferred. It is also the convergence point for several CHANGELOG
deferrals, which is why doing it now pays down debt rather than adding it:

- **"Persistence backends … beyond the in-memory spike"** (`CHANGELOG`,
  scope-cut) — the direct target.
- **"Record deep immutability (P03/P04) … addressed uniformly (freeze-on-store /
  immutable wire encoding at the store boundary)"** (research ledger) — the
  store boundary this introduces is exactly that uniform home.
- **"Throughput envelope at scale (P06)"** and **"Rust hot-path … behind the
  wire-format seam … when a _measured_ hot path demands it"** — persistence is
  where the per-op cost (envelope crypto, signed ops) is actually paid and can
  be measured against a latency budget.

It is grounded in the brief's own model: the source of truth is the **operation
log**, working copies are **materialized on touch** (Pillar 05), and the remote
is the code.store shape — _"in-memory writes, ephemeral branches, … cold
storage"_ (Part VI). Persistence realizes the **hot/cold split** that line
describes: the hot working set stays in memory (so synchronous reads are
unchanged), durably backed underneath.

## 2. Governing principle — _stable seams, playground interiors_

Unchanged from the pillars (§2): **rigid** = the new public seam (`Backend`) and
the additive optional-`backend` shape on `Store`/`OpLog`/`Platform`; **loose** =
the durable interiors. Consequences here: still **single process** (durable, not
concurrent), filesystem + in-memory backends only, no server, best-effort
crash-consistency.

The genuinely rigid, expensive-to-reverse calls in this release are: **(a)**
persistence is an **additive, optional `backend`** on the existing classes — no
backend means today's exact behavior, so the spike/test reference is untouched
(§4, decision 1); **(b)** the **hot-in-memory cache + write-through** model
keeps every **synchronous** read (`caps`/`materialize`/`heads`/…) untouched, so
no async change ripples through `log`/`platform` (§4, decision 2); and **(c)**
content-addressed records are **write-once blobs**, mutable pointers are
**last-write-wins** with atomic replace (§4, decision 3). All three are decided
here on purpose.

### 2.1 What "running quickly" needs, and what this release builds

A working, running source control needs three things the spike defers:
**persistence**, **a server/API**, and (optionally) **a Git gateway**. This
release builds **persistence only** — the load-bearing first of the three — and
explicitly leaves the server and gateway to follow (§5). The milestone is narrow
and concrete: **a repo (history + content + view pointers) survives a process
restart**, re-opened from a durable backend.

## 3. The release's job

Introduce durable persistence behind a pluggable `Backend`, hot-cached with
write-through. Deliverables:

- A **`Backend`** interface (in `@thaddeus.run/store`) — the durable KV seam —
  and a new package **`@thaddeus.run/persist`** with `MemoryBackend`,
  `FileBackend`, and a `scoped(backend, prefix)` helper.
- **`Store`** (additive): an optional `backend`, **write-through** on every
  mutation, a static async **`open(backend)`** that rebuilds the hot maps,
  **freeze-on-store**, and a record codec.
- **`OpLog`** (additive): an optional `backend`, write-through on
  `write`/`remove`/`view`/`fork`/`append`/`reveal`, a static async
  **`load(store, backend)`**, freeze-on-store.
- **`Platform`** (additive): async **`createDurable(name, backend)`** and
  **`openDurable(name, backend)`** that compose a scoped, backend-backed
  `Store`+`OpLog` into a `Repo`.
- A **persistence demo** (`examples/persist/`) and an **integration test**
  proving a seeded edit survives an `openDurable` reopen (suite 7 → 8).

Not the job: the server/network, a Git gateway, the signed-record logs
(provenance/reputation/agent) persistence, SQLite/S3 backends, op-log
compaction/GC, multi-process concurrency/locking, transactions/WAL, throughput
benchmarking (§5, §11).

## 4. Decisions taken (brainstorm outcomes)

1. **Additive optional `backend` on the existing classes — not parallel
   reimplementations.** `Store` and `OpLog` gain an optional `backend`; with
   none, behavior is byte-for-byte today's (the existing suites are the
   regression guard). This avoids duplicating the non-trivial
   grant/revoke/rewrap and commit/convergence logic. The `Backend` interface
   lives in `@thaddeus.run/store` (the lowest package) so `log` can import it
   without a new dependency direction; `@thaddeus.run/persist` supplies the
   implementations and depends only on `store` (for the type) + `node:fs`.

2. **Hot in-memory cache + write-through (the code.store hot/cold split).** The
   in-memory maps (`Store`: `#objects`/`#current`/`#caps`/`#pending`; `OpLog`:
   `#ops`/`#views`/`#embargo`) are the **hot cache**. Mutations — which are
   already `async` (`store.put`, `log.write`) — do the in-memory update and then
   `await backend.put(...)`. A static async **load/open** rebuilds the hot cache
   from the backend. **Every synchronous read stays synchronous** (it reads the
   hot cache), so `OpLog.materialize`, `store.caps`, etc. are unchanged and
   nothing above them goes async. This is the spec's load-bearing call: it makes
   persistence a swap behind the existing interfaces, not a rewrite.

3. **Content-addressed write-once blobs; mutable pointers last-write-wins.**
   Objects (`obj/<id>`) and ops (`op/<id>`) are addressed by a hash of their
   content, so they are **written once** and never updated; a blob whose bytes
   do not hash to its key id is **treated as absent on load** (torn-write
   safety, no corruption surfaced as truth). Mutable state — views
   (`view/<name>`), current-pointer (`current/<plaintextId>`), caps, embargo —
   is **last-write- wins**, written via temp-file + **atomic rename** in
   `FileBackend` so a crash never leaves a half-written pointer.

4. **Freeze-on-store at the persistence boundary.** Each record is
   `Object.freeze`d when inserted into the hot cache (on a mutation) and when
   decoded on load. This is the uniform realization of the deferred _"Record
   deep immutability … freeze-on-store"_ — done once at the boundary rather than
   per package. Known caveat (carried from the P07 learning): `Object.freeze`
   prevents field reassignment but **not** writes to a `Uint8Array`'s indices;
   the wire path (decode → fresh values) is the stronger guarantee, and a full
   deep-immutable wire encoding remains the research-grade end state.

5. **A small, explicit record codec.** Records carry `Uint8Array` fields
   (`nonce`, `ciphertext`, `sig`), so JSON alone is insufficient. Each package
   owns a tiny **JSON + base64** codec for its own records (`Store`:
   `EncryptedObject`, `Capability`; `OpLog`: `Op`, view head-sets). The encoding
   is deterministic and versioned with a leading tag (e.g. `tplv1`) so a future
   binary/immutable encoding can supersede it behind the same `Backend`.

6. **Durable repo open lives in `Platform`.** `createDurable`/`openDurable` are
   async (they `await` load), scope the backend to `repo/<name>/` via
   `scoped(...)`, and return an ordinary `Repo` whose `.log`/`.store` are
   backend-backed — so the existing `Workspace` and `Repo.land` work over a
   durable repo unchanged. The synchronous in-memory `createRepo` stays for the
   spike and tests.

### 4.1 Why this is almost no new model (honest claim)

Persistence is composition of things the brief already named:

| Capability                        | Mechanism                                                       |
| --------------------------------- | --------------------------------------------------------------- |
| durable cold tier                 | `Backend` KV (`FileBackend`) — the code.store cold storage      |
| hot reads stay fast & synchronous | the existing in-memory maps, kept as a write-through cache      |
| repo = content + ops + pointers   | `Store` objects + `OpLog` op-DAG + view pointers, all persisted |
| immutability at the boundary      | freeze-on-store + decode-fresh (the deferred uniform fix)       |
| swap fs → SQLite/S3 later         | the `Backend` seam (no `store`/`log` change)                    |

The genuinely new code is small: the `Backend` interface + two impls, the
write-through/load paths and codec on `Store`/`OpLog`, and the two async
`Platform` openers.

### 4.2 The one subtle rule — load order

`OpLog.load(store, backend)` must run **after** `Store.open(backend)` over the
same scope: the op-DAG references content by `Ref`, and `materialize` reads
those refs through the store. `Platform.openDurable` enforces the order
(`store = await Store.open(scoped); log = await OpLog.load(store, scoped)`).
Loading the store first guarantees every `Ref` an op names is already resident
in the hot cache before any `materialize`.

## 5. Scope

**In (this release):**

- `Backend` interface (in `store`) + `@thaddeus.run/persist` (`MemoryBackend`,
  `FileBackend`, `scoped`).
- `Store`: optional `backend`, write-through, `static open`, freeze-on-store,
  record codec.
- `OpLog`: optional `backend`, write-through, `static load`, freeze-on-store,
  record codec.
- `Platform`: async `createDurable` / `openDurable`.
- `examples/persist/` demo; an integration "survives a restart" test;
  `ARCHITECTURE.md` + `CHANGELOG.md`.

**Out (deferred, named so scope stays honest):**

- **The server / network API** — the next step toward "runnable"; persistence is
  its prerequisite.
- **The Git gateway** — a compatibility on-ramp, not core (see the prior design
  discussion); irrelevant to an agent-first native client.
- **Signed-record logs persistence (provenance / reputation / agent)** — the
  next persistence slice; the core repo is objects + ops + views.
- **SQLite / S3 backends** — the `Backend` seam supports them; only
  `FileBackend` + `MemoryBackend` ship now.
- **Multi-process concurrency, locking, transactions / WAL** — still single
  process; durable, not concurrent.
- **Op-log compaction / GC / cold-tiering** of accumulated views and ops.
- **Throughput benchmarking / the code.store envelope** — persistence is where
  per-op cost would be measured; this release adds only a smoke-level check, not
  a load harness.
- **Crash-atomicity beyond best-effort** — write-once blobs + atomic-rename
  pointers; no group-commit/WAL.

## 6. The seam (public API delta)

### `@thaddeus.run/store` (additive)

```ts
// The durable cold tier: a namespaced key → bytes store. Keys are strings like
// `obj/<id>`, `cap/<plaintextId>`, `current/<plaintextId>`, `pending/<plaintextId>`.
export interface Backend {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>; // undefined if absent
  list(prefix: string): Promise<readonly string[]>; // keys starting with prefix
  delete(key: string): Promise<void>; // idempotent (no-op if absent)
}

export class MemoryStore implements Store {
  // No backend ⇒ pure in-memory (today's behavior). With a backend ⇒ the hot
  // cache writes through on every mutation. The name reflects the hot tier; a
  // backend makes it durable (the code.store "in-memory writes, cold storage").
  constructor(backend?: Backend);

  // Rebuild a hot cache from a backend: load objects/current/caps/pending,
  // decode (a content-addressed object whose bytes don't hash to its id is
  // skipped as torn), freeze, and return a ready, backend-backed store.
  static open(backend: Backend): Promise<MemoryStore>;

  // ... existing Store surface unchanged (put/get/grant/revoke/scheduleReveal/
  // reveal async; caps/rawObject/current/verify synchronous) ...
}
```

### `@thaddeus.run/log` (additive)

```ts
export class OpLog {
  // No backend ⇒ pure in-memory (today). With a backend ⇒ write-through on
  // write/remove/view/fork/append/reveal.
  constructor(store: Store, backend?: Backend);

  // Rebuild the op-DAG + views + embargo from a backend. Call AFTER Store.open
  // over the same scope (ops reference content the store must already hold).
  static load(store: Store, backend: Backend): Promise<OpLog>;

  // ... existing surface unchanged; sync reads (materialize/heads/conflicts/
  // ops/view/fork/verify/publicView) read the hot cache ...
}
```

### `@thaddeus.run/persist` (new)

```ts
import type { Backend } from '@thaddeus.run/store';

// In-memory backend for fast, deterministic tests. Copies bytes in and out so a
// caller cannot mutate stored blobs.
export class MemoryBackend implements Backend {
  /* Map<string, Uint8Array> */
}

// Filesystem backend: each key → one percent-encoded file under `root`. put is
// temp-file + atomic rename; get returns undefined on ENOENT; list reads the
// dir and filters by decoded prefix. Zero dependencies beyond node:fs.
export class FileBackend implements Backend {
  constructor(root: string);
}

// Namespace a backend: every key is prefixed (e.g. `repo/acme%2Fweb/`), so one
// backend can hold many scopes without collision.
export function scoped(backend: Backend, prefix: string): Backend;
```

### `@thaddeus.run/platform` (additive)

```ts
export class Platform {
  // Fresh durable scope: scopes the backend to `repo/<name>/`, builds a
  // backend-backed Store+OpLog, seeds `main`, registers, returns the Repo.
  createDurable(name: string, backend: Backend): Promise<Repo>;

  // Re-open a durable scope: Store.open then OpLog.load over the scoped backend,
  // returns the rebuilt Repo. Its .log/.store are backend-backed, so Workspace
  // and Repo.land work unchanged.
  openDurable(name: string, backend: Backend): Promise<Repo>;
}
```

### 6.1 Write-through

A mutation does the in-memory update first (unchanged logic), then persists only
the touched entries:

- `Store.put` → `backend.put('obj/<ref.id>', enc(object))` + update
  `current/<plaintextId>`.
- `Store.grant`/`revoke` → re-persist `obj/<new id>` (revoke rotates → new
  ciphertext) + `cap/<plaintextId>` + `current/<plaintextId>`.
- `Store.scheduleReveal` → `pending/<plaintextId>`; `reveal` → promote `pending`
  → `cap`, re-persist both.
- `OpLog.write`/`remove` → `op/<id>` (write-once) + `view/<view>` (the advanced
  head). `view`/`fork` → `view/<name>`. `append` → `op/<id>`. `#embargoOp` →
  `embargo/<id>`; `reveal` → update it.

Write-through is `await`ed inside the already-async mutation, so failures
surface to the caller and the hot cache and durable tier do not diverge
silently.

### 6.2 Load

`Store.open(backend)`: `list('obj/')` → decode each, verify `id`
(content-address) → skip torn, freeze, into `#objects`; `list('current/')`,
`'cap/'`, `'pending/'` likewise. `OpLog.load(store, backend)`: `list('op/')` →
decode + `verifyOp` → `#ops` (frozen); `list('view/')` → `#views`;
`list('embargo/')` → `#embargo`. Both are idempotent and pure functions of the
backend's contents.

### 6.3 The codec

`encodeObject`/`decodeObject` (and op/cap/view equivalents): a leading version
tag `tplv1` then JSON with `Uint8Array` fields base64-encoded. Decode validates
shape and (for content-addressed records) recomputes and checks the id. Kept
deliberately simple and versioned; a binary/immutable encoding can replace it
behind the unchanged `Backend`.

## 7. Data model

No new domain records — persistence stores the **existing** records under a
namespaced key layout:

```
obj/<id>               → EncryptedObject (write-once, content-addressed)
current/<plaintextId>  → current ciphertext id (pointer, last-write-wins)
cap/<plaintextId>      → Capability[] (served capabilities; pointer)
pending/<plaintextId>  → Capability[] (withheld reveals; pointer)
op/<id>                → Op (write-once, content-addressed)
view/<name>            → head-set (string[] of op ids; pointer)
embargo/<id>           → { metaRef, token, revealed } (pointer)
```

The hot caches (`Store`/`OpLog` in-memory maps) are unchanged; persistence only
mirrors them durably.

## 8. Crypto choices

**None new.** Persistence stores **ciphertext** (objects are already
envelope-encrypted by P01) and **signed** ops/caps — the durable tier never sees
plaintext or a signing key. The codec is base64 transport only, not a security
boundary. `FileBackend` writes ciphertext blobs; reading a raw `obj/<id>` file
yields the encrypted object, never plaintext (the demo shows this). Load re-runs
the existing integrity checks (content-address on objects/ops, `verifyOp`), so a
tampered durable blob is rejected, not trusted.

## 9. The demo — a repo that survives a restart (CLI)

`examples/persist/` (sibling to `examples/platform/`), using a `FileBackend` in
a temp/example directory. Three acts:

**Act 1 — durable edit.**
`await new Platform().createDurable('acme/web', backend)`; open a `Workspace`,
write `src/auth.rs`, commit, `land` it. Show `landed: true` and that `backend`
now holds files (`list('repo/…/op/')` / `obj/`).

**Act 2 — restart.** Discard everything;
`await new Platform().openDurable('acme/web', backend)` from the same dir. Show
`materialize('main')` still contains `src/auth.rs` and the content decrypts.

**Act 3 — the cold tier is ciphertext.** Read a raw `obj/<id>` file and print
that it is encrypted bytes, not the source — durability without exposing
plaintext. Print the acceptance facts.

## 10. Acceptance criteria (measurable; written test-first)

1. **Backend round-trip** — `MemoryBackend` and `FileBackend`: `put` then `get`
   returns the bytes; `get` of an absent key → `undefined`; `delete` is
   idempotent; `list(prefix)` returns exactly the keys under the prefix.
2. **FileBackend key encoding** — keys containing `/` (`view/ws/main/0`)
   round-trip through one file each; `list` filters by decoded prefix; a `put`
   over an existing key replaces it atomically.
3. **Store write-through + reopen** — put two objects + a grant against a
   `MemoryStore(backend)`; discard it; `MemoryStore.open(backend)` → `get`
   decrypts both and the grantee can read the granted one.
4. **Freeze-on-store** — an `EncryptedObject` in the hot cache (after `put` and
   after `open`) is `Object.isFrozen`.
5. **OpLog write-through + reload** — write ops and re-point `main`; discard;
   `OpLog.load(store, backend)` → `materialize('main')` and `heads('main')`
   match the pre-discard values; `verify(op.id)` is true.
6. **Survives a restart (headline)** — `createDurable` → workspace commit →
   `land`; discard; `openDurable` from the same backend → `materialize('main')`
   contains the path and `store.get` returns the original bytes. _(Pins the
   whole release.)_
7. **FileBackend on a real temp dir** — the same survives-restart against the
   filesystem (temp dir created and cleaned up by the test).
8. **No-backend regression** — `new MemoryStore()` and `new OpLog(store)` with
   no backend behave exactly as before; the full existing repo suite stays
   green.
9. **Torn-blob safety** — an `obj/<id>` (or `op/<id>`) whose stored bytes do not
   hash to `<id>` is skipped on load (treated as absent), never surfaced as
   truth. _(Pins decision 3.)_
10. **No async ripple** — `caps`/`rawObject`/`current`/`verify`/`materialize`/
    `heads`/`conflicts`/`ops`/`publicView` remain synchronous; `log`/`platform`
    callers compile unchanged. _(Pins decision 2; a typecheck-level guarantee.)_
11. **Integration (north-star)** — a seeded edit lands on a durable repo
    (`createDurable`) and is still present after `openDurable`; the integration
    flow goes to **8 pass / 0 todo**.

## 11. Honest limitations (stated, not hidden)

- **Single process, durable not concurrent.** No locking; two processes over one
  backend can race. The brief's spike posture holds — durability is the only new
  guarantee.
- **Best-effort crash-consistency.** Write-once blobs are torn-safe (id check);
  pointers use atomic rename; but there is no group-commit/WAL, so a crash
  between two related writes (e.g. an op blob and its view pointer) can leave
  the view trailing the op. On reload the op exists but isn't referenced —
  recoverable, not corrupting. A transactional backend (SQLite) closes this
  later.
- **`Object.freeze` doesn't deep-freeze byte arrays.** Field reassignment is
  blocked; `Uint8Array` index writes are not (the decode-fresh wire path is the
  stronger guarantee). Full immutable encoding is the research-grade end state.
- **Whole-state load.** `open`/`load` read the entire scope into memory (the hot
  cache holds everything). Fine for the spike; lazy/partial load + cold-tiering
  is a later optimization, as is the throughput envelope.
- **Records logs not persisted yet.** Provenance/reputation/agent records are
  in-memory until the next slice; a reopened repo has its history + content but
  not its (P04/P07/P09) side-records.
- **No server.** Persistence is in-process durability; serving it over a network
  is the next step.

## 12. Seeded/updated docs

- **`CHANGELOG.md`** — under `[Unreleased] → Added`: the persistence layer
  (`@thaddeus.run/persist` + the `Backend` seam; durable `Store`/`OpLog` via
  hot-cache write-through + `open`/`load`;
  `Platform.createDurable`/`openDurable`; freeze-on-store; a repo survives a
  restart). Move **"Persistence backends"** out of the deferred ledger into
  Added (scoped to Store+OpLog; record logs still owed). Update the **"Record
  deep immutability"** research item to note freeze-on-store now ships at the
  persistence boundary (the `Uint8Array`-index caveat remains). Add deferred
  items: server/network, Git gateway, record-logs persistence, SQLite/S3
  backends, concurrency/locking/WAL, compaction/GC.
- **`ARCHITECTURE.md`** — add a short "Persistence" note to the build-order /
  status section: the substrate is now optionally durable behind `Backend`
  (`@thaddeus.run/persist`), realizing the code.store hot/cold split; the
  in-memory default is unchanged.
- **North-star** — add a durable survives-restart assertion (or a sibling
  integration test) taking the flow to 8 pass / 0 todo.

## 13. Open items / next primitives

- **The server / API** is the next step toward "runnable": expose `Platform`'s
  durable surface (`createDurable`/`openDurable`, Workspace verbs, `land`) over
  HTTP/RPC — stateless nodes over the shared backend, the brief's API-first
  remote and its P9 horizontal-scale answer.
- **Record-logs persistence** (provenance/reputation/agent) — the next
  persistence slice, same `Backend` seam.
- **A SQLite `Backend`** — transactional, closing the best-effort crash-window;
  drops in behind the seam.
- **Measuring the per-op cost** against a latency budget (the deferred
  throughput envelope) now has a real place to run — the durable write path.
