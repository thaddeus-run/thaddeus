# Changelog

All notable changes to Thaddeus. Format follows
[Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added

- `@thaddeus.run/identity` — self-owned `did:key` identity: sign/verify,
  anonymous seal/unseal.
- `@thaddeus.run/store` — encrypted, content-addressed objects with per-object
  capabilities (grant/revoke = key rotation). Pillar 01.
- `@thaddeus.run/store` — scheduled timed reveal ("the membrane", Pillar 02):
  `scheduleReveal`/`reveal` release an object's payload to a well-known public
  identity at time T via a withheld key-release. Payload only; metadata-gating
  deferred (see below). `@thaddeus.run/identity` gains `Identity.fromSeed`.
- `@thaddeus.run/log` — the operation log (Pillar 03): signed, CRDT-ordered `Op`
  records on a DAG; deterministic `(lamport, id)` ordering; `materialize`
  projects to a path→Ref tree by LWW per path using cleartext metadata only;
  zero-copy named views (`fork`/`view`); `append` peer-ingest converges
  order-independently; `conflicts` surfaces concurrent same-path ops; delete
  tombstones. Wires the **P02 metadata-gating seam**: an embargoed op publishes
  only an opaque ordering token; its metadata is sealed and released at T via
  the membrane.
- `@thaddeus.run/provenance` — the signed "why" layer (Pillar 04): a
  `Provenance` record bound to an `Op.id` carrying actor, actor_kind, intent,
  reasoning, task, and an optional **capability-gated prompt** (stored by
  reference — `prompt_ref = blake3(prompt)` plus a store `Ref` — so prompts with
  secrets never enter readable history). The signature covers the **full
  record** (hardening the brief's narrower `op‖intent‖task‖prompt_ref` subset),
  so `actor_kind`/`reasoning` cannot be forged on relay. `ProvenanceLog` renders
  each record `verified`/`unverified` and **keeps** invalid records (labelled,
  not rejected). Completes **P12** and closes the seeded north-star one-edit
  flow (5 pass / 0 todo).
- `@thaddeus.run/fs` — the virtual filesystem (Pillar 05): a copy-on-write
  `Workspace` over the operation log. `open` forks a **private, pinned** view
  (peer ops never shift it); `read`/`list`/`grep` project that view layered
  under an in-memory edit overlay; `write`/`rm` stage into the overlay; `commit`
  folds it into signed ops via `log.write`/`log.remove`; `fork()` branches a
  working copy in O(1). `read`/`grep` are **decryption-bounded** — you can only
  search what your identity can decrypt. The north-star's seeded edit now
  originates in a `Workspace` (5 pass / 0 todo).
- `@thaddeus.run/platform` — the platform (Pillar 06): named repos (scopes) with
  one-call `createRepo` and bare-push `open` (auto-vivify), each owning its own
  op-log + store so the `Workspace` opens over it unchanged. `Repo.land` is
  **landing-as-policy**: it dry-runs a merge on a throwaway view, runs a
  pluggable `LandPolicy`, and re-points the shared view **only on allow**
  (fail-closed). Ships `allowAll`, `blockOnConflict` (default), and
  `requireVerifiedProvenance` — the seam Pillar 10 fills. The north-star's
  seeded edit now lands into `main` under policy and is asserted mirror-servable
  (`store.verify` + `log.publicView`), closing the spine's `policy` and `mirror`
  stages (5 pass / 0 todo).
- `@thaddeus.run/reputation` — portable federated reputation (Pillar 07): the
  dual-signed `Contribution` record (`subj_sig` = the subject claims it,
  covering `(subject, repo, ref, kind, at)`; `host_sig` = an instance attests
  it, covering all six fields including the subject's signature).
  `verifyContribution` returns `{ authentic, attested }`, fail-soft — any holder
  of the record + dids verifies it alone, with no trust in any server.
  `ReputationLog` is an untrusted, keep-and-label aggregator whose `profile`
  partitions a subject's records into **attested** and **claimed** and counts
  the attested set `byKind` — reputation is the gathered, self-verifying record
  set, not a number. The north-star's landed op now mints a `'merge'`
  contribution honored on a second instance (6 pass / 0 todo).
- `@thaddeus.run/agent` — agents as first-class principals (Pillar 09): an
  operator-signed `Delegation` grants an agent `did:key` scoped, budgeted
  authority (`paths` globs, `maxChanges`, `maxSpend`), with the operator did
  derived from the signer so a change by the agent is verifiably attributed to
  its operator. `AgentRegistry` is an enforcement authority — it rejects forged
  grants (unlike the keep-and-label reputation log), holds a quarantine set, and
  meters each agent's changes/spend. `delegationPolicy(registry)` is a
  fail-closed `LandPolicy`: at `Repo.land` it rejects an op whose author is
  revoked, undelegated, out of path-scope, or over budget — substrate-enforced,
  read-only on the meter. Revocation = `registry.revoke` (quarantine) +
  `store.revoke` (key rotation, P01). The north-star now lands an agent's change
  under its delegation and quarantines it on revoke (7 pass / 0 todo).
- `@thaddeus.run/persist` + durable `Store`/`OpLog` — persistence: a pluggable
  `Backend` (key→bytes; `FileBackend` atomic temp+rename, `MemoryBackend`,
  `scoped`) defined in `@thaddeus.run/store`. `Store` and `OpLog` take an
  optional backend — durable mutations write-through (content-addressed
  `obj`/`op` write-once; `view`/`cap`/`current`/`pending`/`embargo` pointers);
  peer-ingest `append()` remains in-memory only until federation persistence
  lands (so the durable path covers local writes and re-points, not peer
  delivery). `MemoryStore.open` / `OpLog.load` rebuild the hot cache (torn blobs
  skipped), records are frozen on store, and **synchronous reads are unchanged**
  (no async ripple). `Platform.createDurable`/`openDurable` make a repo
  **survive a restart** (8 pass / 0 todo). Realizes the code.store hot/cold
  split and the deferred freeze-on-store immutability fix.
- `@thaddeus.run/server` — the untrusted API-first remote (Part VI): a
  `Bun.serve` HTTP server over the durable `Platform` that holds **no keys**,
  **verifies** what it ingests (`verifyOp`, content-address, `verifyCapability`)
  and **serves ciphertext**. Reads are a public mirror (`GET /repos`,
  `…/views/:view`, `…/pull`); writes are gated by a signed-request envelope
  (DID + timestamp + signature over `method‖path‖blake3(body)‖timestamp`)
  checked against the persisted repo **owner**. `push` ingests
  `{ops, objects, caps}` verify-don't-trust via new `Store.ingest` /
  `OpLog.ingest` (the durable peer-ingest seam); `land` (by explicit
  `fromHeads`) runs the fail-closed `LandPolicy` and re-points the view — all
  key-free. Stateless over the shared `Backend`: an HTTP clone round-trip (push
  → land → fresh-client clone + decrypt) survives a server restart.
- `@thaddeus.run/client` + `@thaddeus.run/cli` — the client SDK and the
  `thaddeus`/`thad` CLI. `Client` holds a self-owned `Identity` and drives the
  remote (`createRepo`/`clone`/`push`/`land`), signing every write and doing all
  crypto client-side; `clone` reads view heads explicitly (closing the server's
  pull-infers-heads follow-up). The CLI is a git-like client over a `.thaddeus/`
  durable working copy: `init` (identity seed in `~/.config/thaddeus/`),
  `create`, `clone` (materializes files), `status`, `push` (commit → upload →
  land into `main`), `land`. The product is now **Thaddeus** (the working name
  "Strata" is retired; a repo-wide doc rename follows).
- `thaddeus serve` + atomic pull — run a durable server in one command
  (`thaddeus serve [--port] [--data]`, over a `FileBackend`), and `GET /pull`
  now returns `{ view, heads, …bundle }` so `Client.clone` is a single race-free
  request (closing the clone read-read race). The product name **Thaddeus**
  replaces the working name "Strata" in forward-facing docs.

### Changed

- Re-scoped packages `@thaddeus/*` → `@thaddeus.run/*`; renamed the `core`
  placeholder package to `store`.

## Deferred — known gaps we owe (tracking note, not shipped)

> A side ledger of everything intentionally left out, so nothing gets lost.
> Three buckets: **scope-cut** (a later pillar/release, no unknowns),
> **research** (blocked on an open/hard problem — the things we must eventually
> do _well_, not just at all), and **honest limitations** of what currently
> ships. Items move up into a release section above when they land.

### Research — open/hard problems (the "do it great" list)

- **Trustless timed reveal (P02).** The planned membrane relies on a trusted
  holder pre-computing the key-release and withholding it until T; a dishonest
  store could release early. A genuinely trustless unattended embargo needs
  time-lock crypto (VDF / time-lock puzzle). Deferred — out of spike scope.
- **Convergence over sealed metadata (P02/P03).** The metadata-gating _seam_
  shipped: an embargoed op publishes only an opaque ordering token and seals its
  metadata until T (`@thaddeus.run/log`). Still open: how peers who cannot read
  an embargoed op's metadata do content-aware placement during the embargo —
  fast CRDT convergence wants cleartext metadata, a real embargo wants it sealed
  (brief, Part VI frontier).
- **Key recovery / escrow / threshold / device-subkeys (P01).** The brief's
  named landmine. v1 is single-keypair, no recovery: lose the key, lose the
  data.
- **Rust hot-path reimplementation.** Move an interior to Rust (→ WASM/NAPI)
  behind the wire-format seam only when a _measured_ hot path demands it —
  likely P03 (op-log/CRDT) and P08 (semantic graph). Never pre-optimize the
  spike.
- **Record deep immutability (P03/P04).** `Op.sig` and `Provenance.sig` are
  `Uint8Array`s (and `Provenance.prompt` is an object reference); the record
  fields are `readonly` but the arrays/objects are not deep-frozen, so a
  same-process caller holding a stored record could mutate it in place
  (`forOp(id)[0].sig[0] = 255`). Real peer ingestion deserializes fresh values,
  so the wire path is safe; this is a substrate-wide in-memory-spike posture, to
  be addressed uniformly (freeze-on-store / immutable wire encoding at the store
  boundary) rather than piecemeal per package. (Provenance `verify` is
  signature-checked on read, so a mutated record renders `unverified` rather
  than silently trusted.) Freeze-on-store now ships at the persistence boundary
  (EncryptedObject/Op frozen on store + decoded fresh on load); the
  `Uint8Array`-index caveat remains, and a fully immutable wire encoding is
  still the end state.
- **Throughput envelope at scale (P06).** The brief's platform numbers —
  code.store's ~9M repos/30d, ~15K repos/min for 3h, zero downtime on an
  in-memory, horizontally-scaled, API-first engine — are an existence proof to
  _reproduce_, not load the spike generates or tests. P06 builds the API _shape_
  that envelope proves (one-call `createRepo`, bare-push scope creation);
  matching the load is a real "do it great" target, deferred.

### Scope-cut — planned for a later pillar/release (no open unknowns)

- **P03 content merge** — 3-way text/content merge for concurrent same-path ops;
  today LWW picks a deterministic winner and `conflicts()` surfaces the rest.
- **Rename/move as a first-class op (P08)** — currently two unlinked path-ops.
- **Symbol-level addressing (P08)** — `Op.path` generalizes to a symbol id.
- **Repository-as-capability-scoped-slice (P05)** — the repo dissolution half of
  Pillar 03's "branches and the repository dissolve."
- **Vector/interval clocks** — Lamport + DAG suffice for the spike's ordering.
- **P06 platform**, **P07 federation/reputation**, **P08 semantic graph**, **P09
  agents**, **P10 review-as-policy**, **P11 live database** — Tiers 2–4.
- **Rich review/reputation merge policy (P06→P10).** P06 ships landing as a
  re-point gated by a pluggable `LandPolicy` (`allowAll`, `blockOnConflict`,
  `requireVerifiedProvenance`); the semantic/behavioral-diff, test/proof, and
  reputation-tier gates — and the standing human veto — are Pillar 10 over the
  same `LandProposal → LandDecision` seam.
- **`sync()` of the pinned base (P05).** A workspace's base does not advance to
  absorb newer source-view heads; the lifecycle this release is open → edit →
  commit → discard.
- **Discoverability-as-query (P06→P03/P08/P11).** Date-range history
  (`log --since/--until`), release-to-release `diff`, and `next <tag>` need a
  wall-clock timestamp on `Op` (today it carries only a Lamport clock) or the
  semantic graph of P08. The query _surface_ is platform/live-DB territory; the
  missing field is a P03 change. Deferred until one of those lands.
- **Typed Release objects (P06).** A signed
  `Release { tag, at, signed_by, commits, artifacts }` record and its rendered
  page — a clean follow-on slice. Landing-as-policy already delivers "a release
  is a policy event" in miniature; the typed record is deferred.
- **Mirror / peer transport & federation (P06→P07).** This release asserts the
  _mirror property_ — a landed op is ciphertext a mirror can serve via
  `OpLog.publicView` — but ships no network transport, peer pull/push, or
  instance federation. Serving views/ops between instances is
  platform/federation territory, deferred.
- **3-way content merge (P03/P05).** Concurrent same-path edits resolve by LWW
  and surface via `OpLog.conflicts()`; the FS adds no content merge.
- **`mv` / rename (P05→P08).** Path-level move is `rm` + `write`; semantic
  rename is the symbol-level op of Pillar 08.
- **Workspace-view GC and a grep index (P05).** Private views accumulate in the
  log's view map; `grep` is a linear scan. Both are spike non-goals.
- **Reputation accrual / outcomes (P04→P09).** The trust rule's second clause —
  invalid provenance "never counts toward an agent's reputation" — needs the
  reputation/outcomes machinery that does not yet exist. P04 ships the
  `verified`/`unverified` label only; accrual is Pillar 09.
- **Delegation / attestation (P04→P09).** P04 verifies that _some_ did:key
  signed and bound an op id (actor may differ from op.author), but not that an
  agent was authorized to act _for_ a principal. Authorization semantics are
  Pillar 09.
- **`--why` query surface (P04→P06/P11).** Querying provenance across history is
  a later pillar; P04 renders the why only in its demo.
- **Prompt-cap grant/revoke wiring (P04).** Storing the prompt capability-gated
  is built; granting it to reviewers and revoking a "why" reuse
  `store.grant`/`revoke` but are not wired in this release.
- **Unverified-record spam control (P04).** Keep-and-label lets a peer attach
  unlimited unsigned claims to an op id; rate-limiting/scoping is out of spike
  scope.
- **Git gateway** — emit a Git history (commits/blobs/branches) for
  compatibility.
- **Release / event triggers for reveal** — only `timestamp` + `manual` planned
  for the P02 spike; `release(tag)` and `event` triggers come later.
- **Persistence backends (Store + OpLog) — shipped** as `@thaddeus.run/persist`
  (filesystem + in-memory). Still deferred: **signed-record-log persistence**
  (provenance/reputation/agent), **SQLite/S3 backends**, **compaction/GC**, and
  **multi-process concurrency/locking/WAL** (durable, not concurrent).
- **Server / network API — shipped** as `@thaddeus.run/server` (single node).
  Still deferred: **multi-node concurrency** (optimistic-concurrency on the
  `land` re-point + the `scope()` delimiter-encode), a **grant list / richer
  ACLs** (owner-only writes today), **replay-proof request nonces** (a signed
  timestamp window today), **TLS / deployment**, and **incremental pull /
  pagination**.
- **Client SDK + CLI — shipped** as `@thaddeus.run/client` + `@thaddeus.run/cli`
  (single-owner, online, full-set sync). Still deferred: multi-writer /
  agent-delegation CLI, incremental/offline sync, conflict-resolution UX,
  `log`/`diff`/`--json`, and a published-binary install story.
- **Git gateway** — emit a Git history (commits/blobs/branches) for
  compatibility, over the durable/served substrate. The optional on-ramp, later.
- **Reputation network transport / federation wire (P07→later).** Cross-instance
  honoring is demonstrated with two in-memory `ReputationLog`s; the wire that
  ships contribution records (and P06's deferred view/op mirror) between real
  hosts is not built.
- **Two-party co-sign handshake (P07→later).** `signContribution` holds both the
  subject and host keys; the protocol by which a host proposes a record and the
  subject co-signs over the wire is deferred.
- **Reputation scoring / tiers (P07→P09/P10).** `profile` yields the attested
  set and per-kind counts; a derived score or trust tier a merge policy (P10) or
  agent gate (P09) would consume is deferred.
- **Auto-minting contributions from landings (P07).** Reputation stays decoupled
  (depends only on `identity`); wiring a P06 landing to emit a `'merge'`
  contribution is a platform/integration concern, shown only in the north-star
  and demo.
- **Contribution revocation, host allowlist / web-of-trust (P07).** No signed
  retraction; the spike treats every valid `host_sig` as attestation rather than
  distinguishing instances a verifier recognizes.
- **Agent reputation score / tiers (P09→P10).** P07 supplies the attested
  contribution records; the derived score that grants autonomy ("a
  high-reputation agent's change merges under policy") is Pillar 10's
  merge-policy input.
- **Agent economy / paid attestation (P09→later).** A priced third-party
  verification verdict that travels with a change, and any payment rail.
- **Per-symbol capability scope (P09→P08).** `Delegation.paths` is path-glob
  only; per-symbol scope needs the semantic graph.
- **Per-hour rate windowing & time-expiry (P09→later).** `maxChanges` is a
  lifetime count cap; per-hour rate and `not_after` delegation expiry need
  wall-clock. Sub-delegation chains are also deferred.

### Honest limitations of what currently ships (P01)

- **Revocation cannot un-read.** Rotation stops _future_ decryption of the
  re-keyed object; it cannot recall plaintext already read, and an offline
  grantee keeps the old key until re-sync.
- **No key recovery.** Single keypair by design for v1.
- **In-memory only**, single process — not durable, not concurrency-safe.
- **Third-party crypto/throughput claims** in the brief are targets to
  reproduce, not independently verified here.
