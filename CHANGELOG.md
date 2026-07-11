# Changelog

All notable changes to Thaddeus. Format follows
[Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added

- **P9 agent rate windows.** Delegations accept an optional signed
  `maxChangesPerHour`; `thaddeus grant <did> --max-changes-per-hour N` caps how
  many ops the agent may land within any trailing hour, composing with the
  lifetime `--max-changes` cap. Enforcement is server-side at land with a
  distinct rejection reason. Records without the field sign the exact legacy
  tuple, so every existing grant keeps verifying. The hourly window is
  in-memory: durable lifetime meters replay outside it, and a server restart
  forgets the current hour.

- **P8 Watch / Subscriptions.**
  `thaddeus watch [symbol] [--kind <event>]... [--interval <duration>] [--json]`
  now polls the existing atomic public-ciphertext pull route into an isolated
  in-memory mirror, takes a silent baseline, and streams line-oriented text or
  JSONL semantic events derived locally within the reader's decryption boundary.
  Optional symbol filters resolve to a stable id and follow verified signed
  remote renames; event-kind filters are repeatable. The command never changes
  checked-out files or the durable working-copy store, keeps diagnostics out of
  JSON stdout, retries transient polling failures sequentially without advancing
  the baseline, and aborts cleanly on Ctrl-C. Lazythad now refreshes public
  remote views every two seconds in a non-blocking, single-flight worker while
  preserving selection and last-known-good data. This is polling, not durable
  offline delivery, SSE/WebSockets, or server-side semantic processing.

- **P7 timed reveal.** Repo owners can schedule committed file content for
  public release with `thaddeus schedule-reveal <path> --at <ISO>` or trigger a
  due release with `thaddeus reveal <path>`. The client creates the signed
  public capability locally, the server persists it outside normal pull
  responses and scans due reveals every second, and fresh clones can decrypt
  released content through the well-known public membrane. Scheduling is
  idempotent, manual triggers cannot bypass the server clock, and
  rotate-and-recall preserves pending reveals across key changes. As documented
  by the P02 design, unattended reveal is store-honest: scheduling trusts the
  selected host not to unwrap or publish that file's capability early; trustless
  time-lock crypto remains deferred.

- **P6 query surface.** `thaddeus query` now exposes the existing `CodeDB` joins
  as `why`, `touched-since`, `by`, `callers`, and `references`, with stable JSON
  output, current-branch scoping, unique symbol/op prefixes, inclusive time
  windows, and decryption-bounded semantic answers. Queries are local and
  read-only over committed state; `thaddeus why` remains an alias.
- **Local lazythad query views.** Press `/` inside a matching working copy to
  run the five query forms through `thaddeus query --json` and browse results in
  the existing activity/detail panes. The remote browser remains keyless: the
  TUI invokes the CLI without a shell and never reads identity keys itself.

## [0.1.5-alpha] - 2026-07-09

### Added

- **P5 immutable signed releases.** Repositories can now publish policy-gated
  release records that bind an immutable tag to the server's committed view
  heads and reachable commit ids. Records carry signed notes and artifact
  metadata (URI, SHA-256, size, and media type) without uploading artifact
  bytes. Public list/detail routes, verified client methods, `thaddeus release`
  and `thaddeus releases`, JSON output, owner/delegate/allow-list creator
  policy, and optional host-attested release reputation are included.
- **`lazythad` release activity.** Press `t` to switch the middle and detail
  panes between the operation log and signed releases; refresh now loads both,
  and release detail shows its signer, view, history counts, notes, and
  artifacts.

### Fixed

- **Hosted deployment configuration matches the live Fly volume.** `fly.toml`
  now targets app `thaddeus` in `ams`, mounts the existing `data` volume at
  `/data`, and keeps host attestation enabled without renaming or migrating the
  volume.
- **`lazythad` decodes persisted pull records.** The client now unwraps the
  server's `tplv1` persistence envelope before decoding log entries, retains
  raw-JSON compatibility for older fixtures, and skips corrupt or unknown
  records without losing the rest of the view.

## [0.1.4-alpha] - 2026-07-09

### Added

- **P9 rotate-and-recall is pulled forward.** `thaddeus revoke <did>` now
  fetches the current remote branch into an internal inspect view, rotates every
  readable object to a new content key, uploads the recalled ciphertexts/caps in
  the owner-signed revoke request, and quarantines the DID on the server under
  one repo lock. Fresh clones no longer receive keys for recalled content.
- **P4 per-repo policy is selectable over the wire.** Repos now persist a
  versioned land policy under server metadata, readable with `thaddeus policy`
  and owner-selectable with `thaddeus policy set`/`clear` without a server
  restart. The server now wires the dormant policy gates into `land`: protected
  path restrictions, typed standing queries (`forbidDeletes`, `forbidPaths`),
  required verified provenance, and required verified checker provenance
  (`requirePassingChecks`).

## [0.1.3-alpha] - 2026-07-09

### Added

- **P3 conflict UX: views to look, workspaces to touch.** New
  `thaddeus show [--view <branch>] [path...]` inspects committed content without
  touching the working tree: no path lists readable files, paths print text
  content, and binary files are reported by size. `thaddeus diff` now supports
  read-only branch comparisons with explicit view flags (`--from <branch>` /
  `--to <branch>`, either side omitted = the current working copy's branch)
  while preserving the existing working-tree and `--staged` modes.
  `thaddeus land <branch> --dry-run [--json]` previews incoming ops and path
  conflicts without requiring a clean tree, calling server `land`, re-pointing a
  branch, or writing files. Remote views fetched for show/diff/dry-run are
  cached under an internal `land/inspect/...` view, so looking at a branch can
  never clobber the real branch view in a shared store; actual `land <branch>`
  now uses the same inspect cache for its source branch before asking the server
  to re-point.

### Fixed

- **`$HOME` no longer masquerades as a working copy.** `install.sh` installs the
  binaries into `~/.thaddeus/bin`, and `findRoot` matched any ancestor holding a
  `.thaddeus` _entry_ — so for everyone who installed with the official script,
  every directory under `$HOME` looked like a working copy. Repo commands run
  outside a real repo died on a raw `ENOENT … /.thaddeus/config.json` instead of
  saying "not a thaddeus working copy". A working copy is now identified by its
  `.thaddeus/config.json`, which is what actually defines one.
- **`thaddeus reputation` works from anywhere.** Reputation is _server_-wide,
  not repo-scoped, but the command demanded a working copy and ignored
  `--server`. It now resolves the server as `--server`, else the working copy
  you're standing in, else your saved default. (Only an attesting server —
  `serve --host` — co-signs merges, so a non-attesting one reports
  `attested: 0`.)

## [0.1.2-alpha] - 2026-07-09

### Added

- **Branches as copy-on-write workspaces — you never switch a tree (Pillar
  05).** A branch is a name over a head-set (it copies op ids, never files), and
  a working copy is now equally cheap: `thaddeus workspace <branch> [dir]` opens
  a branch as its **own directory over the origin's shared object store** — the
  new directory holds a config and materialized files, never a store copy. So
  working copies are effectively free and unlimited, the **same branch can be
  open in several directories at once** (what `git worktree` forbids), creating
  one never touches the origin (no clean-tree gate, no hijacked tree), and there
  is deliberately **no `checkout`** — `checkout`/`merge` exist only as stubs
  that teach the model. There is no merge ceremony either: **landing is the
  merge** — `thaddeus land <branch>` lands that branch's ops into the current
  one as a single re-point gated by the server's policy (conflict, delegation
  scope, standing veto, any reputation floor). New `branch` (list or create,
  `--json`); the working copy records its branch + shared-store pointer in
  `.thaddeus/config.json` (absent = `main` / own store, so older copies keep
  working), and `status` reports the branch. **Creating a branch introduces no
  operations**, so it bypasses the land policy via a create-only
  `POST /repos/:name/views` (409 if it exists — re-pointing a view must go
  through `land`, where the gates run); landing into a fresh view would
  otherwise have re-checked the entire history against a delegate's path/budget
  scope. `GET /repos/:name/views` lists branches; `OpLog` gains
  `views()`/`hasView()`, and every internal view (`land`'s dry-run and
  `incoming` frontiers) lives under a reserved `land/` prefix so it can never
  surface as a branch. Caveat: the shared store is single-process — don't run
  two thaddeus commands over it at the same instant.
