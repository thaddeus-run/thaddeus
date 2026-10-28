# Agent-first architecture and migration contract

Status: ratified by [THA-33](https://linear.app/thaddeus-run/issue/THA-33) on
2026-10-16. It supersedes the scope of the issues rewritten under the October 16
architecture redesign. The [proposal draft](https://dk5l5qzsxoxv.postplan.dev)
stays online as discussion history, and this file is the ratified text.

Thaddeus is built first for large-scale parallel agent development. The design
target is 1,000 or more agents editing one repository at once, each in an
isolated workspace. This document records what that means for the product, the
trust model, the architecture, the build order and existing encrypted
repositories. Shipped behaviour is described in the present tense. Direction is
labelled as direction.

## 1. Product decisions

| Decision          | Choice                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Core model        | Isolated lightweight workspaces over shared code, with structured editing, durable checkpoints and controlled integration. |
| Hosting           | Thaddeus-hosted first. Customer hosting later.                                                                             |
| Agents            | External agents connect first. First-party orchestration comes later.                                                      |
| Local folders     | Compatibility stays, but local folders do not set the design.                                                              |
| Workspace sharing | Separate by default. Sharing is explicit.                                                                                  |
| Saving            | Automatic saves in small batches, plus explicit named checkpoints for review and integration.                              |
| Integration       | Path and project rules govern it. Integration agents resolve conflicts within those rules and escalate exceptions.         |
| Scale             | 1,000 or more simultaneous agents on one repository.                                                                       |
| Work tracking     | One ordered Linear queue, with no daily cycle and no due dates.                                                            |

Decided in ADR 0004. See
[hosted remote workspaces and external agents come first](adr/0004-hosted-workspaces-and-external-agents-first.md).

## 2. Trust model

### Today, as shipped

The open-source server holds no repository keys. It verifies signed uploads,
serves a ciphertext mirror, and accepts a landing only when the repository owner
signs it. Timed reveal is the known exception, because the chosen host holds a
publishable key until the reveal time. [ARCHITECTURE.md](../ARCHITECTURE.md)
describes this in full.

### Direction

[ADR 0003](adr/0003-trusted-code-processing-service.md) adopts a trusted service
that processes plaintext for authorized requests. These guarantees stay:

1. Scoped authority. Read, edit, execute, review and integrate are separate
   scopes. Authorization covers reads, queries, logs, caches and subscriptions.
2. Encrypted storage with service-managed keys.
3. Short-lived scoped credentials for agents and revocable sessions for humans.
4. Audit records for plaintext access and for history advancement.
5. Tenant isolation for untrusted execution. Secrets are scoped execution
   inputs, never source files.
6. Attribution as a signed declaration by the actor, as in
   [ADR 0001](adr/0001-actor-attribution-is-a-declaration.md). Activity the
   service records is never presented as an agent signature.

Two alternatives lost. Encrypted storage with separately trusted compute made
key distribution too complex for what it protected. A host that cannot decrypt
rules out browsing, search and execution.

## 3. Components and responsibilities

| Component                  | Responsible for                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| Workspaces and storage     | Isolated workspaces over immutable base revisions, durable saves and named checkpoints.     |
| Semantic engine            | The symbol model, structured edits and semantic queries at exact revisions.                 |
| Integration service        | Testing candidates at exact revisions and advancing shared heads under policy.              |
| Isolated execution workers | Builds and tests for checkpoints, isolated from other tenants and from service credentials. |
| Durable repository store   | Immutable objects, history and the records the other components rebuild from.               |

These are lines of responsibility. They need not be separate deployments.

### Today, as shipped

`thaddeus workspace` opens a branch as a local copy-on-write working copy over
one shared object store. The shipped server writes durable state through to its
storage backend. Per-node caches and counters live in process memory, and the
backend has no conditional-write contract yet, so this document makes no
multi-node correctness claim.
[THA-15](https://linear.app/thaddeus-run/issue/THA-15),
[THA-69](https://linear.app/thaddeus-run/issue/THA-69) and
[THA-68](https://linear.app/thaddeus-run/issue/THA-68) own that work.

### Direction

Nothing below has shipped.
[THA-152](https://linear.app/thaddeus-run/issue/THA-152) owns remote workspaces,
[THA-153](https://linear.app/thaddeus-run/issue/THA-153) owns saves and
checkpoints, and [THA-155](https://linear.app/thaddeus-run/issue/THA-155) owns
integration agents. Execution workers and the development interface are ThadHub
work, which lives under `ee/` and is source-available under the Functional
Source License (`ee/LICENSE`) rather than Apache-2.0.

**Workspaces.** A workspace points at an immutable base revision and stores only
what changed. Each save carries a retry identifier and a sequence number, and
the service acknowledges a save only after it is durably committed. Named
checkpoints bind an exact revision to the journal entry that produced it. Base
updates happen only at explicit safe boundaries. Shared workspaces need
version-checked writes, so the last writer never silently wins.

**Execution.** Build and test workers attach on demand. Their concurrency has
its own limit, separate from the number of workspaces. Suspension keeps files
and environment definitions. Resuming the exact process is deferred.

**Integration.** Integration agents work in isolated workspaces under path
authority, compute budgets and a cap on attempts. Each candidate is tested at an
exact revision, and the shared head advances atomically. Independent
repositories never wait on a shared landing lock.

**Development interface.** A minimal authenticated ThadHub interface, limited to
development users, shows five views. This is ThadHub product work: it lives
under `ee/` and is licensed under the Functional Source License, not Apache-2.0.

1. Repository file browsing.
2. Agents, workspace bases, pending saves and checkpoints.
3. Symbols, structured edits and stale-index state.
4. Build and test runs, integration attempts and approvals.
5. Suspension, retries, queue delay and resource usage.

## 4. Semantic editing is an early delivery requirement

Structured editing ships in the first useful release. That covers symbol rename,
function edits and symbol-scoped authority. Agents working in parallel need
edits that a stale view of the code cannot invalidate, so this cannot wait for a
later layer.

[THA-113](https://linear.app/thaddeus-run/issue/THA-113), mirrored on GitHub as
[#169](https://github.com/thaddeus-run/thaddeus/issues/169), decided the model
on 2026-10-18 in
[ADR 0005](adr/0005-content-journal-is-the-semantic-authority.md). The
[semantic authority design](specs/2026-10-18-thaddeus-semantic-authority-design.md)
holds the rules, the comparison with a graph-authoritative model and the
observed baseline. None of it is implemented yet.

- Immutable file content plus a change journal per workspace is the source of
  truth.
- The symbol graph is a projection tied to a journal entry, a revision and an
  analyzer version, and the system can rebuild it.
- File edits and structured edits go through one transaction path. Each
  transaction commits as one journal entry that records the intent, the byte
  edits it produced and the resulting content.
- Bytes nobody asked to change stay byte-identical. That holds for comments,
  formatting, files no analyzer reads, files that do not parse and generated
  files.
- A symbol keeps its identity only through renames and moves that an edit
  declares.
- A stale or partial graph cannot authorize a structured edit.
- TypeScript and JavaScript are the proposed first language family, pending
  [THA-36](https://linear.app/thaddeus-run/issue/THA-36).

The
[semantic graph design](specs/2026-07-07-thaddeus-pillar-08-semantic-graph-design.md)
describes the shipped spike. Section 10 of the new design says which of its
decisions still stand.

## 5. Performance: targets versus measurements

A target is a number a build is held to. A measurement is a number someone
observed in a named benchmark environment with a recorded method. Documents in
this repository may cite a target only with the word "target" next to it. They
may cite a measurement only with a link to the run that produced it.

| Target                                          | Value                                                                | Measured | Owner                                                                   | Benchmark                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Cold install or checkout                        | Sub-second on any OS                                                 | No       | THA-117 defines it, THA-5 measures it                                   | `e2e.checkout.cold` with `pageCache: "dropped"`, on the serial fixture                 |
| Repository or scope creation, ready to push     | Single-digit milliseconds                                            | No       | THA-117, THA-5                                                          | `repo.create` and `e2e.repo.create`                                                    |
| Query over repository history                   | Milliseconds                                                         | No       | THA-117, THA-5                                                          | `codedb.touchedSince` and `codedb.why`                                                 |
| Repository creation throughput under agent load | About 15,000 per minute, sustained, with no downtime                 | No       | THA-117, THA-5                                                          | `e2e.repos-per-minute`, a floor, not agent load                                        |
| Simultaneous agents on one repository           | 1,000 or more                                                        | No       | THA-117 defines it, THA-130 qualifies it                                | not measured here (THA-130)                                                            |
| Everyday `status`, 10 changed files             | 50 ms target, no slower than git (agents: 100 ms target, 8 at once)  | No       | THA-158 defines it, the owner in `bench/budgets/everyday.json` fixes it | `wc.status` against `git.status`, and `wc.status.agents8` against `git.status.agents8` |
| Everyday `diff`, 10 changed files               | 100 ms target, no slower than git (agents: 200 ms target, 8 at once) | No       | THA-158 defines it, the owner in `bench/budgets/everyday.json` fixes it | `wc.diff` against `git.diff`, and `wc.diff.agents8` against `git.diff.agents8`         |
| Everyday commit of 10 files                     | 1 s target, no slower than git                                       | No       | THA-158 defines it, the owner in `bench/budgets/everyday.json` fixes it | `e2e.push.10` against `git.commit`                                                     |
| Everyday checkout of a branch                   | 1 s target, no slower than git                                       | No       | THA-158 defines it, the owner in `bench/budgets/everyday.json` fixes it | `e2e.workspace` against `git.worktree`                                                 |
| Everyday pull or sync of a 10-file change       | 5 s target, no slower than git                                       | No       | THA-158 defines it, the owner in `bench/budgets/everyday.json` fixes it | `e2e.pull` against `git.pull`                                                          |
| CI checkout, cold                               | 1 s target, no slower than git                                       | No       | THA-158 defines it, the owner in `bench/budgets/everyday.json` fixes it | `e2e.checkout.cold` with `pageCache: "dropped"` against `git.clone`                    |
| Everyday rebase                                 | 2 s target, no slower than git                                       | No       | THA-158 defines it, the owner in `bench/budgets/everyday.json` fixes it | not measured here (THA-11, thaddeus has no rebase)                                     |

The everyday-command rows come from
[`bench/budgets/everyday.json`](../bench/budgets/everyday.json), which also
holds the agent variants and the fixture each target is about. A required CI
job, the everyday-command latency gate, holds each case to a ceiling calibrated
on CI runners. A ceiling stops a command from getting slower than its calibrated
ceiling on CI runners. It is not one of these targets. See
[the benchmark README](../bench/README.md#everyday-command-budgets-and-the-ci-gate).

The website follows the same rule as repository documents. A measured figure on
the website links to a committed file under `bench/results/` that names the
machine, commit, fixture, method and repeat count. Anything not measured carries
the word "target". The benchmark suite in [`bench/`](../bench/README.md)
produces those files, and the Benchmark column above names the case that
measures each target.

Cold and warm paths get separate reports. One hot repository and many
independent repositories are separate workloads with separate benchmarks. An
architecture diagram supports no scale claim. The first four rows restate the
floor table in [the manifesto](../the-new-age-of-source-control.html), which
predates any measurement. The agent count comes from ADR 0004.

## 6. Build queue

The Linear view **Thaddeus build order**, sorted by title ascending, is the
single source of order. Every title starts with a three-digit number. There are
no cycles, milestones or due dates. The table copies the order as of 2026-10-16
for readers without Linear access, and whoever changes the order refreshes it.
Rows marked "ThadHub, private" are product work that lives under `ee/` and is
source-available under the Functional Source License (`ee/LICENSE`), not
Apache-2.0.

| Order | Issue                                                    | Title                                                                                          |
| ----- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 001   | [THA-29](https://linear.app/thaddeus-run/issue/THA-29)   | DX: fix getting-started clone-path bug, version drift, and ship a runnable agent-governed demo |
| 002   | [THA-33](https://linear.app/thaddeus-run/issue/THA-33)   | PRODUCT: establish the agent-first architecture and migration contract                         |
| 003   | [THA-113](https://linear.app/thaddeus-run/issue/THA-113) | DECISION: define semantic authority and mixed-edit transactions                                |
| 004   | THA-117                                                  | PERF: define the 1,000-agent hot-repository workload and scale contract. ThadHub, private      |
| 005   | [THA-5](https://linear.app/thaddeus-run/issue/THA-5)     | P11: Reproducible benchmark suite + FileBackend baseline                                       |
| 006   | [THA-118](https://linear.app/thaddeus-run/issue/THA-118) | PERF: replayable agent workload and fault harness                                              |
| 007   | [THA-150](https://linear.app/thaddeus-run/issue/THA-150) | CORE: trusted-service authority and scoped agent sessions                                      |
| 008   | [THA-151](https://linear.app/thaddeus-run/issue/THA-151) | CORE: migrate encrypted repositories to trusted-service storage                                |
| 009   | THA-54                                                   | THADHUB: normal sign-in and revocable web sessions. ThadHub, private                           |
| 010   | THA-89                                                   | THADHUB: authenticated browser access and mutation boundary. ThadHub, private                  |
| 011   | THA-91                                                   | SECURITY: tenant, credential and plaintext-handling conformance. ThadHub, private              |
| 012   | THA-47                                                   | THADHUB: minimal development deployment and delivery pipeline. ThadHub, private                |
| 013   | THA-46                                                   | H0: namespace routing for handle/repository URLs. ThadHub, private                             |
| 014   | THA-48                                                   | THADHUB: real repository file browser for development. ThadHub, private                        |
| 015   | THA-93                                                   | THADHUB: private repository access and permission-aware browsing. ThadHub, private             |
| 016   | THA-50                                                   | H0: provenance why view. ThadHub, private                                                      |
| 017   | THA-90                                                   | H1: shared verified/unverified presentation contract across ThadHub. ThadHub, private          |
| 018   | [THA-15](https://linear.app/thaddeus-run/issue/THA-15)   | P14: Define backend CAS / conditional-write semantics                                          |
| 019   | [THA-16](https://linear.app/thaddeus-run/issue/THA-16)   | P14: S3-compatible backend (behind flag)                                                       |
| 020   | [THA-18](https://linear.app/thaddeus-run/issue/THA-18)   | P14: Backend conformance tests + migration/rollback + backup drills                            |
| 021   | [THA-67](https://linear.app/thaddeus-run/issue/THA-67)   | CORE: atomic, policy-authorized shared-head advancement                                        |
| 022   | [THA-70](https://linear.app/thaddeus-run/issue/THA-70)   | CORE: shared object caches and versioned derived caches                                        |
| 023   | [THA-69](https://linear.app/thaddeus-run/issue/THA-69)   | CORE: refuse multi-node startup without a CAS-capable backend                                  |
| 024   | [THA-68](https://linear.app/thaddeus-run/issue/THA-68)   | CORE: multi-node repository and workspace coordination                                         |
| 025   | [THA-152](https://linear.app/thaddeus-run/issue/THA-152) | CORE: remote workspace API for external agents                                                 |
| 026   | [THA-153](https://linear.app/thaddeus-run/issue/THA-153) | CORE: durable autosave batches and explicit checkpoints                                        |
| 027   | THA-154                                                  | THADHUB: live development workspace and semantic inspector. ThadHub, private                   |
| 028   | [THA-21](https://linear.app/thaddeus-run/issue/THA-21)   | PERF: fix OpLog O(n²) conflicts()/materialize() and graph/query full re-derivation             |
| 029   | [THA-36](https://linear.app/thaddeus-run/issue/THA-36)   | CORE: incremental semantic model with stable symbol identity                                   |
| 030   | [THA-42](https://linear.app/thaddeus-run/issue/THA-42)   | CORE: indexed repository and semantic queries with subscriptions                               |
| 031   | [THA-145](https://linear.app/thaddeus-run/issue/THA-145) | CORE: transactional symbol rename and function editing                                         |
| 032   | [THA-37](https://linear.app/thaddeus-run/issue/THA-37)   | CORE: revision-bound semantic diff and impact evidence                                         |
| 033   | [THA-115](https://linear.app/thaddeus-run/issue/THA-115) | CORE: symbol-scoped agent authority                                                            |
| 034   | [THA-148](https://linear.app/thaddeus-run/issue/THA-148) | CORE: server-side repository and semantic query API                                            |
| 035   | [THA-38](https://linear.app/thaddeus-run/issue/THA-38)   | CLI: implement missing query one-liners for path, tag diff, and next                           |
| 036   | THA-59                                                   | THADHUB: permission-aware repository metadata index. ThadHub, private                          |
| 037   | THA-60                                                   | THADHUB: code and symbol search over the core query API. ThadHub, private                      |
| 038   | THA-76                                                   | THADHUB: authorized private-code search. ThadHub, private                                      |
| 039   | THA-136                                                  | RUNNERS: isolate untrusted workspace execution. ThadHub, private                               |
| 040   | THA-140                                                  | RUNNERS: scoped secrets and workload credentials. ThadHub, private                             |
| 041   | [THA-132](https://linear.app/thaddeus-run/issue/THA-132) | CORE: portable checkpoint execution and check evidence                                         |
| 042   | THA-137                                                  | RUNNERS: on-demand checkpoint execution and persistent dev workers. ThadHub, private           |
| 043   | THA-139                                                  | RUNNERS: logs, artifacts and scoped execution caches. ThadHub, private                         |
| 044   | THA-66                                                   | THADHUB: run checkpoint checks and display execution evidence. ThadHub, private                |
| 045   | [THA-58](https://linear.app/thaddeus-run/issue/THA-58)   | CLI: verify repository integrity against independent checkpoints                               |
| 046   | [THA-11](https://linear.app/thaddeus-run/issue/THA-11)   | CORE: safe-checkpoint workspace base updates                                                   |
| 047   | [THA-12](https://linear.app/thaddeus-run/issue/THA-12)   | CORE: conflict inspection and three-way integration                                            |
| 048   | [THA-85](https://linear.app/thaddeus-run/issue/THA-85)   | CORE: workspace synchronization at explicit safe boundaries                                    |
| 049   | [THA-97](https://linear.app/thaddeus-run/issue/THA-97)   | CORE: path-sensitive integration policy and reviewer authority                                 |
| 050   | [THA-98](https://linear.app/thaddeus-run/issue/THA-98)   | CORE: review and integration queue contract                                                    |
| 051   | [THA-155](https://linear.app/thaddeus-run/issue/THA-155) | CORE: bounded integration-agent coordination                                                   |
| 052   | THA-55                                                   | THADHUB: review, veto and integration decisions. ThadHub, private                              |
| 053   | THA-57                                                   | THADHUB: agent access and revocation console. ThadHub, private                                 |
| 054   | THA-53                                                   | THADHUB: policy-authorized release creation. ThadHub, private                                  |
| 055   | THA-52                                                   | H0: release pages and manifests. ThadHub, private                                              |
| 056   | [THA-156](https://linear.app/thaddeus-run/issue/THA-156) | CORE: suspend, resume and discard remote workspaces                                            |
| 057   | [THA-157](https://linear.app/thaddeus-run/issue/THA-157) | CORE: bounded autosave retention and checkpoint garbage collection                             |
| 058   | [THA-41](https://linear.app/thaddeus-run/issue/THA-41)   | CORE: define the named virtual-filesystem API and evaluate FUSE                                |
| 059   | [THA-114](https://linear.app/thaddeus-run/issue/THA-114) | CORE: lightweight workspace filesystem and selective materialization                           |
| 060   | [THA-119](https://linear.app/thaddeus-run/issue/THA-119) | SPEC: authorized immutable-object and revision-manifest delivery                               |
| 061   | [THA-120](https://linear.app/thaddeus-run/issue/THA-120) | CORE: implement selective revision and object delivery                                         |
| 062   | THA-121                                                  | EDGE: scoped private-object delivery authorization. ThadHub, private                           |
| 063   | [THA-13](https://linear.app/thaddeus-run/issue/THA-13)   | CORE: sparse resumable synchronization and local-folder access                                 |
| 064   | [THA-25](https://linear.app/thaddeus-run/issue/THA-25)   | SECURITY: meter delegation maxSpend, or remove the field                                       |
| 065   | [THA-116](https://linear.app/thaddeus-run/issue/THA-116) | CORE: durable multi-node delegation expiry and budget accounting                               |
| 066   | THA-142                                                  | RUNNERS: scale execution with fairness and bounded queues. ThadHub, private                    |
| 067   | [THA-83](https://linear.app/thaddeus-run/issue/THA-83)   | SECURITY: consistent revocation across sessions, agents and workers                            |
| 068   | [THA-149](https://linear.app/thaddeus-run/issue/THA-149) | CORE: auditable bisect and signed or attributed revert                                         |
| 069   | [THA-130](https://linear.app/thaddeus-run/issue/THA-130) | PERF: qualify 1,000+ simultaneous agents on a populated repository                             |
| 070   | THA-131                                                  | RELEASE GATE: qualify hosted agent scale and recovery. ThadHub, private                        |
| 071   | [THA-32](https://linear.app/thaddeus-run/issue/THA-32)   | CORE: Git gateway for importing and exporting Git history                                      |
| 072   | [THA-74](https://linear.app/thaddeus-run/issue/THA-74)   | CLI: portable repository export and migration between trusted hosts                            |
| 073   | THA-82                                                   | THADHUB: customer-hosted deployment of the trusted service. ThadHub, private                   |

## 7. Superseded, rewritten and parked

**Superseded.** Mandatory extension key custody in
[THA-77](https://linear.app/thaddeus-run/issue/THA-77) and browser decryption in
[THA-75](https://linear.app/thaddeus-run/issue/THA-75).

**Rewritten.** Any constraint that assumed an unreadable host or owner-only
landing. Those issue descriptions now say "This description replaces the prior
scope under the October 16 architecture redesign", and each issue's history
keeps the earlier text.

**Parked.** Federation, reputation marketplaces, trending, billing polish, broad
workflow compatibility and exact-process suspension.

The
[Safe Agent Mode design](superpowers/specs/2026-07-23-safe-agent-mode-design.md)
remains a design. This contract leaves it unchanged.

## 8. Migration contract for existing encrypted repositories

Moving a repository from the keyless server to trusted-service storage follows
six rules. [THA-151](https://linear.app/thaddeus-run/issue/THA-151) owns
migration, and [THA-74](https://linear.app/thaddeus-run/issue/THA-74) owns
portable export.

1. Each repository's owner explicitly authorizes its migration.
2. No key is uploaded without the owner knowing, and no existing signature gets
   a new meaning.
3. Content moves into a versioned trusted-service format.
4. The migrated copy is compared against retained history before the old copy
   counts as migrated.
5. An export and rollback path exists before the first production migration.
6. Repositories that are not migrated keep working against the keyless server.

## 9. Verification standard

Every item in the build queue is verified the same way. Exercise the real user
path, failure and restart recovery, and a second identity or workspace. Record
what was observed, not what should happen. A performance target is never
evidence of current capability.

## Appendix: open work carried over from the P11 to P14 pipeline

Until October 2026, `CHANGELOG.md` tracked this pipeline against GitHub
milestones. It moved here when the Linear build order became the single queue.
The status below is the snapshot of 2026-09-11, checked against merged `main`
through `bba202f`. The Unreleased changelog has since recorded scoped reviewer
veto work under THA-6 and THA-24, which this snapshot predates. The five-lens
analysis and the ThadHub plan that accompanied the pipeline remain at
<https://4xibq00df3aj.postplan.dev/>.

These pipeline items now live in the build queue. The matches below are
confirmed by title. Other GitHub items in the snapshot have no confirmed build
queue identifier yet.

| GitHub issue                                        | Build queue item |
| --------------------------------------------------- | ---------------- |
| #58 benchmarks and FileBackend baseline             | 005, THA-5       |
| #68 backend CAS and conditional-write contract      | 018, THA-15      |
| #69 S3-compatible backend                           | 019, THA-16      |
| #71 conformance, migration, rollback, backup drills | 020, THA-18      |
| #74 op-log and graph algorithm fixes                | 028, THA-21      |
| #78 `maxSpend` metering or removal                  | 064, THA-25      |

| Phase     | Scope                                                                                                                                            | Status on 2026-09-11                             | Milestone and issues                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| P4 to P10 | Policy, releases, query surface, timed reveal, watch, agent budgets and rate windows, rotate-and-recall, portable reputation with `--trust-host` | Shipped through v0.1.9-alpha                     | None                                                                                                  |
| P11       | Hardening and proof: benchmarks, outside-reviewer veto, lazythad write actions                                                                   | In progress. #72 and #73 verified                | [P11](https://github.com/thaddeus-run/thaddeus/milestone/1). Open: #58, #59, #60, #74                 |
| P12       | Single-node security hardening                                                                                                                   | In progress. #61, #62, #75, #76 and #79 verified | [P12](https://github.com/thaddeus-run/thaddeus/milestone/2). Open: #77, #78. #63 needs reconciliation |
| P13       | Product and collaboration UX                                                                                                                     | Queued                                           | [P13](https://github.com/thaddeus-run/thaddeus/milestone/3). #64 to #67, #80, #82                     |
| P14       | Backend implementation behind flags: CAS, S3 and SQLite, conformance, migration                                                                  | Queued                                           | [P14](https://github.com/thaddeus-run/thaddeus/milestone/4). #68 to #71                               |

**P11, hardening and proof.** Capability and content integrity, #72, merged in
[PR #156](https://github.com/thaddeus-run/thaddeus/pull/156). Owner-signed
monotonic view heads, #73, merged in
[PR #203](https://github.com/thaddeus-run/thaddeus/pull/203). Both are verified.
Remaining work:

- The outside-reviewer veto and its allowlist, #59 and #77.
- Reproducible benchmarks and a FileBackend baseline, #58.
- Op-log and graph algorithm fixes and their measurements, #74.
- Signed land and veto actions in lazythad, #60.

The cross-client head-transparency log stays separate in #110. P11 is not
complete.

**P12, single-node security hardening.** Merged so far:

- Body limits, #75, in
  [PR #202](https://github.com/thaddeus-run/thaddeus/pull/202).
- Durable replay nonces, #61, in
  [PR #204](https://github.com/thaddeus-run/thaddeus/pull/204).
- Reputation trust, anti-farming and KMS controls, #79, in
  [PR #205](https://github.com/thaddeus-run/thaddeus/pull/205).
- Defensive limits and pagination, #62, in
  [PR #207](https://github.com/thaddeus-run/thaddeus/pull/207).
- Durable repository, object and byte quotas, creation windows and FileBackend
  sharding, #76, in
  [PR #211](https://github.com/thaddeus-run/thaddeus/pull/211). Compiled CLI and
  server verification followed in
  [PR #212](https://github.com/thaddeus-run/thaddeus/pull/212) with the
  [426-test evidence report](tha-147-verification.md).

Remaining work is veto authorization, #77, metering or removal of the no-op
`maxSpend`, #78, and general per-signer mutation, provenance and veto spam
limiting, #63 and THA-10. One tracking discrepancy stands. #63 is closed on
GitHub, but no implementing merged PR was found, and PR #211 and its
verification explicitly exclude THA-10. Keep that item unverified until its
status is reconciled. P12 is not complete.

**P13, product and collaboration UX.** In-place `thaddeus init` with offline
`commit`, #80. The getting-started clone-path fix, version drift and a runnable
agent-governed demo, #82, which has since shipped as THA-29. Then `track`,
workspace base sync, three-way merge, incremental and resumable pull, multiple
remotes, approval-required policy, the review queue and prompt-cap wiring, #64
to #67. The `query`, `watch` and `reveal` CLI wiring that was #81 shipped in
0.1.6-alpha, and #81 is closed.

**P14, backend implementation behind flags.** Define the backend CAS and
conditional-write contract first, #68, because an S3 adapter alone does not make
Thaddeus multi-node safe. Then the S3-compatible backend, #69, an optional
SQLite backend, #70, and conformance tests, migration, rollback and backup
drills, #71. None of this changes production infrastructure.

Everything through P14 is Part 1 and ships on the current single Fly node with
`FileBackend`. Part 2 is the production infrastructure change to S3 and multiple
nodes. These conditions gate any Part 2 change:

- P11 is complete.
- Performance is measured, #58.
- Backend conformance passes, #71.
- Migration and rollback are tested, #71.
- Atomic land and nonce semantics are specified and implemented, #61 and #68.
- A local MinIO multi-node test passes, #69.
- A backup restores successfully in a clean environment, #71.

A correction carried over from the changelog: the S3 backend was once cited as
"#14", but PR #14 was "Multi-writer collaboration: delegated push over P09" and
unrelated to storage. The S3 backend is tracked as #69 under milestone P14.
