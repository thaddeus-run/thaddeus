# THA-5 Benchmark Suite and FileBackend Baseline Design

**Date:** 2026-10-25 **Status:** Approved for planning **Issue:**
[THA-5](https://linear.app/thaddeus-run/issue/THA-5) (GitHub #58)

## Intent

Thaddeus has no benchmarks. The architecture contract
([§5](../../agent-first-architecture.md#5-performance-targets-versus-measurements))
lists five performance targets and marks every one "Measured: No". THA-5
measures what ships today on `FileBackend` and records it as the "before".

The results have two readers:

1. **Engineers and agents changing hot paths.** THA-21 (OpLog `conflicts()` /
   `materialize()` and graph re-derivation) needs a "before" to compare its
   "after" against. Every PR needs a check that catches slowdowns.
2. **Visitors to the website, later.** Any performance figure on the site must
   link to a committed result produced by this suite. THA-5 does not put numbers
   on the site. It produces results that are fit to be published.

## Goals

- A deterministic, versioned fixture generator (small, medium, stress, plus a
  growth sweep).
- Two suites: an in-process library suite and an end-to-end suite that drives
  the real CLI binary against a real server.
- JSON results with a schema, committed for the benchmark machine, recording
  latency, throughput, peak memory, on-disk size and growth exponents.
- A recorded `FileBackend` baseline from current `main`.
- The five §5 targets mapped to the benchmarks that measure them.
- A PR regression check whose thresholds come from a measured noise study, never
  a picked percentage.

## Non-goals

- Fixing any slow path. THA-21 and later issues rerun the suite and commit their
  "after".
- Adding fsync or any durability change to `FileBackend`.
- Comparing against git. The fixture format must allow it later (the same
  plaintext tree can be imported into git), but no git benchmark ships here.
- Agent workloads and 1,000-agent concurrency (THA-118, THA-130).
- Change-journal and projection benchmarks (ADR 0005); they arrive with that
  work.
- Publishing numbers on the website.

## Anti-goals

This work fails, even if it runs, if:

- A number can be produced without the machine, commit, fixture, method and
  repeat count attached to it.
- A write, push or land number from today's `FileBackend` can be read as a
  durable-write figure.
- The PR check fails on noise often enough that people learn to ignore it.
- A stress case hangs the run or is silently skipped because it is slow.
- Any target is invented for a metric that has no owner in §5.

## Decided

### Proof rule for published figures

Extend §5 of `docs/agent-first-architecture.md` to cover the website: a measured
figure links to a committed result file naming the machine, commit, fixture,
method and repeat count. Anything not measured is labelled "target". This edit
to §5 is part of THA-5.

### Terms

`CONTEXT.md` defines **Cold open** (loading a repository already on local disk,
nothing cached) and **Cold checkout** (producing a usable local copy from a
server into an empty directory). They are separate benchmarks. The §5 "cold
install or checkout" target maps to cold checkout.

### Two suites in one project

A new private moon project at `bench/` (next to `integration/`), package
`@thaddeus.run/bench`, `private: true`, never published.

**Library suite** (in-process, used by the PR check):

| Area               | Cases                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Objects            | `encrypt`/`decrypt` throughput by object size; `MemoryStore.put` and `ingest` on `FileBackend`; `get` with capability check |
| Op-log             | durable `write` (append), `ingest`, `materialize`, `heads`, `conflicts` per fixture and across the sweep                    |
| Cold open          | `Platform.openDurable` per fixture; also on a server root holding 1, 100 and 1,000 repositories                             |
| Repository         | repository creation, ready to push (`repo.create`, see below)                                                               |
| Query and graph    | coarse only: `SymbolGraph` `resolve`/`callersOf` and `CodeDB` `why`/`touchedSince`/`callers`, once per fixture size         |
| Reputation archive | `archive` + `encodeReputationArchive`; `decodeReputationArchive` + `ingestArchive`, by contribution count                   |

Query and graph get a coarse baseline only because ADR 0005 replaces the current
`SymbolGraph` with a projection rebuilt from the change journal.

_Changed during build:_ `repo.create` times `Platform.createDurable` plus the
bootstrap of the owner's signed genesis head (`headRecords.bootstrap`: verify
the head, then a durable write of the head record). This is what the server does
for a new repository, and a repository is only ready to push once its head
exists. The head is signed in setup, as the client signs it before sending. The
server-only `meta/repo` record is left to `e2e.repo.create`.

**End-to-end suite** (benchmark machine only): the compiled `thaddeus` binary
against `thaddeus serve` over loopback on the same host. Only end-to-end numbers
are candidates for the website. Results state that client and server share one
host.

The CLI cannot replay a fixture (one signing identity, wall-clock `at`,
owner-held signed heads), so setup and measurement are split:

1. **Seed, untimed.** The fixture generator writes the repository into the
   server's `FileBackend` data root through the library, in-process.

   _Changed during build:_ the e2e suite seeds a conflict-free "serial" variant
   of each fixture, not the library suite's plan, so it does not share the
   library suite's manifest hash. The shipped server refuses every land into a
   `main` that holds a conflict (`blockOnConflict` is the default policy), and
   the base plans land conflicts on purpose, so the base plan cannot be seeded
   through the shipped policy. In the serial plan each view forks from the
   current `main`, takes its share of the ops and lands before the next view
   forks. File, op, author and view counts are unchanged. The variant is part of
   the hashed spec and appears in the result as the fixture name
   (`small-serial`), so its results are a separate history from the library
   suite's. This keeps the determinism the shared hash was for, and keeps to the
   anti-goal of publishing no number from a repository that real use cannot
   produce.

2. **Serve.** Start `thaddeus serve` on that root.
3. **Measure, timed, real CLI only:**
   - cold checkout: `clone` of the seeded repository into an empty directory
     (_changed during build:_ the timed clone includes the server's first cold
     open of the repository, because the server opens a repository on its first
     request and warming it in setup would re-cache pages after the page-cache
     drop; the result says so in a note)
   - `push`: a fixed, deterministic change set (10 and 100 files) from that
     clone
   - `pull`: a second identity pulls that change
   - `land`: the change is landed into `main`
   - repositories per minute: N concurrent CLI clients creating repositories
     against one server

**Server limits.** Use the shipped `serve` defaults wherever a case fits inside
them (20 repositories per hour per owner, 100 repositories, 100,000 objects, 16
MiB request bodies). Raise only the limits a case actually hits, such as the
creation limit for repositories per minute or the object cap for stress. Record
the exact `serve` flags in the result, so a published figure reads, for example,
"server with creation limit raised".

**Page cache.** On the benchmark machine, `bench:record` runs every cold case
twice: once in a fresh process with the page cache warm, and once after dropping
the page cache (`echo 3 > /proc/sys/vm/drop_caches`, which needs sudo). Each
result is labelled `pageCache: "warm"` or `"dropped"`. The PR check runs
fresh-process cases only. Any cold-checkout claim on the website uses the
`dropped` number.

### Fixtures

Fixtures are a versioned generator, not committed bytes. Inputs are
deterministic: a seeded PRNG, identities from `Identity.fromSeed`, and an
injected clock (`at` on writes, `now` on the store and server). Each fixture
emits a manifest whose hash covers the plaintext tree and the op sequence; a run
records that hash and refuses to compare results whose hashes differ. Ciphertext
and object ids still differ per run because nonces and content keys are random,
which is correct.

_Changed during build:_ when the generator writes a fixture, it grants the owner
a capability on every write by a non-owner. The CLI reshares keys to all members
before an upload, so an owner's graph sees the whole tree only if it can read
every write. Granting only the owner keeps the stress build affordable.

| Fixture | Files  | Ops     | Authors | Views | Use                    |
| ------- | ------ | ------- | ------- | ----- | ---------------------- |
| small   | 100    | 1,000   | 1       | 1     | PR check, seconds      |
| medium  | 2,000  | 20,000  | 10      | 50    | a real active repo     |
| stress  | 20,000 | 200,000 | 100     | 500   | long history, big tree |

The **sweep** doubles history length (1k, 2k, 4k ... ops) and fits a log-log
slope per case, reported as an exponent with its fit quality (for example
"conflicts ≈ O(n^2.9)"). This is the "asymptotic behavior" the issue asks for.

**Op mix.** The generator mixes writes, removes, forks, and lands into `main`.
Lands matter because writes and forks alone leave every view a straight chain. A
view only holds several heads after a land or repoint, so without lands
`conflicts(view)` has nothing to do. Edits are skewed toward hot files, and
forked views share part of the tree. `conflicts()` and `materialize()` are
measured on `main` after the lands and on the global frontier (`heads()` with no
view). THA-21 compares its "after" against exactly these.

Every case has a time budget. A case that exceeds it is recorded as
`exceeded <budget> at n = X`, and one that runs out of memory as `oom at n = X`.
Both are results. Neither hangs nor skips the run. Today's near-O(N³)
`conflicts()` is expected to hit the budget at stress size.

### Metrics per case

p50 and p95 latency, throughput where it applies (ops/s, MB/s, repos/min), peak
RSS, bytes on disk under the `FileBackend` root, and the coefficient of
variation across repeats.

### Honesty labels in every result

- Write, push and land results carry
  `durability: "none (FileBackend renames atomically, no fsync)"`. No write-path
  number is published until a durable mode exists.
- The machine block names this host as a shared, virtualized guest: KVM, 4 vCPU
  AMD EPYC Rome, 7 GB RAM. _Changed during build:_ the result carries the
  machine id `kvm-epyc-rome-4vcpu`, described in the committed
  `bench/machines/kvm-epyc-rome-4vcpu.json`, and never the host's name.

### Targets

The five §5 targets stay owned by THA-117. THA-5 maps each to the benchmark that
measures it:

| §5 target                               | Benchmark                               |
| --------------------------------------- | --------------------------------------- |
| Cold install or checkout, sub-second    | e2e cold checkout, page cache dropped   |
| Repository creation, single-digit ms    | library repository creation (and e2e)   |
| Query over history, milliseconds        | library `CodeDB` history queries        |
| About 15,000 repos/min under agent load | e2e repos/min (a floor, not agent load) |
| 1,000+ simultaneous agents on one repo  | not measured here (THA-130)             |

Every other metric gets a recorded baseline and a regression threshold, and no
target. In the issue, "establish targets per metric" means this mapping plus
thresholds.

### Benchmark machine and recording

The benchmark machine is this host. Results from it may be published, because
the result names the machine and shows the spread.

_Changed during build:_ the repository is public, so neither the spec nor a
result names the host's private network name. The machine id is
`kvm-epyc-rome-4vcpu`, and `bench:record` takes it from `BENCH_MACHINE`.

Recording is manual: `moonx bench:record`. It refuses to start when the 1-minute
load average is above 0.5 or less than 2 GB of memory is available, and it
records both values in the result. The developer stops the dev servers first.

Results live at `bench/results/<machine>/<date>-<short-commit>.json`, and
`bench/results/<machine>/baseline.json` is a copy of the current reference run.

Merges rebase, so a branch commit does not survive onto `main`. The suite merges
first. The baseline is then recorded from the resulting `main` commit, which is
the commit the result names, and committed in a small follow-up PR.

### PR regression check

1. A separate workflow (not part of `ci-passed`) runs the library suite on the
   small fixture for both the PR's base commit and its head, on the same GitHub
   runner, interleaved and repeated. Comparing on one runner cancels most of the
   runner noise. Each commit runs its own `bench/`. Every case carries an id and
   a version. Results are compared only when id, version and manifest hash all
   match. Anything else is listed as "new or changed, not compared". If the base
   has no `bench/` at all, the check reports that and passes. A status change
   counts whatever the threshold: base `ok` with head `exceeded`, `oom` or
   `error` is a regression, and base `exceeded` with head `ok` is an
   improvement.
2. The threshold per benchmark comes from a committed **noise study**: base
   against base (A/A) many times, using the head/base median ratio of each pair.
   The thresholds file records the study date, runner image and suite version.
   It is re-derived when the runner image or the suite changes.

   _Changed during build:_ the threshold is a family-wise lognormal bound and
   not the raw 99th percentile of each case's ratios. For each case, the natural
   logs of its A/A ratios give a mean and a sample standard deviation, and the
   threshold is the exponential of the mean plus z times the standard deviation,
   floored at 1. z is the normal quantile at 1 minus 0.01 divided by N, where N
   is the number of cases with a threshold (a Bonferroni split). The target is a
   nominal 1% chance per pull request that a PR with no change is flagged on
   noise, in any case. A per-case 99th percentile would not do that: over about
   two dozen cases the check would be red on most PRs, which blocks the path to
   a required check, and 20 pairs make a 99th percentile about the maximum,
   which a new draw beats about 5% of the time per case. The nominal figure
   rests on the lognormal assumption and on estimates from a limited number of
   pairs, so it is not a guarantee. A case with fewer than three ratios gets no
   threshold. The file records N, z and the number of pairs.

3. Output goes to the GitHub job summary as a table, and the JSON goes up as an
   artifact. No PR comment, because fork PRs get a read-only token and
   `pull_request_target` would run fork code with write access.
4. The check reports only at first. It becomes a required check once a few weeks
   of data show a low false-alarm rate. That switch is a later, separate change.

## Left to the builder

These were my calls. Override any of them in review:

- **Harness:** a thin custom runner rather than mitata or tinybench. It needs
  subprocess isolation, per-case budgets and our schema.
- **Process isolation:** each case runs in a fresh subprocess, so peak RSS
  (`process.resourceUsage().maxRSS` or equivalent) belongs to that case alone.
- **Result schema:** a JSON Schema file in `bench/`, with results validated
  against it.
- **Reputation archive sizes:** `decodeReputationArchive` rejects archives over
  4,096 contributions by default, so the sweep passes explicit limits and
  records them.
- **Repeat counts, warm-up, budgets and the noise study size:** set them so that
  small finishes in about a minute per commit on a GitHub runner. Record them in
  each result.
- **Moon task names:** for example `bench:run`, `bench:e2e`, `bench:record`,
  `bench:compare` and `bench:noise`. The exact names are up to the builder.
- **How the e2e suite gets the binary:** through the existing `cli:compile`
  task.

## Verification

- Two runs of the same fixture produce the same manifest hash.
- `bench:record` on this host commits a baseline that validates against the
  schema and covers every case above, with timeouts and OOMs shown as results.
- The noise study is committed, and the thresholds in the check come from it.
- A deliberate slowdown on a branch (for example a sleep in `materialize`) turns
  the PR check red. Reverting it turns the check green.
- `moon run root:format root:lint` and the bench project's typecheck pass.