- **Collaboration actually works: capability-sharing + `thaddeus pull`.** A
  `Delegation` conveyed _write_ authority only, so a granted collaborator cloned
  ciphertext it could not decrypt — and because `store.put` seals a new object's
  content key **only to its author**, the owner could not read a delegate's push
  either. Now `thaddeus grant` also re-wraps every object this working copy can
  read for the new member (`store.grant` + `PublicIdentity.fromDid` — a did:key
  embeds the public key, so no key exchange is needed), and every
  `push`/`rename` reshares its new objects to all members (owner + non-revoked
  delegates) before uploading. The server's `push` now **unions** pushed
  capabilities with the ones it already serves — but only when the ciphertext is
  unchanged, since a new ciphertext means a rotated content key — so a stale
  push can never erase a capability granted meanwhile. New `thaddeus pull`
  fetches landed changes into an **existing** working copy (previously the only
  way to get a teammate's work was to re-`clone`); it fast-forwards a clean,
  not-ahead copy, mirrors upstream deletions, and refuses otherwise. Reads are
  now **fail-soft**: a file your identity holds no capability for is skipped and
  reported by `status` instead of aborting `clone`/`status`/`diff` with
  `access denied`. `revoke` stops sharing keys with the revoked did going
  forward; already-shared content is not recalled (revocation cannot un-read —
  key rotation is a later addition).
- **`lazythad`: the log follows the repo cursor.** Arrowing the repo list now
  loads that repo's op log instead of requiring `Enter`. (An empty Log pane
  still means the selected repo has nothing landed on `main`.)
