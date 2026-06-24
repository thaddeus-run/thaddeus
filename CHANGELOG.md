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
  than silently trusted.)

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
- **Landing / merge onto a shared view (P05→P06/P10).** `commit` lands ops on
  the workspace's private view; re-pointing a shared view like `main` to include
  them (and the conflict resolution that implies) is platform/review territory.
- **`sync()` of the pinned base (P05).** A workspace's base does not advance to
  absorb newer source-view heads; the lifecycle this release is open → edit →
  commit → discard.
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
- **Persistence backends, federation, agent reputation/economy** — beyond the
  in-memory spike.

### Honest limitations of what currently ships (P01)

- **Revocation cannot un-read.** Rotation stops _future_ decryption of the
  re-keyed object; it cannot recall plaintext already read, and an offline
  grantee keeps the old key until re-sync.
- **No key recovery.** Single keypair by design for v1.
- **In-memory only**, single process — not durable, not concurrency-safe.
- **Third-party crypto/throughput claims** in the brief are targets to
  reproduce, not independently verified here.
