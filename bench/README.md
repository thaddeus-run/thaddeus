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

## Fixtures

A fixture is a versioned generator and not committed bytes. The inputs are
deterministic: a seeded PRNG, identities from `Identity.fromSeed`, and an
injected clock. Each fixture has a manifest whose hash covers the plaintext tree
and the op sequence. A run records the hash, and results with different hashes
are never compared. Ciphertext and object ids still differ from run to run,
because the nonces and content keys are random. That is why the hash covers the
plan and not the stored bytes.

| Fixture | Files  | Ops     | Authors | Views | Use                          |
| ------- | ------ | ------- | ------- | ----- | ---------------------------- |
| tiny    | 10     | 20      | 2       | 2     | smoke tests and filler repos |
| small   | 100    | 1,000   | 1       | 1     | a quick local run            |
| medium  | 2,000  | 20,000  | 10      | 50    | a real active repository     |
| stress  | 20,000 | 200,000 | 100     | 500   | long history and a big tree  |

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
`--out`. The flags are `--suite library|e2e|all`, `--fixtures`, `--sweeps`,
`--repeats`, `--warmup`, `--page-cache warm,dropped`, `--exclude` (globs over
case ids) and `--out`. `--page-cache dropped` needs `sudo -n`, so run `sudo -v`
first.

The e2e suite needs the compiled binary. `bench:run` depends on the build of the
packages, and `bench:record` also depends on `cli:compile`. Compile the CLI
first (`CI= moonx cli:compile`) before running the e2e suite with `bench:run`.

Each case runs in its own subprocess. That gives every case its own peak memory
reading and lets the runner enforce its time budget. Other commands, which have
no moon task, run from the `bench` directory with `bun src/cli.ts`:
`fixture <name>` builds a cache and prints its path, `merge` joins round files
of one commit, `compare <base> <head>` prints the comparison table, and `noise`
runs the A/A study.

## Recording a result

`bench:record` produces the files that can be cited. It runs every case on the
small, medium and stress fixtures with sweeps, 10 repeats, 2 warm-ups and a 600
second budget per case, and runs each cold case twice: once with the page cache
warm and once after dropping it.

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
  `dropped` result.
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

## Comparing two commits

No workflow runs benchmarks. To compare two commits, run the same suite on each,
ideally in interleaved rounds on one machine so drift hits both sides alike,
`merge` the round files of each side, and run `compare <base> <head>`, which
reports each case and exits 1 on a regression.

- Results are compared only when the case id, case version and manifest hash all
  match. Anything else is listed as "new or changed, not compared".
- A status change counts whatever the threshold: base `ok` with head `exceeded`,
  `oom` or `error` is a regression, and base `exceeded` with head `ok` is an
  improvement.

### How the thresholds are set

Thresholds are not picked percentages. They come from an A/A noise study
(`noise`), in which one commit is measured against itself many times so that
noise is all that separates the two sides. Each pair gives one head-over-base
ratio of medians per case. Thresholds only hold for the machine and method they
were measured with.

The threshold method is a family-wise lognormal bound. For each case, take the
natural logarithm of its A/A ratios and compute their mean and sample standard
deviation. The threshold is the exponential of the mean plus z times the
standard deviation. Here z is the normal quantile at 1 minus 0.01 divided by N,
where N is the number of cases that have a threshold. The threshold is never
below 1, and a case with fewer than three ratios gets none. A case is flagged
when its head/base ratio is above its threshold.

Dividing the 1% by N is a Bonferroni split. The aim is a nominal 1% chance per
comparison that a change that does nothing is flagged on noise in any case. A
plain 99th percentile per case would flag most comparisons once there are a few
dozen cases.

That 1% is nominal. It holds if the A/A ratios really are lognormal, if the
cases are independent enough for the split to work, and if the study's estimates
of mean and spread are close to the truth. In the other direction, a slowdown
smaller than a case's threshold passes.

`noise` writes `thresholds/github-ubuntu-latest.json` by default, and `compare`
reads it when it exists (pass `--thresholds` for another file). Without one,
`compare` runs without thresholds, so only status changes can fail. A thresholds
file from another suite version is treated as stale and not used.

## Tests

`moonx bench:test` runs the fast unit tests in `test/` (statistics, comparison,
schema, plan, machine, the runner on fake cases, and the suite builder with
stand-in fixture builds). It is part of the required CI and takes about 15
seconds. `moonx bench:test-slow` runs the tests in `test-slow/`, which start
real processes: fixture builds, the library cases, the e2e CLI and server, and
full suite runs. It takes several minutes and no workflow runs it, so run it
locally after changing bench.

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