- **Server-side repo management: `thaddeus repos` + `thaddeus delete`.**
  `repos [--mine]` lists a server's repos — the mirror's `GET /repos` now
  includes each repo's owner DID (public info), and `--mine` filters to repos
  your identity owns. `delete <repo> --yes` removes a repo you own via an
  owner-gated `DELETE /repos/:name` (drops the repo's keys + evicts its caches).
  Irreversible — no GC/undo yet, and the server-wide reputation log is left
  intact; `--yes` is required so a fat-fingered name can't wipe a repo.

## [0.1.1-alpha] - 2026-07-08

### Added

- **A default server + `thaddeus use`.** Set a per-user default server once
  (`thaddeus use <url>`, stored in `~/.config/thaddeus/config.json`) instead of
  repeating it on every `create`/`clone`; bare `thaddeus use` shows it,
  `--clear` removes it. `create`/`clone` now resolve the server as
  `--server <url>` flag → a leading `https://` argument (back-compat with
  `create <server> <repo>`) → the saved default, and print a first-run hint when
  none is set. An **optional** official host is offered but never pre-filled:
  `thaddeus use --hosted` opts in to `https://ams1.thaddeus.run` — surfaced in
  the hint, `thaddeus help`, the release notes, and the docs, but always the
  user's explicit choice.
- **The working tree uses a `.thaddeusignore`, seeded from `.gitignore`.** On
  first use in a repo, if there's a `.gitignore` and no `.thaddeusignore`,
  Thaddeus creates a `.thaddeusignore` from it; from then on it reads **only**
  `.thaddeusignore` (edit that to change what Thaddeus ignores — a post-Git tool
  owns its own ignore file). `.git`, `.thaddeus`, and `node_modules` are always
  pruned regardless. `status`/`diff`/`push` skip ignored paths with common
  gitignore semantics (names, `dir/`, `*.ext`, `/anchored`, `!negation`) — so
  versioning a real project (e.g. a vite app) no longer bundles hundreds of MB
  of dependencies (the cause of the slow `status` and the
  `413 Payload Too Large` on `push`). Nested ignore files are a later
  refinement.
- **`lazythad` uses your default server.** With no argument it falls back to the
  CLI's saved default (`thaddeus use`), then to `http://localhost:4000` — so
  `thaddeus use --hosted` points the TUI at the hosted server too.
- **Release automation & distribution.** A `release.yml` workflow (on a `v*`
  tag) cross-builds the `thaddeus` CLI (bun `--compile`, every OS/arch from one
  runner) and the `lazythad` TUI (cargo, one native runner per target) and
  publishes a GitHub Release with the binaries + `SHA256SUMS`. An `install.sh`
  (`curl … | sh`) downloads both and sets up `PATH`. Both tools are also
  installable from npm (`npm i -g @thaddeus.run/cli @thaddeus.run/lazythad`) via
  launcher packages that fetch the prebuilt binary (postinstall, with a
  download-on-first-run fallback); npm publishing is gated on an `NPM_TOKEN`
  secret.

### Fixed

- **CLI output no longer truncates on Windows.** The entrypoint returned its
  exit code via `process.exit()`, which can cut off buffered stdout/stderr on
  terminals whose stdio is an async pipe (e.g. an IDE's integrated PowerShell) —
  so a `status`/`push` that printed its result appeared to "do nothing". It now
  sets `process.exitCode` and lets the process end naturally, flushing all
  output first.
- **`push` no longer fails on Windows with `EPERM` during commit.** The
  `FileBackend`'s atomic temp+rename now retries on a transient lock
  (`EPERM`/`EBUSY`/`EACCES`) — a virus scanner or the Windows Search indexer
  briefly holding the destination no longer aborts a write.

## [0.1.0-alpha] - 2026-07-08

The first pre-alpha: all eleven pillars, the untrusted server, the installable
CLI, and the lazythad TUI.

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
- Multi-writer collaboration — a repo owner grants push/land to other DIDs and
  agents via owner-signed P09 `Delegation`s over the wire (`thaddeus grant`/
  `revoke`/`grants`; `POST /grants`, `POST /revoke`, `GET /grants`). The server
  holds a **durable per-repo `AgentRegistry`** (grants/meter/revocations rebuilt
  from the backend), widens push/land to **owner-or-delegate**, and enforces
  `delegationPolicy` per incoming op at land — paths and `maxChanges` (the owner
  is exempt; fail-closed; revocation terminal). `maxSpend` is carried but not
  yet metered (no cost model).
- `@thaddeus.run/review` — review as policy, proof, and reputation (Pillar 10):
  merge becomes a function of pluggable `LandPolicy` gates rather than one human
  reading a diff — a `requireReputationTier` gate (a landing must clear a
  reputation floor), a `requirePassingChecks` test/proof gate, and a standing
  human **veto** (`blockOnVeto` + the `Veto`/`VetoLog` records): retiring the
  mandatory diff review must not retire the veto. (Positive approval-required
  gate and a server-side review queue are deferred.)
- `@thaddeus.run/graph` — the semantic graph (Pillar 08): a `SymbolGraph` over a
  P05 `Workspace` projects symbols, definitions, references, and call edges from
  decryptable text — **decryption-bounded for free** (you only see the meaning
  of code you can decrypt). Code is addressed by a stable `Symbol.id` (minted
  once at birth, retained across renames by a `SymbolLedger`), and **rename is a
  first-class operation**: one signed `SymbolOp` rendered across the definition
  and every reference (the N text ops are its rendering), not a thousand-line
  find-and-replace. Extraction is one heuristic language behind a rigid
  `Extractor` seam (a real tree-sitter/LSP parser drops in there); text stays
  the universal fallback. A stale rename (the symbol moved under you) is
  rejected. The north-star now renames a symbol as one signed op with a
  provenance "why" (9 pass / 0 todo).
- `@thaddeus.run/log` — a signed **wall-clock timestamp** on `Op` (Pillar 03
  extension, `op.at`, ISO-8601 UTC). Covered by the op signature
  (tamper-evident, domain tag bumped to `thaddeus.log.op.v2`) and stamped by
  `OpLog.write`/`remove` (a caller may pin `at` for deterministic tests;
  otherwise the current wall-clock). It is **descriptive metadata only** —
  ordering and convergence remain `lamport` + the DAG, so clock skew can never
  break the merge. This is the field the P11 time-window queries need ("all code
  an untrusted agent touched in the last hour").
- `@thaddeus.run/query` — the live query surface (Pillar 11, **query slice**): a
  read-only `CodeDB` that **joins** the four first-class dimensions the
  substrate already stores — the semantic graph (P08), operation-log history
  with wall-clock time (P03), provenance (P04), and capabilities (P01) — into
  cross-cutting answers Git/GitHub cannot give: `why(opId)` (the signed
  `--why` + verification), `touchedSince`/`touchedBetween` (time-window),
  `by(did, window?)` (per-principal), `callers(symbolId)` (who-calls + defs),
  and `references(name)`. No new signed records; the graph half is
  decryption-bounded (inherited from the `Workspace` the `SymbolGraph` was built
  over). The north-star now queries the landed rename (`--why` + a caller
  lookup + a time-window). Subscriptions that fire on semantic events (P11
  Slice 2) and policy as standing queries (P11 Slice 3) followed — see below.
- `@thaddeus.run/watch` — live semantic subscriptions (Pillar 11,
  **subscriptions slice**): `SemanticWatcher.over(graph)` captures a baseline
  snapshot; `poll()` re-derives the semantic graph, **diffs** it against the
  baseline, and emits `SemanticEvent`s (`defined`/`removed`/`renamed`/`moved`/
  `references-changed`), dispatching each to the standing `Subscription`s whose
  `{ symbol?, kinds? }` filter it matches. Triggers fire on _meaning_ — "tell me
  when this symbol is renamed / a reference is added" — not on file paths; the
  detection inherits the graph's decryption boundary. Pull-based (events surface
  on `poll()`, reentrancy-safe); a push/webhook transport and incremental
  (non-full-re-derive) diffing are deferred. The north-star now fires a
  subscription on a rename.
- `@thaddeus.run/platform` — policy as standing queries (Pillar 11, **Slice
  3**): `standingQuery` and `restrictPaths` `LandPolicy`s alongside the P06/P10
  gates. A standing query expresses an invariant as a predicate over the
  proposed change and the substrate enforces it **as changes converge** at land
  — not a CI script that runs late. `restrictPaths` is the manifesto's headline
  — "no untrusted agent may modify auth code": reject a landing whose op touches
  a protected path (glob) unless its author is in the `allow` set (fail-closed
  on a `..` traversal path; misconfiguration rejected at construction). The
  north-star now rejects a stranger's landing to `src/auth/**` while allowing
  the owner's. **With this, all three Pillar 11 slices — query, subscriptions,
  standing-query policy — are complete.**
- **The meaning layers now travel the wire, durably.** Beyond the code (P01
  objects, P03 ops) and the signed "why" (P04, the template), the substrate's
  full meaning now persists and transmits: the standing human **veto** (P10), a
  server-wide **reputation** of attested contributions (P07), and the signed
  **semantic-graph ops** (P08). Each log gained the same four-part seam — a
  durable `Backend` (write-through under a content-addressed key + a static
  `load` that skips torn records), an optional array on the wire `Bundle` (or
  the land body, for reputation claims), a per-repo single-flight server cache
  that ingests on push and returns on pull, and client/CLI verbs. The server can
  now **attest**: given an optional `host` identity it co-signs a client's
  reputation claim on land (minting a host-vouched `'merge'`), and
  `--min-merges` gates a land on that durable, server-wide reputation. New CLI
  verbs: `veto`/`vetoes`, `reputation`, `serve --host`/`--min-merges`, and
  `rename`/`history` (a signed `SymbolOp` that rewrites the code and travels to
  a fresh clone). Restart proofs for each layer: a pushed veto still blocks a
  land, an attested merge still counts, a rename's `SymbolOp` still serves — all
  across a new `createServer` over the same durable dir. The server now
  carries + persists the whole substrate (code + why + veto + reputation +
  symbol-ops), optionally attesting.
- **`@thaddeus.run/cli` — a real, installable tool.** `bun build --compile`
  (moon task `cli:compile`) emits a self-contained `thaddeus` executable that
  needs no Bun at runtime — output to `release/` (gitignored, never in the npm
  tarball); cross-platform binaries via `--target`. New surface: `--version`
  (read from `package.json` at build time), structured per-command help
  (`thaddeus help <cmd>` / `<cmd> --help`), `whoami`, `thaddeus diff` (an LCS
  line diff of the working tree vs base, or `--staged` for committed-but-
  unpublished), and `log --since/--until` filtering on the signed `op.at`. A
  `--json` mode on the read verbs (`status`, `diff`, `log`, `why`, `vetoes`,
  `grants`, `reputation`, `whoami`) makes the CLI scriptable / TUI-ready. A
  smoke test compiles the binary and runs `--version`/`--help`. Publish-metadata
  pass across `@thaddeus.run/*` (dropped the retired `strata` keyword,
  de-Strata'd two descriptions). Still deferred: multiple remotes and a
  per-platform release matrix (the commands are documented in `cli:compile`).
- **`lazythad` — a Rust/ratatui terminal UI.** A lazygit-style browser for
  Thaddeus (a standalone Cargo crate at `lazythad/`, toolchain pinned in
  `.prototools`, its own CI job). Because reads are a public mirror, it holds no
  keys and does no decryption: three panes (repos · op log · detail) show the op
  log newest-first with a ⛔ marker for a vetoed op, the signed why, veto
  claims, and — over an overlay — a DID's reputation, all over
  `GET /repos`/`…/pull`/`/reputation/:did`. Keyboard-driven (`j`/`k`, `Tab`,
  `Enter`, `r`, `R`, `q`), plus a headless `--dump` text mode and
  `--version`/`--help`. Read-mostly; write actions (`land`, `veto`) need the
  ed25519 signed-request envelope in Rust and are a fast-follow.

### Changed

- Re-scoped packages `@thaddeus/*` → `@thaddeus.run/*`; renamed the `core`
  placeholder package to `store`.
- Completed the repo-wide **Strata → Thaddeus** rename in forward-facing copy
  (docs, specs, package READMEs/comments, apps), retiring the working name
  everywhere except the sentences that record the retirement itself.

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
- **Multi-language / real parser (P08→research)** — the `HeuristicExtractor`
  recognizes one dialect (`fn <name>(` defs, `<name>(` calls) with no scope,
  shadowing, or types; a real tree-sitter/LSP parser per language drops in
  behind the `Extractor` seam (aligns with the "Rust hot-path reimplementation …
  likely P03 and P08" research entry). Text is the universal fallback.
- **Type edges & structural ops beyond rename (P08)** — `Edge` ships
  `calls`/`references` only; `change-signature`/`move-definition`/
  `extract-function` share the `SymbolOp` record shape but are not built.
- **Whole-program call graph (P08)** — `callersOf` is best-effort within the
  decryptable, single-language view; no cross-language whole-program resolution.
- **Per-symbol capability scope (P08 × P01/P02)** — the brief's "hide one
  function inside a public file"; capability-scoping at symbol granularity is a
  later integration pass.
- **`SymbolOp` durability / federation (P08) — shipped.** `SymbolOpLog` now
  persists write-through under a content-addressed `symop/` key and ingests over
  the wire (a rename's `SymbolOp` travels to a clone and survives a restart). A
  peer — fresh or already serving reads — restores stable ids from verified
  rename chains that unambiguously match its projected definitions; claims that
  cannot apply yet (contended targets, unlanded renames, ambiguous or
  search-budget-exceeding routes) keep their targets provisional and retry on
  later synchronization instead of minting fresh identities. `thaddeus rename`
  hydrates from the durable `SymbolOp` log before resolving, so chained renames
  across separate invocations stay one identity under the birth id. Still
  deferred: an explicit causal sequence/base chain for resolving divergent or
  non-causal histories that cannot be matched unambiguously (spec §11).
- **Structural conflict-as-function (P08→P10)** — only staleness (`from`
  mismatch) is checked; real "conflict iff a contract broke" (signature
  compatibility across callers) is P10 territory.
- **Repository-as-capability-scoped-slice (P05)** — the repo dissolution half of
  Pillar 03's "branches and the repository dissolve."
- **Vector/interval clocks** — Lamport + DAG suffice for the spike's ordering.
- **P11 live database** — the last unbuilt pillar (Tier 4): a live, subscribable
  code database over P08's semantic read model (triggers that fire on meaning,
  the `--why` history query surface).
- **Rich review/reputation merge policy (P06→P10) — shipped** as
  `@thaddeus.run/review` (P10): the reputation-tier gate, the test/proof gate,
  and the standing human veto over the `LandProposal → LandDecision` seam. Still
  deferred: the positive approval-required gate and a server-side review queue.
- **`sync()` of the pinned base (P05).** A workspace's base does not advance to
  absorb newer source-view heads; the lifecycle this release is open → edit →
  commit → discard.
- **Discoverability-as-query (P06→P08/P11) — shipped.** The P03 prerequisite
  (signed `op.at`) and the **query surface** both landed: `@thaddeus.run/query`
  `CodeDB` joins the timestamp, the semantic graph (P08), provenance (P04), and
  capabilities into answerable cross-cutting questions. What remains for a full
  Pillar 11 is Slice 2 (subscriptions that fire on semantic events) and Slice 3
  (policy as standing queries) — see below.
- **P11 cross-cutting deferrals.** All three Pillar 11 slices — query,
  subscriptions, standing-query policy — shipped; what remains is depth, not
  breadth: a push/webhook transport and incremental (non-full-re-derive) diffing
  for subscriptions; `signature-changed` detection and symbol-level standing
  queries (both need a real parser / the graph over the proposed state, not the
  heuristic extractor and paths); and for the query surface, incremental/indexed
  derivation (millisecond scale), a durable query store, and behavioral-diff
  across full history (present-state only today).
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
  (filesystem + in-memory). **Signed-record-log persistence** now ships too:
  provenance (P04), veto (P10), reputation (P07), and symbol-ops (P08) all write
  through their backend and reload; the agent registry was already durable.
  Still deferred: **SQLite/S3 backends**, **compaction/GC**, and **multi-process
  concurrency/locking/WAL** (durable, not concurrent). **Planned next: an
  S3-compatible `Backend`** (AWS S3 / Cloudflare R2 / MinIO) so the server's
  state moves off local disk — the portability + scale lever that lets the same
  container run against any object store and behind multiple replicas.
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
- **Reputation network transport / federation wire (P07→later) — shipped.** The
  server holds a durable, server-wide `ReputationLog`; a client ships a
  subject-signed contribution claim in the land body and an attesting `host`
  co-signs it on land, minting a host-vouched merge that survives a restart and
  gates a land via `--min-merges`. Still deferred: cross-INSTANCE federation
  (honoring another host's records over a peer wire) and a host allowlist /
  web-of-trust.
- **Two-party co-sign handshake (P07→later).** `signContribution` holds both the
  subject and host keys; the protocol by which a host proposes a record and the
  subject co-signs over the wire is deferred.
- **Reputation scoring / tiers (P07→P09/P10).** `profile` yields the attested
  set and per-kind counts; a derived score or trust tier a merge policy (P10) or
  agent gate (P09) would consume is deferred.
- **Auto-minting contributions from landings (P07) — shipped.** An attesting
  server mints a host-vouched `'merge'` for each landed op whose author pushed a
  matching claim (it checks `subject === op.author`). The reputation package
  stays decoupled (depends only on `identity` + `store`); the land→mint wiring
  lives in the server.
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
