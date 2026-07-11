# Thaddeus — Server: the untrusted API-first remote (design)

**Date:** 2026-06-25 **Status:** Design — pending user review, then
implementation plan **Product:** Thaddeus (working name) · **Company/monorepo:**
Thaddeus (`@thaddeus.run/*`) **Source of truth (vision):**
`the-new-age-of-source-control.html`, Part VI ("API-first remote", code.store)
**Builds on:** `docs/specs/2026-06-24-thaddeus-pillar-06-platform-design.md`
(the `Platform`/`Repo`) and
`docs/specs/2026-06-25-thaddeus-persistence-design.md` (the durable
`Store`/`OpLog` + `Backend`)

---

## 1. Context — why this, why now

Persistence made a repo **survive a restart**; it is still in-process. A working
source control has to be **usable over a network** — that is the server. This
release exposes the durable `Platform` as an HTTP API so a client over the wire
can **push** committed work, **land** it under policy, and **clone** it back.

The server is **infrastructure, not a pillar** — it is the realization of the
brief's "API-first remote": _"in-memory writes, ephemeral branches, … cold
storage,"_ served by **stateless nodes over a shared store**. The persistence
layer set this up deliberately: the `Backend` is the shared cold tier and the
hot-cache/write-through model means a stateless node just `openDurable`s a repo
on demand.

It also discharges a deferred item by name: the persistence ledger left durable
**peer-ingest** ("`append` persists") to "federation". The server is
federation's first consumer, so that durable-ingest seam ships here.

## 2. Governing principle — _the server is untrusted_

This is the brief's thesis, not a configurable choice: **self-owned identity,
the server never holds a key, a mirror serves ciphertext.** Everything shipped
already assumes it (reads are decryption-bounded; ops/contributions/provenance
verify against DIDs with no trust in any server).

It is also **feasible without compromise**, which this release proves:

- The server **verifies** what it ingests using only public data — `verifyOp`
  (the author's `did:key`), `address(ciphertext) === id` (a hash), and
  `verifyCapability` (a signature). No secret key, no decryption.
- The server **lands** without keys: `Repo.land` works entirely on **cleartext
  op-DAG metadata** (path, lamport, parents) + a fail-closed `LandPolicy` + a
  view re-point. It never reads an encrypted payload and never signs (it does
  not even use its `author` argument — §4, decision 5).
- The server **serves ciphertext**; the client holds the `Identity` and does all
  encrypt / decrypt / sign / commit locally.

So the server is a **verifying, policy-enforcing, ciphertext transport** over
the durable `Platform`. Reads are a public mirror; writes are owner-signed.

## 3. The release's job

A single-node HTTP server (`Bun.serve`) over a durable `Platform`, plus the two
substrate seams it needs. Deliverables:

- A new package **`@thaddeus.run/server`**: `Bun.serve` routing, the
  signed-request envelope, per-repo ownership, and handlers for create / list /
  push / land / pull / view.
- Two **additive substrate seams** (the durable peer-ingest path):
  `Store.ingest(object, caps)` and `OpLog.ingest(op)`.
- A tiny, backward-compatible **widening of `Repo.land`'s `author`** to a
  key-less `PublicIdentity` (it is unused by `land`).
- An **HTTP-level test suite** (real `fetch` against a live `Bun.serve`, clients
  built from `identity`/`store`/`fs`), a runnable **`examples/server/` demo**,
  and `ARCHITECTURE.md` + `CHANGELOG.md` updates.

Not the job (deferred, §11): multi-node concurrency / optimistic-concurrency on
`land` + the `scope` delimiter-encode; a grant list / richer ACLs; a client
SDK/CLI; TLS / deployment; incremental pull / pagination; the Git gateway.

> **P11 update (2026-07-11):** replay-proof request nonces have shipped. See
> `docs/superpowers/specs/2026-07-11-p11-replay-nonce-cache-design.md` for the
> current protocol and its process-local boundary.

## 4. Decisions taken (brainstorm outcomes)

1. **Server-only slice.** Ship the server + HTTP API, exercised at the HTTP
   level by tests and a demo. The "client" is `fetch` + the existing
   `identity`/`store`/`fs` packages doing local crypto — no client SDK/CLI yet.
   Thinnest thing that is genuinely "usable over a network".

2. **Typed domain-object push (verify-don't-trust).** Push ships a typed payload
   `{ ops, objects, caps }`; the server **verifies each item** and ingests it
   via the new seams, **deriving** the mutable pointers (`current`, `cap`) from
   verified content. The server **never trusts a client-supplied key**; views
   move only via `land`. (Rejected: raw `Backend`-entry sync — the client would
   dictate keys and push unverifiable pointers; and RPC "remote `commit`" —
   `commit` needs the secret key the server must never hold.)

3. **Signed requests + repo owner.** The creator's `did:key` owns the repo
   (persisted). Write requests (`push`/`land`/`create`) carry a signature over a
   canonical request string; the server verifies it and checks
   `signer === owner`. Reads are public (the mirror serves ciphertext to
   anyone). Slice one used a timestamp window; P11 now binds a random nonce and
   rejects its reuse within the running server process.

4. **`Bun.serve`, single node.** Zero-dependency, matches the toolchain. The
   only per-node state is an in-memory cache of opened `Repo`s, rebuildable from
   the `Backend` — the brief's "stateless over shared store". Per-repo mutation
   serialization (an in-process async lock) keeps a `land`'s read-heads→re-point
   from interleaving with a push. Cross-node concurrency is deferred.

5. **`land` is key-free; widen `author`.** `Repo.land` never uses `opts.author`
   (reserved for future P10 review gates); it works on cleartext metadata, a
   fail-closed policy, and a view re-point. Widen `author: Identity` →
   `author: PublicIdentity` so the server can land with only the signer's DID.
   Backward-compatible (it is unused, and `Identity` exposes the public
   surface).

6. **Two ingest seams = the durable peer-ingest path.** `Store.ingest` /
   `OpLog.ingest` are the verifying, persisting counterparts to the in-memory
   `OpLog.append` Task 3 left for "federation". `append` stays as-is; `ingest`
   is the durable one.

### 4.1 Why this is almost no new model

| Capability                         | Mechanism                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------- |
| stateless node over shared store   | durable `Platform.openDurable` over one `Backend` (persistence)            |
| verify without trust               | `verifyOp` / `address()` / `verifyCapability` (existing, public-only)      |
| land without keys                  | `Repo.land` on cleartext op metadata + `LandPolicy` (P06)                  |
| serve ciphertext / decrypt at edge | `Store` returns ciphertext; client decrypts (P01 decryption-bounded reads) |
| durable ingest                     | new `Store.ingest` / `OpLog.ingest` (the deferred peer-ingest seam)        |

The genuinely new code is the HTTP server + signed-request envelope + ownership,
and the two small ingest methods.

## 5. Scope

**In:** `@thaddeus.run/server` (`Bun.serve`, routing, signed-request, ownership,
the six handlers); `Store.ingest` + `OpLog.ingest`; `land` author widening;
HTTP-level tests; `examples/server/`; docs.

**Out (deferred, named so scope stays honest):**

- **Multi-node concurrency** — optimistic-concurrency on the `land` re-point and
  the `scope()` delimiter-encode for many repos in one shared store. Single node
  now (per-repo in-process lock).
- **Grant list / richer ACLs** — owner-only writes in slice one.
- **Replay-proof nonces (shipped in P11)** — a signed random nonce is consumed
  by a bounded, expiring process-local cache. Durable multi-node consumption is
  still deferred.
- **Client SDK / CLI** — the client is `fetch` + existing packages in
  tests/demo.
- **TLS / auth tokens / deployment / process management.**
- **Incremental pull / pagination** — slice one pulls the full reachable set
  from a view's heads.
- **The Git gateway** — the optional compatibility on-ramp, later.

## 6. The seam (public API)

### 6.1 HTTP endpoints

Reads — **public** (ciphertext mirror):

```
GET  /repos                         → { repos: string[] }
GET  /repos/:name/views/:view       → { view, heads: string[] }            (404 if no repo)
GET  /repos/:name/pull?view=main    → { ops: Op[], objects: EncryptedObject[], caps: Capability[] }
```

`pull` returns everything reachable from the view's heads (clone = pull `main`):
the ops in `(lamport, id)` order, the `current` `EncryptedObject` for every
`plaintext_id` an op's payload `Ref` names, and those objects' served caps.

Writes — **owner-signed**:

```
POST /repos                         { name }                    → 201 { name, owner }   (409 if exists)
POST /repos/:name/push              { ops, objects, caps }      → 200 { accepted, rejected }
POST /repos/:name/land              { fromHeads: string[], into? } → 200 LandResult
```

`push` verifies each item and ingests it; unverifiable items are returned in
`rejected: [{ kind, id, reason }]`, **not stored** (a partial push reports both
sides at `200`). `land` builds an ephemeral source view from `fromHeads`
(rejecting `400` if any head is an op the server has not ingested — push first,
then land by head ids), runs `repo.land` with the server-configured policy, and
`landed:false` (empty/conflicting) is a normal `200` with a `reason`.
(`fromHeads` is the wire-honest form of `land`'s source: the client's branch
view name does not exist server-side, so the frontier travels as explicit op
ids.)

Byte-bearing fields (`Op.sig`, `EncryptedObject.nonce`/`ciphertext`, capability
wrapped-keys/sigs) cross the wire via the persistence
`encodeRecord`/`decodeRecord` convention, so the DTO ↔ record mapping is one
function per type.

### 6.2 The signed-request envelope (writes only)

Four headers:

```
X-Thaddeus-Did        the signer's did:key
X-Thaddeus-Timestamp  ISO-8601
X-Thaddeus-Nonce      random request identifier
X-Thaddeus-Signature  sign( `${method}\n${pathWithQuery}\n${blake3(body)}\n${timestamp}\n${nonce}` )
```

The server: (1) verifies the signature with the DID's public key; (2) requires
the timestamp within ±5 minutes; (3) consumes the `(signer, nonce)` pair in the
server's bounded replay cache; and (4) for `push`/`land`, requires
`signer === repo.owner`. Failures: `401` (missing/invalid/expired/replayed
signature), `403` (valid signature, not owner). Binding the signature to
`blake3(body)` and the nonce means a tampered payload or nonce fails — the owner
authorizes exactly these bytes.

### 6.3 Substrate seams (additive)

```ts
// @thaddeus.run/store
class MemoryStore {
  // Ingest a client-encrypted object + its caps (the untrusted-server path):
  // verify content-address (reject on mismatch), verify each capability (drop
  // invalid), store frozen, advance `current`, store caps, write through.
  ingest(object: EncryptedObject, caps: readonly Capability[]): Promise<void>;
}

// @thaddeus.run/log
class OpLog {
  // Durably ingest a peer/pushed op: verifyOp (reject on failure), append frozen,
  // write through op/<id>. Touches no view (views move only via repoint/land).
  ingest(op: Op): Promise<void>;
}

// @thaddeus.run/platform — widen the unused author to a key-less identity
class Repo {
  land(opts: {
    from: string;
    into?: string;
    author?: PublicIdentity;
    policy?: LandPolicy;
  }): Promise<LandResult>;
}
```

### 6.4 The server surface

```ts
// @thaddeus.run/server
interface ServerConfig {
  backend: Backend; // the shared cold tier (e.g. a FileBackend)
  policy?: LandPolicy; // default blockOnConflict; fail-closed, key-free
  now?: () => string; // injectable clock for the timestamp window (tests)
}
// Returns a Bun.serve-compatible fetch handler. Bind it with
// `Bun.serve({ fetch })` — there is no built-in start/stop helper.
function createServer(config: ServerConfig): {
  fetch: (req: Request) => Promise<Response>;
};
```

The server holds an in-memory `Map<name, Repo>` cache and a per-repo async lock;
a cache miss does `Platform.openDurable(name, backend)`. No other node state.

## 7. Data model

No new domain records. New persisted item: per-repo **ownership** metadata in
the repo's scoped backend:

```
meta/repo  →  { owner: did }          (pointer; written once at create)
```

Everything else is the existing persisted layout (`obj`/`op`/`view`/`cap`/
`current`/`pending`/`embargo`). The wire DTOs are the existing `Op`,
`EncryptedObject`, and `Capability` shapes with base64 byte fields.

## 8. Crypto choices

**None new.** The server only **verifies** (existing `verifyOp`,
`verifyCapability`, `address`, and `identity` sign/verify for the request
envelope) and **serves ciphertext**. It holds no `Identity` and no content key,
never decrypts, never signs. The request envelope reuses `identity` signatures
over a canonical string; `blake3` (already a dependency) hashes the body. A
pulled object is the same ciphertext stored on disk — never plaintext.

## 9. The demo — push, land, clone, over HTTP

`examples/server/` — a runnable script: start `createServer` on a `Bun.serve`
ephemeral port over a temp `FileBackend`; **Client A** (identity A) creates
`acme/web`, commits `src/auth.rs` locally (a `Workspace` over a local
store+log), pushes the ops/objects/caps (signed), and lands `feat → main`; a
**fresh client** (identity A, empty local state) clones via `pull`, rebuilds a
local store+log, materializes `main`, and prints the decrypted content. Then
show a **non-owner push rejected (`403`)** and a **raw pulled object as
ciphertext**. Shut the server down.

## 10. Acceptance criteria (measurable; written test-first)

1. **Create + owner** — signed `POST /repos` persists `owner=A`; `GET /repos`
   lists it; a second create of the same name → `409`.
2. **Signed-request** — missing/invalid signature → `401`; valid but non-owner →
   `403`; body altered after signing → `401`.
3. **Push verifies** — valid items ingested (accepted counts); a forged op (bad
   sig) and a mis-addressed object → `rejected[]` with reasons, **not stored**.
4. **Push idempotent** — re-pushing the same content-addressed items is a no-op.
5. **Land gated + correct** — owner `land` re-points `main` (`landed:true`); an
   empty/conflicting `land` → `landed:false` + reason at `200`.
6. **Pull serves ciphertext** — `/pull` returns ops+objects+caps; a returned
   object's bytes are ciphertext, not the plaintext source.
7. **Clone round-trip (headline)** — A creates→commits→pushes→lands; a fresh
   client (identity A, empty state) pulls, rebuilds locally, materializes
   `main`, and decrypts the original content.
8. **Decryption-bounded over the wire** — a second identity B pulls the same
   ciphertext but **cannot** decrypt it; after A grants B (pushes an added cap),
   B pulls and reads it.
9. **Stateless / durable** — restart the server (new `createServer` over the
   same `FileBackend` dir) → `/pull` still returns the landed content (repo
   rebuilt from the backend).
10. **Ingest seams (unit)** — `Store.ingest` rejects a mis-addressed object and
    an invalid cap; `OpLog.ingest` rejects a bad-sig op — direct tests in
    `store`/`log`.
11. **No regression** — existing `store`/`log`/`platform` suites stay green
    (`ingest` + `author` widening are additive; no sync read becomes async).

## 11. Honest limitations (stated, not hidden)

- **Single process.** One node; the in-process per-repo lock serializes
  push/land. Multi-node needs optimistic-concurrency on the re-point and the
  `scope()` delimiter-encode — deferred.
- **Replay within the window.** A captured write request can be replayed within
  ±5 min (no nonce store). Forgery is still impossible (signature-bound to the
  body + signer DID); a duplicate push is content-addressed (idempotent) and a
  duplicate land is a no-op once landed — so the practical blast radius is
  small. A nonce store closes it later.
- **Owner-only writes.** No grant list / delegation-to-push yet; the owner is
  the sole writer. (Agent delegation, P09, gates _landing_ via policy, which is
  separate and already works.)
- **Full-set pull.** `pull` returns the whole reachable set from a view; no
  incremental/`since` fetch or pagination — fine for spike-sized repos.
- **No transport security / deployment.** Plain HTTP, no TLS, no auth tokens, no
  process supervision — a spike server, not a hardened service.
- **Reads are a fully public mirror.** Anyone can pull a repo's ciphertext; the
  encryption (decryption-bounded reads) is the only confidentiality boundary. A
  read-ACL is a later concern.

## 12. Seeded/updated docs

- **`CHANGELOG.md`** — `[Unreleased] → Added`: `@thaddeus.run/server` (the
  untrusted API-first remote: `Bun.serve` over the durable `Platform`; signed
  requests + repo owner; verify-don't-trust push; key-free server-side land;
  ciphertext pull/clone; stateless over the shared backend). Note `Store.ingest`
  / `OpLog.ingest` shipped (the durable peer-ingest seam), and move/annotate the
  deferred "server/network API" item to shipped (single-node). Add deferred:
  multi-node concurrency, grant list, replay nonces, client SDK/CLI, Git
  gateway.
- **`ARCHITECTURE.md`** — add a "Server" note after the Persistence section: the
  durable `Platform` is now reachable over HTTP as a stateless, untrusted,
  ciphertext-serving remote; the Git gateway and a client SDK/CLI are the next
  steps.

## 13. Open items / next primitives

- **Client SDK / CLI** — wrap the HTTP protocol so a human (or agent) can
  `clone`/`push`/`land` without hand-rolling `fetch` + crypto. The natural next
  step toward day-to-day use.
- **Multi-node** — optimistic-concurrency on the `land` re-point
  (compare-and-set on the view pointer) + the `scope()` delimiter-encode, making
  the server genuinely horizontally scalable over a shared backend (the brief's
  envelope).
- **Federation wire** — the server is the first peer-ingest consumer;
  cross-instance push/pull and the reputation/provenance record wire build on
  the same seam.
- **The Git gateway** — emit a Git history for compatibility, over this same
  durable/served substrate.
