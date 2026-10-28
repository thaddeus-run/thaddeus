# Thaddeus benchmark suite

This private project (`@thaddeus.run/bench`) measures what ships today on
`FileBackend`. It exists so that a change to a hot path, such as THA-21, has a
"before" to compare its "after" against, and so that any performance figure on
the website links to a committed run. The design is in
[the THA-5 spec](../docs/superpowers/specs/2026-10-25-tha-5-benchmark-suite-design.md).
The targets these cases map to are in
[section 5 of the architecture contract](../docs/agent-first-architecture.md#5-performance-targets-versus-measurements).

No run has been recorded yet, so this directory holds no results and this file
quotes no numbers. A recorded baseline arrives in a separate pull request.

## What the suites measure

**Library suite** (`--suite library`). It runs in one process against a
`FileBackend` root, with no server and no CLI.

| Area               | Case ids                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Objects            | `store.encrypt.<1k,64k,1m>`, `store.decrypt.<1k,64k,1m>`, `store.put`, `store.ingest`, `store.get`                                                                |
| Op-log             | `oplog.write`, `oplog.ingest`, `oplog.materialize.main`, `oplog.materialize.frontier`, `oplog.heads.frontier`, `oplog.conflicts.main`, `oplog.conflicts.frontier` |
| Cold open          | `open.cold`, and `open.cold.root-1`, `open.cold.root-100`, `open.cold.root-1000` for a server root that holds that many repositories                              |
| Repository         | `repo.create`: `Platform.createDurable` plus the bootstrap of the owner's signed genesis head, which is what the server does for a new repository                 |
| Query and graph    | `graph.resolve`, `graph.callersOf`, `codedb.why`, `codedb.touchedSince`, `codedb.callers`                                                                         |
| Reputation archive | `reputation.export.<n>` and `reputation.import.<n>` for 100, 1,000 and 10,000 contributions                                                                       |

Query and graph cases are coarse on purpose. ADR 0005 replaces the current
`SymbolGraph` with a projection built from the change journal, so these cases
give a rough baseline and not a fine-grained one.

**End-to-end suite** (`--suite e2e`). It drives the compiled `thaddeus` binary
against `thaddeus serve` over loopback. Client and server share one host, and
the result says so. Only these numbers are candidates for the website.

| Case id                | What one sample does                                                            |
| ---------------------- | ------------------------------------------------------------------------------- |
| `e2e.checkout.cold`    | `thaddeus clone` of the seeded repository into an empty directory               |
| `e2e.push.10`, `.100`  | `thaddeus push --no-land` of a 10-file or 100-file change set                   |
| `e2e.pull`             | a second identity runs `thaddeus pull` for a 10-file change                     |
| `e2e.land`             | `thaddeus land` of a branch holding a 10-file change into `main`                |
| `e2e.workspace`        | `thaddeus workspace` opens a branch in a new directory                          |
| `e2e.repo.create`      | `thaddeus create`, one after another                                            |
| `e2e.repos-per-minute` | 8 concurrent clients, each its own identity, create repositories for 30 seconds |

Each e2e case starts its own server on a hard-link copy of a seeded data root,
so the cached fixture is never changed. Setup does everything the timed command
needs, which leaves the timed part as one CLI invocation (or, for repositories
per minute, one burst of them).

Four cases cap their samples whatever the run asks for, and the result records
the capped `repeats` and `warmup`:

- `e2e.pull` and `e2e.land` take at most 3 samples and no warm-up. Each sample's
  setup lands a push on the server, and every server land runs `conflicts()`,
  which is slow on today's op-log (THA-21). Ten repeats and two warm-ups would
  not fit even the 600 second `record` budget on small.
- `e2e.repos-per-minute` takes at most 3 bursts and no warm-up. `bench run`
  cannot shorten a burst, and ten 30 second bursts would not fit the 120 second
  `run` budget.
- `e2e.repo.create` takes at most 15 samples, under the shipped limit of 20
  repository creations per owner per hour.

The e2e suite uses the shipped `serve` defaults and raises only the limits a
case hits: the request body size for pushes on medium and stress, the object cap
on stress, and the repository count and creation limits for repositories per
minute. The limits follow the fixture's size, so `medium-serial` and
`stress-serial` raise the same ones as `medium` and `stress`. The exact flags
are in each result's `serveFlags`.

### The e2e suite runs on a serial fixture

The shipped server refuses every land into a `main` that holds a conflict, and
the base fixtures land conflicts on purpose. The e2e suite therefore runs on a
conflict-free "serial" variant of each fixture. In the serial plan each view
forks from the current `main`, takes its share of the ops and lands before the
next view forks. The file, op, author and view counts match the base fixture.

Results for the variant read `small-serial`, `medium-serial` and so on. A serial
fixture has its own manifest hash, because it is a different history. Library
and e2e results are therefore different histories and must not be compared with
each other.

### Where `e2e.checkout.cold` starts the clock

The server opens a repository lazily, on the first request that needs it. The
timed `clone` is that first request, so `e2e.checkout.cold` includes the
server's first cold open of the repository. Warming the server in setup would
read the repository back into the page cache after the dropped-cache step, so
the case does not do it. Its result carries a note that says this.

In the dropped mode the drop comes before setup, and setup's hard-link copy
(`cp -al`) of the seeded root then walks the whole tree. That re-warms the
directory entries and inodes, though not the file contents. The note says this
too.

### The everyday suite

**Everyday suite** (`--suite everyday`). It times the commands a developer or an
agent runs all day, in a working copy, against git on the same files. The cases
need no server. Each working copy holds the fixture's `main` plus the same
10-file edit, so `status` and `diff` have changes to report. The cases here are
the working-copy ones and the git ones. The thaddeus side of the commit,
checkout, pull and clone rows is the e2e suite. The rows these cases feed, and
the targets they are held to, are in
[Everyday-command budgets and the CI gate](#everyday-command-budgets-and-the-ci-gate).

| Case id                                   | What one sample does                                              |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `wc.status`, `git.status`                 | `thaddeus status` or `git status` in a working copy               |
| `wc.diff`, `git.diff`                     | `thaddeus diff` or `git diff` in the same working copy            |
| `wc.status.agents8`, `git.status.agents8` | 8 working copies run `status` at once, timed until the last exits |
| `wc.diff.agents8`, `git.diff.agents8`     | 8 working copies run `diff` at once, timed until the last exits   |
| `git.commit`                              | `git add`, `git commit` and `git push` of 10 files                |
| `git.worktree`                            | `git worktree add`                                                |
| `git.pull`                                | `git pull --ff-only` of a 10-file change                          |
| `git.clone`                               | `git clone --depth 1 file://` into an empty directory             |

Git's transport in these cases is a bare repository over a local path, not
loopback HTTP, and git applies its own fsync settings. Its numbers are a floor
for the same work, not a like-for-like protocol comparison.

## Fixtures

A fixture is a versioned generator and not committed bytes. The inputs are
deterministic: a seeded PRNG, identities from `Identity.fromSeed`, and an
injected clock. Each fixture has a manifest whose hash covers the plaintext tree
and the op sequence. A run records the hash, and results with different hashes
are never compared. Ciphertext and object ids still differ from run to run,
because the nonces and content keys are random. That is why the hash covers the
plan and not the stored bytes.

| Fixture | Files  | Ops     | Authors | Views | Use                             |
| ------- | ------ | ------- | ------- | ----- | ------------------------------- |
| tiny    | 10     | 20      | 2       | 2     | smoke tests and filler repos    |
| small   | 100    | 1,000   | 1       | 1     | the PR check, a quick local run |
| medium  | 2,000  | 20,000  | 10      | 50    | a real active repository        |
| stress  | 20,000 | 200,000 | 100     | 500   | long history and a big tree     |

The op mix has writes, removes, forks and lands into `main`. Lands matter
because writes and forks alone leave every view a straight chain, and
`conflicts()` has nothing to do without several heads. The generator lands a
view by re-pointing `main` to the merged heads, which is exactly what
`Repo.land` with `allowAll` persists. It does not call `Repo.land`, because that
always runs `conflicts()`, the cost the suite measures, and fixture builds would
grow about as n⁴ with history length. Edits favor a small set of hot files. In
every fixture the owner is granted read access on every write, so a graph built
by the owner sees the whole tree.

The **sweep** doubles the history length (1,000 ops, 2,000, 4,000 and so on) for
four cases: `open.cold`, `oplog.write`, `oplog.materialize.frontier` and
`oplog.conflicts.frontier`. It fits a log-log line to the median times and
reports an exponent together with its R². Only `record` and `run --sweeps` run
it.

Fixture caches live under `bench/.cache/` (gitignored). A cache is built in a
temporary directory and renamed into place together with a `.complete` marker
that holds the manifest hash, so a build that was killed halfway is never
trusted by a later run. Before anything is timed, a suite run builds every cache
it needs in a child process, so a fixture that cannot be built is recorded once
as a setup failure. A pre-build has its own budget, `method.prebuildBudgetMs` in
the result: 1,800,000 ms (30 minutes) under `record`, and the case budget under
`run`. Sweep fixtures are built smallest first, and after the first size that
fails, the larger sizes are not built at all.

## Running the suite

`bench:run` is for development. It has no preflight, so a dirty tree or a busy
machine is not refused (a dirty tree is recorded as `dirty: true`). The moon
task is skipped in CI-marked shells, so run it with `CI=`:

```bash
export AGENT=1
CI= moonx bench:run                                  # library suite, small fixture
CI= moonx bench:run -- --suite e2e --fixtures small  # end to end, on small-serial
CI= moonx bench:run -- --fixtures small,medium --sweeps --out out/try.json
```

By default `run` uses the library suite, the `small` fixture, 10 repeats, 2
warm-ups and a 120 second budget per case, with the page cache left as it is
(`warm`). It writes `bench/out/<date>-<short-commit>.json` unless you pass
`--out`. The flags are `--suite library|e2e|everyday|all`, `--fixtures`,
`--sweeps`, `--repeats`, `--warmup`, `--page-cache warm,dropped`, `--exclude`
(globs over case ids), `--only` (globs over case ids), `--budget-ms` (per-case
budget, default 120000), `--prebuild-budget-ms` (per fixture pre-build, default
the case budget) and `--out`. `--page-cache dropped` needs `sudo -n`, so run
`sudo -v` first.

The e2e suite needs the compiled binary. `bench:run` depends on the build of the
packages, and `bench:record` also depends on `cli:compile`. Compile the CLI
first (`CI= moonx cli:compile`) before running the e2e suite with `bench:run`.

Each case runs in its own subprocess. That gives every case its own peak memory
reading and lets the runner enforce its time budget. Other commands, which have
no moon task, run from the `bench` directory with `bun src/cli.ts`:
`fixture <name>` builds a cache and prints its path (`--server` builds the e2e
seeded server root, `--git` the everyday suite's bare git repository, which
needs a serial fixture), `merge` joins round files of one commit,
`compare <base> <head>` prints the comparison table, `noise` runs the A/A study,
and `budget <run.json>...` reports runs against the everyday-command targets in
`budgets/everyday.json` (it exits 0 when a target is missed; `budget --case-ids`
prints the ids of the cases the budgets measure). `gate-run`, `gate`, `ceilings`
and `calibrate` belong to the CI gate and are described under
[Everyday-command budgets and the CI gate](#everyday-command-budgets-and-the-ci-gate).

## Recording a result

`bench:record` produces the files that can be cited. It runs every case of the
library, e2e and everyday suites on the small, medium and stress fixtures with
sweeps, 10 repeats, 2 warm-ups and a 600 second budget per case, and runs each
cold case twice: once with the page cache warm and once after dropping it.

1. Stop the dev servers and any other jobs on the machine.
2. Run `sudo -v`. Dropping the page cache needs `sudo -n`, and `record` keeps
   the credentials alive during the run, but it cannot ask for the password.
3. Run:

```bash
BENCH_MACHINE=kvm-epyc-rome-4vcpu CI= moonx bench:record -- --baseline
```

`record` refuses to start, before any case runs, when the 1-minute load average
is above 0.5, when less than 2 GiB of memory is available, when the checkout has
uncommitted or untracked changes anywhere outside `bench/results` (so the file
never names a commit it did not measure; `bun.lock`, the root `package.json`,
`patches/` and `tsconfig.options.json` count too), or when `sudo -n` does not
work. It records the load and the available memory in the result, and it checks
again after the run that the tree has not changed.

The result goes to `bench/results/<machine>/<date>-<short-commit>.json`, and
`--baseline` also copies it to `bench/results/<machine>/baseline.json`. The file
is checked against `schema/bench-run.schema.json` before it is written.

The machine id is `kvm-epyc-rome-4vcpu`. Its description is in
`machines/kvm-epyc-rome-4vcpu.json`: a shared, virtualized KVM guest with 4 vCPU
AMD EPYC Rome and 7 GB of RAM. The host's name never appears in results, because
the repository is public. Add a file to `machines/` to record on another
machine.

Merges rebase, so a branch commit does not survive onto `main`. Record the
baseline from the merged `main` commit and commit it in a separate pull request.

## Reading a result

Every case result carries its id, version, fixture, manifest hash, method
(`repeats`, `warmup`, `budgetMs`), samples, p50, p95, the coefficient of
variation `cv`, peak memory and, where it applies, throughput and `diskBytes`.
The fields that need an explanation:

- **`status`** is one of `ok`, `exceeded`, `oom` and `error`. Only `ok` results
  have a median and can be compared.
- **`exceeded`** means the case ran past its time budget and the runner killed
  it. The result says `exceeded <budget> ms at n = X`, where the budget is in
  milliseconds and n is the history length (ops) of the fixture. It is a result
  and not a skipped case. It tells you the case is slower than the budget on
  that input.
- **`oom`** means the case ran out of memory (the kernel killed it, or the
  runtime reported an allocation failure). It is recorded as `oom at n = X`.
- **`phase`** is `setup` when the failure happened while building the input, for
  example while building a stress fixture on a 7 GB host, and not in the timed
  part. The run continues either way.
- **`durability`** appears on every write, push and land result and reads
  `none (FileBackend renames atomically, no fsync)`. The library cases that
  carry it are `oplog.write`, `oplog.ingest`, `store.put`, `store.ingest` and
  `repo.create`; the e2e cases are `e2e.push.10`, `e2e.push.100`, `e2e.land`,
  `e2e.repo.create` and `e2e.repos-per-minute`. `FileBackend` replaces files by
  rename but never calls fsync, so these numbers are not durable-commit latency.
  Do not publish a write-path figure as one.
- **`pageCache`** appears on cold cases (`open.cold*` and `e2e.checkout.cold`)
  and is `warm` or `dropped`. In the dropped mode the runner flushes and drops
  the kernel page cache (`echo 3 > /proc/sys/vm/drop_caches`) before every
  sample, so the sample reads from disk. A cold-checkout claim uses the
  `dropped` result. The PR check runs warm only.
- **`serveFlags`** lists the `serve` flags an e2e case raised above the shipped
  defaults, so a figure can say, for example, "server with creation limit
  raised".

A sweep result lists the median and the fixture's manifest hash at each history
length, together with the fitted exponent and its R². A low R² means the line is
a poor fit and the exponent should not be quoted. A sweep of a writing case
(`oplog.write`) carries `durability` as well. A sweep that stopped early has
`failedAtN` and a `note`: the failing size's case note, or
`fixture pre-build failed: ...` when it was the fixture that could not be built
and the case never ran.

### Results to expect on today's code

Some cases are expected to record `exceeded`, and that is a finding and not a
broken run:

- `open.cold` on the stress fixture. Opening a stress repository from a cold
  start takes longer than the budget allows for the full set of repeats.
- `e2e.pull` and `e2e.land` may still exceed the 120 second `run` budget, even
  capped at 3 samples. Each land runs `conflicts()`, which is slow on the
  current op-log (THA-21). The cap is set so that `record` gets a median on
  small.
- Every e2e case on medium and stress. Seeding the server root replays the
  fixture through the real server, whose land runs `conflicts()` on 20,000 or
  more ops (THA-21), so the seeded-root pre-build is expected to exceed its
  budget and each e2e case records a setup failure. There are no medium or
  stress e2e figures until THA-21 lands.
- `reputation.export.10000` and `reputation.import.10000` exceed the `run`
  budget even on small.

`e2e.pull` and `e2e.land` have no published figure until THA-21 lands.

## The PR check

`.github/workflows/bench.yml` runs on every pull request. This comparison of the
library suite is report only: it is not part of `ci-passed`, it is not a
required check, and it posts no PR comment (fork pull requests get a read-only
token). It writes a job summary and uploads the runs as an artifact. The
everyday-command latency gate is a different job, in `ci.yml`, and it is
required (see
[Everyday-command budgets and the CI gate](#everyday-command-budgets-and-the-ci-gate)).
Each side builds only the packages bench imports (`bench:build-deps`), not the
whole workspace. A second job in the same workflow runs `bench:test-slow` (see
[Tests](#tests)).

The job checks out the PR's merge commit and its first parent, which is the base
the PR was merged onto. Each side runs its own `bench/`. It runs the library
suite on the small fixture, warm only, with 3 repeats and 1 warm-up, in five
interleaved rounds (base, head, base, head, and so on) on one runner, so drift
hits both sides alike. `compare` then reports each case.

- Results are compared only when the case id, case version and manifest hash all
  match. Anything else is listed as "new or changed, not compared".
- A status change counts whatever the threshold: base `ok` with head `exceeded`,
  `oom` or `error` is a regression, and base `exceeded` with head `ok` is an
  improvement.
- If the base has no `bench/` directory, the job says so and passes.

### How the thresholds are set

Thresholds are not picked percentages. They come from an A/A noise study, in
which `main` is measured against itself many times so that noise is all that
separates the two sides. Each pair gives one head-over-base ratio of medians per
case.

The threshold method is a family-wise lognormal bound. For each case, take the
natural logarithm of its A/A ratios and compute their mean and sample standard
deviation. The threshold is the exponential of the mean plus z times the
standard deviation. Here z is the normal quantile at 1 minus 0.01 divided by N,
where N is the number of cases that have a threshold. The threshold is never
below 1, and a case with fewer than three ratios gets none. A case is flagged
when its head/base ratio is above its threshold.

Dividing the 1% by N is a Bonferroni split. The aim is a nominal 1% chance per
pull request that a PR that changes nothing is flagged on noise in any case. A
plain 99th percentile per case would not meet that aim: with a few dozen cases
the check would be red on most PRs.

That 1% is nominal. It holds if the A/A ratios really are lognormal, if the
cases are independent enough for the split to work, and if the study's estimates
of mean and spread are close to the truth. The study has a limited number of
pairs, the runner image changes over time, and a real PR can meet different
conditions from the study. Nothing here guarantees that the check will never
flag a PR on noise. In the other direction, a slowdown smaller than a case's
threshold passes.

The thresholds file is `thresholds/github-ubuntu-latest.json`. It records the
study date, runner image, suite version, number of pairs, N and z. It does not
exist until the first noise study has run, and `compare` runs without thresholds
until then, so only status changes can fail. A thresholds file from another
suite version is treated as stale and not used.

### What the PR job and the noise job leave out

Both jobs exclude `reputation.*.10000` and `open.cold.root-1000`. On small, the
reputation export and import of 10,000 contributions each run past the `run`
budget, so they could only ever report `exceeded`. The 1,000-repository root
takes too long to build and open for a PR job. Both cases still run in
`bench:record`.

The noise study also excludes `oplog.conflicts.*` and `codedb.callers`. They are
slow even on small, and 200 suite runs have to fit in GitHub's 6 hour job limit.
The PR job still runs them. They show "no threshold" and fail the check only on
a status change. They are THA-21's targets, so the PR job keeps watching them.

### Re-running the noise study

Run the study again when the suite version or the runner image changes. The
suite version is a hash of every case id and version, so adding, removing or
re-versioning a case changes it. Dispatch the `Benchmarks` workflow with
`mode: noise` on `main`; it runs 20 pairs of 5 rounds, rewrites the thresholds
file after every pair, and uploads it as an artifact. Commit that file to
`bench/thresholds/github-ubuntu-latest.json`.

## Everyday-command budgets and the CI gate

`budgets/everyday.json` lists the everyday commands and the target each one is
held to, such as `status` in 50 ms and no slower than git. A row names a
thaddeus case, a git case, a target in milliseconds (`targetMs`) and a target
multiple of git (`targetMultiple`). The file is checked against
`schema/budgets.schema.json`. Its `targetFixture` is `medium-serial`, a
repository of 2,000 files and 20,000 ops, because that is the size the targets
are about.

Every number in `budgets/everyday.json` is a target and not a measurement. No
run is committed under `bench/results` yet, so this file quotes no measured
latency of its own. The only measured figures here are the ones that link to a
CI run.

### What each row times

| Row          | thaddeus side                                                                                                | git side                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| status, diff | `thaddeus status`, `thaddeus diff` (`wc.status`, `wc.diff`)                                                  | `git status`, `git diff`                                                      |
| commit       | `thaddeus push --no-land` of 10 files (`e2e.push.10`)                                                        | `git add`, `git commit` and `git push` to a bare repository over a local path |
| checkout     | `thaddeus workspace` (`e2e.workspace`)                                                                       | `git worktree add`                                                            |
| pull         | a second identity pulls a 10-file change (`e2e.pull`)                                                        | `git pull --ff-only`                                                          |
| ci-checkout  | `thaddeus clone` into an empty directory, in a fresh home, with the page cache dropped (`e2e.checkout.cold`) | `git clone --depth 1 file://`                                                 |

The environments are `developer` (one process on a machine to itself), `agent`
and `ci`. In the agent environment, 8 working copies sit on one 4 vCPU host and
run the command at once, and a sample lasts until the last of them exits. The
agent rows exist for `status` and `diff` only. The rebase rows have no thaddeus
command to time (thaddeus has no rebase, and updating a workspace base is
THA-11), and the agent commit, checkout and pull rows need concurrent writers on
one server, which waits for the replayable agent workload harness (THA-118).
Those five rows read `unmeasured` in `bench budget` with their owner.

The server rows (commit, checkout, pull and ci-checkout) run on `small-serial`
today. On `medium-serial` and `stress-serial` the seeded server root cannot be
built within the 30 minute pre-build budget, because every land runs
`conflicts()` (THA-21). The working-copy rows run on any fixture. The stress
fixture's thaddeus working copy has also not been built within that budget on
the 4 vCPU development host. `bench budget` fills the "Target met" column only
for rows measured on the target fixture, so `small-serial` rows show `-`.

### `bench budget`

`bun src/cli.ts budget <run.json>...` prints one table line per measured row and
fixture, the thaddeus and git p50, the multiple, and whether the target and the
multiple were met. Below the table it lists every missed line with its
attribution, and every unmeasured row with its owner and reason. It exits 0
whether or not a target is missed. A missed line with no entry in the
`attribution` object of `budgets/everyday.json` prints as `unattributed`, so a
new miss is visible until someone explains it.

### Attribution

The `attribution` object is keyed `<command>/<env>`. Each entry has an `owner`
(the issue that fixes it), a `cause` and the `evidence` for it. The evidence
comes from `bun --cpu-prof` of the CLI run from source
(`packages/cli/src/bin.ts`) on the 4 vCPU development host, at commit `3d06d3b`.
The percentages are inclusive shares of sampled time, so nested frames add up to
more than their parent. They are profiles of the code at that commit, not run
results. To reproduce one, run
`bun --cpu-prof --cpu-prof-dir <dir> <repo>/packages/cli/src/bin.ts status`
inside a working copy and open the `.cpuprofile` file in the Chrome DevTools
profiler. Redo the profile when a fix lands. A target missed for a new reason
needs a new entry.

### The gate

The `everyday-gate` job in `.github/workflows/ci.yml` is part of `ci-passed`,
which branch protection requires. It builds the CLI, runs `bench gate-run`, then
`bench budget` and `bench gate`. `gate-run` measures every budgeted case on
`small-serial` with 3 repeats and 1 warm-up, in both page-cache modes, with a
300 second budget per case. Git cases take at least 25 samples. They cost
milliseconds each, and the extra samples steady the git median that the reported
multiple divides by.

`bench gate <run.json>` holds the thaddeus p50 of each measured row to a ceiling
in `budgets/ceilings-github-ubuntu-latest.json`. It exits 1 and lists every
failure when:

- a p50 is above its ceiling;
- a gated case did not finish `ok`;
- the run was not measured with the gate method. Repeats and warm-up are checked
  as the method. A wrong fixture or page-cache mode is not checked as the
  method: it fails as "no ceiling" or "missing";
- a row has no ceiling;
- the ceilings are stale: they were calibrated for other case versions, other
  page-cache modes, or other fixtures (the ceilings file records the manifest
  hash each gated case ran on, and the gate compares it with the run's). The
  gate refuses stale ceilings and says why.

A change to what a case measures makes its ceilings stale, and the version and
hash checks are how the gate learns of it. Bump a case's `version` whenever the
case changes. That rule covers the seeding too: a change to what
`GIT_SEED_VERSION` (the git repository the git cases clone) or the working-copy
builder writes bumps the version of every case that uses them. A change to the
generated fixture plan changes its manifest hash without a bump, and the gate
then fails as stale until the ceilings are recalibrated.

A missed target and the multiple of git are in the job summary. They never fail
the job. Today's numbers miss most targets, and a gate that is red on every pull
request would be switched off. The gate holds each command to a ceiling from the
committed calibration. It does not compare a pull request with `main`, so
slowdowns that each stay under the ceiling can add up over several pull
requests.

### When the gate is red on a pull request that did not cause it

1. Re-run the job. A different runner may draw a different CPU model, and the
   first line of the job summary's gate output names the group the gate used.
2. Check whether `main` fails on the same CPU model: dispatch the gate on `main`
   or look at the last run on `main`.
3. If `main` fails too, the runner image or the hardware moved. Dispatch the
   `Benchmarks` workflow with `mode: everyday-calibrate` and commit the new
   ceilings in their own pull request.

### Why the gate does not hold the multiple of git

An earlier design held the thaddeus-over-git ratio to a ceiling. It was dropped
because git's own median moves too much. In the calibration run linked under
[How the ceilings are set](#how-the-ceilings-are-set), the median of
`git.status` on `small-serial` ranged from 1.65 to 3.60 ms across the 40 runs
(five CPU models). Between the two runs on one host, the `git.status` median
usually differed by about 3%, but by more than 10% on 3 of the 20 hosts and by
66% on one, even at 25 samples. The `wc.status` median never differed by more
than 7.3%. A ratio ceiling has to allow git's worst swing, which is wider than
the thaddeus slowdowns the gate must catch, so the gate holds the thaddeus p50
alone. `bench budget` and the gate output still report the multiple.

### How the ceilings are set

A ceiling is `exp(mu + t * sigma)` over the logarithms of the thaddeus p50s of a
group of calibration runs. Here `t` is the Student-t quantile at 1 minus 0.01
divided by N with n minus 1 degrees of freedom, where n is the number of runs
and N the number of gated rows. It is the same family-wise 1% split as the
thresholds under [How the thresholds are set](#how-the-thresholds-are-set), with
a t quantile because a calibration has few runs.

Hosted runners differ in CPU model, and a slow model would otherwise raise the
ceiling for everyone. The ceilings file keeps one group per CPU model (`byCpu`)
and one `pooled` group over all runs. The gate uses the group of the runner's
CPU model when the group has at least 6 runs from at least 3 hosts and the model
is known. Otherwise it uses the pooled group. The gate output says which group
it used and why.

The committed ceilings come from the calibration run at
<https://github.com/thaddeus-run/thaddeus/actions/runs/40365833192>: 20 hosts, 2
runs each. Five CPU models turned up. `studiedAt` in the ceilings file is the
newest `recordedAt` of those runs. The table gives, for each model, the ceiling
the gate applies to it divided by that model's own geometric mean p50 (its
typical p50) over the 40 runs, across the gated rows. For a model with its own
group that is its own ceiling. For a model without one, the gate falls back to
the pooled ceiling, so the pooled ceiling is divided by the model's geometric
mean.

| CPU model                 | Hosts | Runs | Group the gate uses | Ceiling over the model's own typical p50 |
| ------------------------- | ----: | ---: | ------------------- | ---------------------------------------- |
| AMD EPYC 7763             |    10 |   20 | its own             | 1.08 to 1.16 times                       |
| AMD EPYC 9V45             |     3 |    6 | its own             | 1.10 to 1.33 times                       |
| AMD EPYC 9V74             |     3 |    6 | its own             | 1.74 to 2.19 times (one host was slow)   |
| Intel Xeon Platinum 8573C |     2 |    4 | pooled              | 2.19 to 2.48 times                       |
| Intel Xeon 6973P-C        |     2 |    4 | pooled              | 2.31 to 3.03 times                       |

A slowdown smaller than that factor passes on that model. On the EPYC 7763 group
the gate sees a slowdown of 8 to 16 percent, depending on the row. On a model
that falls back to the pooled ceilings, a slowdown of 2.2 to 3 times passes.

A model the calibration never saw uses the pooled ceilings too, and if it is
fast it gets about 3 times its typical p50 before the gate fails. The pooled
ceilings divided by the EPYC 9V45's own geometric mean give 3.03 to 3.45 times,
and that model is the fastest of the five. The gate is blind to a moderate
slowdown on such a runner until a recalibration adds its model. The first gate
run on this pull request passed:
<https://github.com/thaddeus-run/thaddeus/actions/runs/40772838975>.

### Recalibrating

Recalibrate when a gated case's version or fixture hash changes, when the runner
image changes enough to move the numbers, or when a row is added. Dispatch the
`Benchmarks` workflow with `mode: everyday-calibrate`. It runs `gate-run` twice
on each of 20 hosted runners, derives the ceilings with `bench ceilings`, and
uploads them as the `everyday-ceilings` artifact. Commit that file over
`budgets/ceilings-github-ubuntu-latest.json`. `bench ceilings` warns about input
files that are not named `run-<host>-<k>.json`, because it counts each such file
as a host of its own. To calibrate on one machine, `bench calibrate --runs K`
runs the gate's method K times and writes the file.

## Tests

`moonx bench:test` runs the fast unit tests in `test/` (statistics, comparison,
schema, plan, machine, the runner on fake cases, and the suite builder with
stand-in fixture builds). It is part of the required CI and takes about 15
seconds. `moonx bench:test-slow` runs the tests in `test-slow/`, which start
real processes: fixture builds, the library cases, the e2e CLI and server, and
full suite runs. It takes several minutes and runs in the Benchmarks workflow
only.

## Changing a case

Bump a case's `version` whenever the work it times changes. The version is part
of the key that decides whether two results can be compared. Without a bump, a
base run of the old work would be compared with a head run of the new work, and
the check would report a difference that the code did not cause. A change to
what a case sets up also needs a bump when it changes what the timed part sees.
In the e2e suite, a change to how the server root is seeded needs a bump to the
e2e case versions as well as to `SEED_VERSION`.

Changing the fixture generator changes the manifest hash instead, which stops
comparisons in the same way.
