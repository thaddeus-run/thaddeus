import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type { BenchCase } from './case';
import { resolveFixture, serialSpec, sweepSpec } from './fixtures/spec';
import {
  detectMachine,
  hostProbe,
  knownMachines,
  type MachineProbe,
  MACHINES_DIR,
  readMachineFile,
} from './machine';
import {
  type BenchRun,
  type CaseResult,
  type CaseStatus,
  type Machine,
  type SweepResult,
  validateRun,
} from './result';
import {
  classify,
  failureNote,
  runCase,
  type RunOptions,
  runSweep,
  setupFailure,
  spawnBudgeted,
  SWEEP_SIZES,
} from './runner';

// The bench project directory and the repository root above it.
export const BENCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(BENCH_ROOT, '..');
const CLI = join(BENCH_ROOT, 'src', 'cli.ts');

export type SuiteName = 'library' | 'e2e';
export type PageCacheMode = 'warm' | 'dropped';

// Registry module of each suite.
const REGISTRIES: Record<SuiteName, string | null> = {
  library: join(BENCH_ROOT, 'src', 'cases', 'index.ts'),
  e2e: join(BENCH_ROOT, 'src', 'e2e', 'cases.ts'),
};

// The registry module path of `suite`, or null when the suite does not exist
// (test registries may leave one out). Suite runs look registries up only
// through here.
export function registryFor(suite: SuiteName): string | null {
  return REGISTRIES[suite];
}

// `bench:record` runs every fixture but tiny (tiny exists for smoke tests) with
// this method. A fixture pre-build gets its own, longer budget: building
// stress or a large sweep size is not what the run measures, and it can take
// longer than any one case on it.
export const RECORD_FIXTURES = ['small', 'medium', 'stress'];
export const RECORD_METHOD = {
  repeats: 10,
  warmup: 2,
  budgetMs: 600_000,
  prebuildBudgetMs: 1_800_000,
};

// The record preflight's limits: the 1-minute load average must not be above
// MAX_LOAD_AVG_1, and at least MIN_AVAILABLE_BYTES must be available.
const MAX_LOAD_AVG_1 = 0.5;
const MIN_AVAILABLE_BYTES = 2 * 2 ** 30;

// How often a record touches `sudo -n` so the cached credentials do not expire
// between two dropped-cache cases hours apart.
const SUDO_KEEPALIVE_MS = 60_000;

const DROP_PAGE_CACHE = [
  'sudo',
  '-n',
  'sh',
  '-c',
  'sync; echo 3 > /proc/sys/vm/drop_caches',
];

// A command-line mistake: printed with the usage, exit code 2.
export class UsageError extends Error {
  override name = 'UsageError';
}

export interface PreflightEnv {
  loadAvg1: number;
  memAvailableBytes: number;
  /** Uncommitted paths in the checkout, bench/results aside. */
  dirtyPaths: string[];
  sudoOk: boolean;
  /** Whether the run drops the page cache, which needs `sudo -n`. */
  needSudo: boolean;
}

// Why the machine is not fit to record on, one reason per line, or null when
// it is. A busy or short-of-memory host would skew the numbers, a dirty tree
// would make the result name a commit it did not measure, and a missing
// `sudo -n` would fail the first dropped-cache case hours into the run.
export function preflight(env: PreflightEnv): string | null {
  const reasons: string[] = [];
  if (env.loadAvg1 > MAX_LOAD_AVG_1) {
    const load = Number(env.loadAvg1.toFixed(2));
    reasons.push(
      `load average ${load} is above ${MAX_LOAD_AVG_1}; stop the dev servers and other jobs first`
    );
  }
  if (env.memAvailableBytes < MIN_AVAILABLE_BYTES) {
    const gib = (env.memAvailableBytes / 2 ** 30).toFixed(2);
    reasons.push(`less than 2 GiB available (${gib} GiB)`);
  }
  if (env.dirtyPaths.length > 0) {
    const shown = env.dirtyPaths.slice(0, 5).join(', ');
    const more =
      env.dirtyPaths.length > 5 ? ` and ${env.dirtyPaths.length - 5} more` : '';
    reasons.push(
      `uncommitted changes (${shown}${more}); commit or stash them so the result names the commit it measured`
    );
  }
  if (env.needSudo && !env.sudoOk) {
    reasons.push(
      'sudo -n cannot run, so the page cache cannot be dropped; run sudo -v first'
    );
  }
  return reasons.length > 0 ? reasons.join('\n') : null;
}

// Identifies the set of cases a run used: the blake3 hex of the sorted
// `id@version` lines. Two runs with the same suite version ran the same cases
// at the same versions.
export function suiteVersion(cases: readonly BenchCase[]): string {
  const lines = cases.map((c) => `${c.id}@${c.version}`).sort();
  return bytesToHex(blake3(new TextEncoder().encode(lines.join('\n'))));
}

export interface SuiteOptions {
  suite: SuiteName | 'all';
  fixtures: string[];
  sweeps: boolean;
  /** Modes for cold cases; other cases run once regardless. */
  pageCache: PageCacheMode[];
  repeats: number;
  warmup: number;
  budgetMs: number;
  /** Budget of each fixture pre-build; `budgetMs` when absent. */
  prebuildBudgetMs?: number;
  /**
   * Globs over case ids (e.g. `reputation.*.10000`) of cases to leave out.
   * Excluded cases still count towards the suite version.
   */
  exclude?: string[];
}

// What a suite run records about where it ran, and the hooks it calls.
export interface SuiteEnv {
  machine: Machine;
  commit: string;
  dirty: boolean;
  /** Runs before each sample of a `dropped` cold case. */
  dropPageCache?: () => Promise<void>;
  log: (line: string) => void;
  /** Test seam: replaces `registryFor`. */
  registryFor?: (suite: SuiteName) => string | null;
  /** Test seam: replaces SWEEP_SIZES. */
  sweepSizes?: readonly number[];
  /**
   * Test seam: the command that pre-builds one fixture cache, or with
   * `server` the seeded server root of the e2e suite.
   */
  buildCommand?: (fixture: string, repos: number, server: boolean) => string[];
}

type Job =
  | {
      kind: 'case';
      registry: string;
      benchCase: BenchCase;
      fixture: string;
      pageCache: PageCacheMode | undefined;
    }
  | { kind: 'sweep'; registry: string; benchCase: BenchCase };

// Repository counts of the cached roots a case opens besides the fixture's
// own: `open.cold.root-<n>` opens a root holding n repositories.
function extraRootsOf(benchCase: BenchCase): number[] {
  const match = /^open\.cold\.root-(\d+)$/.exec(benchCase.id);
  return match === null ? [] : [Number(match[1])];
}

// Why a fixture cache could not be pre-built, in the form of a case result.
interface BuildFailure {
  status: Exclude<CaseStatus, 'ok'>;
  note: string;
}

// Pre-build failures keyed by `fixtureKey`.
type BuildFailures = Map<string, BuildFailure>;

// One cache a job needs: the fixture root with `repos` repositories, or with
// `server` the e2e suite's seeded server root (which is built from the
// fixture root).
interface CacheNeed {
  fixture: string;
  repos: number;
  server: boolean;
}

function fixtureKey(need: CacheNeed): string {
  return `${need.fixture}:${need.server ? 'server' : need.repos}`;
}

// The caches `benchCase` opens on `fixture`, in build order: its fixture
// root, the extra roots of `open.cold.root-<n>`, and for an e2e case the
// seeded server root.
function cachesOf(benchCase: BenchCase, fixture: string): CacheNeed[] {
  return [
    ...[1, ...extraRootsOf(benchCase)].map((repos) => ({
      fixture,
      repos,
      server: false,
    })),
    ...(benchCase.suite === 'e2e' ? [{ fixture, repos: 1, server: true }] : []),
  ];
}

// The command that builds one cache: `cli.ts fixture` in a child.
function defaultBuildCommand(
  fixture: string,
  repos: number,
  server: boolean
): string[] {
  return [
    process.execPath,
    CLI,
    'fixture',
    fixture,
    ...(server ? ['--server'] : ['--repos', String(repos)]),
  ];
}

// Builds one cache in a child process under the pre-build budget, so a build
// that runs out of memory or time is classified the way a case child is
// (`spawnBudgeted` and `classify`) instead of taking the suite run down or
// hanging it. Returns null on success.
async function buildFixture(
  need: CacheNeed,
  budgetMs: number,
  command: NonNullable<SuiteEnv['buildCommand']>
): Promise<BuildFailure | null> {
  const { fixture, repos, server } = need;
  const outcome = await spawnBudgeted(
    command(fixture, repos, server),
    budgetMs
  );
  const status = classify(outcome, true);
  if (status === 'ok') return null;
  const reason = failureNote(
    {
      status,
      stderr: outcome.stderrTail,
      exitCode: outcome.exitCode,
      reported: true,
    },
    budgetMs,
    resolveFixture(fixture).ops
  );
  return { status, note: `fixture pre-build failed: ${reason}` };
}

// Builds every fixture cache the jobs will open, before anything is timed.
// Cases still call `fixtureDir` themselves and then hit the cache, so the
// first case on a fixture does not spend its budget building it. Returns the
// builds that failed; the jobs that need them are recorded as setup failures
// without running, so a fixture that cannot be built costs one budget, not
// one per case. Sweep fixtures are built last, smallest first, and once one
// size fails the larger ones are not attempted: they would only fail the
// same way more slowly, and every sweep stops at the failed size anyway.
async function prebuildFixtures(
  jobs: readonly Job[],
  sweepSizes: readonly number[],
  budgetMs: number,
  command: NonNullable<SuiteEnv['buildCommand']>,
  log: (line: string) => void
): Promise<BuildFailures> {
  const wanted = new Map<string, CacheNeed>();
  const sweepWanted = new Map<string, CacheNeed>();
  for (const job of jobs) {
    if (job.kind === 'case') {
      for (const need of cachesOf(job.benchCase, job.fixture)) {
        wanted.set(fixtureKey(need), need);
      }
      continue;
    }
    for (const n of [...sweepSizes].sort((a, b) => a - b)) {
      for (const need of cachesOf(job.benchCase, sweepSpec(n).name)) {
        sweepWanted.set(fixtureKey(need), need);
      }
    }
  }
  const failures: BuildFailures = new Map();
  await buildAll(wanted, budgetMs, command, log, failures);
  let failedSweep: string | undefined;
  for (const [key, need] of sweepWanted) {
    if (wanted.has(key)) {
      if (failures.has(key)) failedSweep ??= need.fixture;
      continue;
    }
    if (failedSweep !== undefined) {
      log(`fixture ${need.fixture}: skipped, ${failedSweep} failed`);
      continue;
    }
    await buildAll(new Map([[key, need]]), budgetMs, command, log, failures);
    if (failures.has(key)) failedSweep = need.fixture;
  }
  return failures;
}

// Builds each cache in `needs` in order, adding a failed build to
// `failures`. A seeded server root is built from its fixture root, so it is
// skipped, with the same failure, when that root failed.
async function buildAll(
  needs: ReadonlyMap<string, CacheNeed>,
  budgetMs: number,
  command: NonNullable<SuiteEnv['buildCommand']>,
  log: (line: string) => void,
  failures: BuildFailures
): Promise<void> {
  for (const [key, need] of needs) {
    // A seeded server root is built from the fixture root, so it cannot be
    // built when that failed.
    const base = failures.get(fixtureKey({ ...need, server: false }));
    if (need.server && base !== undefined) {
      failures.set(key, base);
      continue;
    }
    const name = need.server
      ? `${need.fixture} server root`
      : `${need.fixture}${need.repos > 1 ? ` with ${need.repos} repositories` : ''}`;
    log(`fixture ${name}`);
    const failure = await buildFixture(need, budgetMs, command);
    if (failure === null) continue;
    log(`fixture ${name}: ${failure.status}, ${failure.note}`);
    failures.set(key, failure);
  }
}

// The first failed pre-build among the caches `benchCase` opens on `fixture`.
function failedBuildOf(
  failures: BuildFailures,
  benchCase: BenchCase,
  fixture: string
): BuildFailure | undefined {
  for (const need of cachesOf(benchCase, fixture)) {
    const failure = failures.get(fixtureKey(need));
    if (failure !== undefined) return failure;
  }
  return undefined;
}

// Runs one case job. A failed pre-build becomes a setup failure without a
// spawn. A page-cache drop that throws becomes an `error` result for this
// job only, so one bad drop does not end an hours-long record.
async function runCaseJob(
  job: Extract<Job, { kind: 'case' }>,
  opts: RunOptions,
  failures: BuildFailures,
  dropPageCache: (() => Promise<void>) | undefined
): Promise<CaseResult> {
  const { benchCase, fixture, pageCache } = job;
  const caseOpts: RunOptions = {
    ...opts,
    ...(pageCache !== undefined && { pageCache }),
  };
  const failed = failedBuildOf(failures, benchCase, fixture);
  if (failed !== undefined) {
    return setupFailure(benchCase.id, fixture, caseOpts, failed);
  }
  let dropError: string | undefined;
  const beforeSample = async () => {
    try {
      await dropPageCache?.();
    } catch (error) {
      dropError = error instanceof Error ? error.message : Bun.inspect(error);
      throw error;
    }
  };
  try {
    return await runCase(benchCase.id, fixture, {
      ...caseOpts,
      ...(pageCache === 'dropped' && { beforeSample }),
    });
  } catch (error) {
    if (dropError === undefined) throw error;
    return setupFailure(benchCase.id, fixture, caseOpts, {
      status: 'error',
      note: `dropping the page cache failed: ${dropError}`,
    });
  }
}

// Runs one sweep job over the sizes before the first one whose pre-build
// failed; that size, if any, becomes the sweep's failure point, and the
// sweep's note says it was the fixture pre-build that failed, not the case.
async function runSweepJob(
  job: Extract<Job, { kind: 'sweep' }>,
  sweepSizes: readonly number[],
  opts: RunOptions,
  failures: BuildFailures
): Promise<SweepResult> {
  const failedAt = sweepSizes.findIndex(
    (n) =>
      failedBuildOf(failures, job.benchCase, sweepSpec(n).name) !== undefined
  );
  const sizes = failedAt === -1 ? sweepSizes : sweepSizes.slice(0, failedAt);
  const result = await runSweep(job.benchCase.id, sizes, opts);
  const n = sweepSizes[failedAt];
  if (n === undefined || result.status !== 'ok') return result;
  const failure = failedBuildOf(failures, job.benchCase, sweepSpec(n).name);
  return {
    ...result,
    status: failure?.status ?? 'error',
    failedAtN: n,
    note: failure?.note ?? 'fixture pre-build failed',
  };
}

// Three significant digits below 100 ms, whole milliseconds above.
function formatMs(ms: number): string {
  return ms >= 100 ? Math.round(ms).toString() : ms.toPrecision(3);
}

// One progress line for a finished case or sweep.
function describe(job: Job, result: CaseResult | SweepResult): string {
  if (job.kind === 'sweep') {
    const s = result as SweepResult;
    const fit =
      s.exponent === null
        ? 'no fit'
        : `exponent ${s.exponent.toFixed(2)} (r² ${s.r2?.toFixed(3)})`;
    return `sweep ${s.id}: ${s.status}, ${fit}`;
  }
  const c = result as CaseResult;
  const mode = c.pageCache === undefined ? '' : ` (${c.pageCache})`;
  const p50 = c.p50Ms === null ? '' : `, p50 ${formatMs(c.p50Ms)} ms`;
  return `${c.id} ${c.fixture}${mode}: ${c.status}${p50}${c.note === undefined ? '' : `, ${c.note}`}`;
}

// Runs a suite and returns the run, unvalidated and unwritten. Each case runs
// on the fixtures it supports among `opts.fixtures`, in that order (a
// `serial` case on their `-serial` variants); a cold case runs once per
// page-cache mode, others once. With `sweeps`, every sweep case also runs
// the history-length sweep, warm only. Rejects with the
// runner's `Interrupted` when the process is signalled mid-case.
export async function runSuite(
  opts: SuiteOptions,
  env: SuiteEnv
): Promise<BenchRun> {
  const recordedAt = new Date().toISOString();
  for (const fixture of opts.fixtures) resolveFixture(fixture);
  if (opts.pageCache.includes('dropped') && env.dropPageCache === undefined) {
    throw new Error('a dropped page-cache run needs dropPageCache');
  }
  const lookup = env.registryFor ?? registryFor;
  const sweepSizes = env.sweepSizes ?? SWEEP_SIZES;

  const excludes = (opts.exclude ?? []).map((pattern) => ({
    pattern,
    glob: new Bun.Glob(pattern),
    matched: false,
  }));
  // Whether `id` matches any exclusion; marks every glob that matches it.
  const excluded = (id: string) => {
    let hit = false;
    for (const e of excludes) {
      if (!e.glob.match(id)) continue;
      e.matched = true;
      hit = true;
    }
    return hit;
  };

  const allCases: BenchCase[] = [];
  const jobs: Job[] = [];
  const sweepJobs: Job[] = [];
  const suites: SuiteName[] =
    opts.suite === 'all' ? ['library', 'e2e'] : [opts.suite];
  for (const suite of suites) {
    const registry = lookup(suite);
    if (registry === null) {
      env.log(`${suite} suite not available yet`);
      continue;
    }
    const mod = (await import(registry)) as { default: readonly BenchCase[] };
    for (const benchCase of mod.default) {
      allCases.push(benchCase);
      if (excluded(benchCase.id)) continue;
      for (const requested of opts.fixtures) {
        if (!benchCase.fixtures.includes(requested)) continue;
        const fixture =
          benchCase.variant === 'serial'
            ? serialSpec(resolveFixture(requested)).name
            : requested;
        const modes = benchCase.cold === true ? opts.pageCache : [undefined];
        for (const pageCache of modes) {
          jobs.push({ kind: 'case', registry, benchCase, fixture, pageCache });
        }
      }
      if (opts.sweeps && benchCase.sweep === true) {
        sweepJobs.push({ kind: 'sweep', registry, benchCase });
      }
    }
  }
  jobs.push(...sweepJobs);
  // A glob that matches nothing is most likely a typo or a renamed case, and
  // the case it meant to leave out is now running.
  for (const e of excludes) {
    if (!e.matched) env.log(`--exclude ${e.pattern} matched no case`);
  }

  const prebuildBudgetMs = opts.prebuildBudgetMs ?? opts.budgetMs;
  const failures = await prebuildFixtures(
    jobs,
    sweepSizes,
    prebuildBudgetMs,
    env.buildCommand ?? defaultBuildCommand,
    env.log
  );

  const method = {
    repeats: opts.repeats,
    warmup: opts.warmup,
    budgetMs: opts.budgetMs,
  };
  const cases: CaseResult[] = [];
  const sweeps: SweepResult[] = [];
  for (const [i, job] of jobs.entries()) {
    const runOpts = { ...method, registry: job.registry };
    let result: CaseResult | SweepResult;
    if (job.kind === 'sweep') {
      result = await runSweepJob(job, sweepSizes, runOpts, failures);
      sweeps.push(result);
    } else {
      result = await runCaseJob(job, runOpts, failures, env.dropPageCache);
      cases.push(result);
    }
    env.log(`[${i + 1}/${jobs.length}] ${describe(job, result)}`);
  }

  return {
    schemaVersion: 1,
    commit: env.commit,
    dirty: env.dirty,
    suiteVersion: suiteVersion(allCases),
    recordedAt,
    machine: env.machine,
    method: { ...method, prebuildBudgetMs, isolation: 'subprocess' },
    cases,
    sweeps,
  };
}

// Everything the `run` and `record` commands read from or do to the host,
// so tests can substitute each part.
export interface Host {
  /** `BENCH_MACHINE`: the machine file the result is filed under. */
  machineId: string | undefined;
  probe: MachineProbe;
  machinesDir: string;
  /** Uncommitted paths in the checkout (bench/results excluded). */
  dirtyPaths(): string[];
  /** Whether `sudo -n` works without a password prompt. */
  sudoOk(): boolean;
  commit(): { sha: string; short: string };
  dropPageCache(): Promise<void>;
  /** `bench/results`: where `record` files results. */
  resultsDir: string;
  /** `bench/out`: where `run` writes when no `--out` is given. */
  outDir: string;
  runSuite: typeof runSuite;
  log(line: string): void;
  /** Environment variables `compare` and `noise` read; process.env by default. */
  env?: Record<string, string | undefined>;
  /** The thresholds `compare` reads without `--thresholds`. */
  thresholdsFile?: string;
}

// The committed thresholds of the PR check's runner, from the noise study.
export const THRESHOLDS_FILE = join(
  BENCH_ROOT,
  'thresholds',
  'github-ubuntu-latest.json'
);

// Runs git in the repository root (or `root`) and returns its stdout,
// throwing on a non-zero exit.
function git(args: string[], root = REPO_ROOT): string {
  const result = Bun.spawnSync(['git', '-C', root, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`
    );
  }
  return result.stdout.toString();
}

// Uncommitted or untracked paths anywhere in the checkout at `root`. The
// whole tree counts, not just packages/ and bench/: bun.lock, the root
// package.json, patches/ and tsconfig.options.json all change what a run
// measures. bench/results is left out, because a result file written by an
// earlier record changes nothing that is measured. Gitignored paths (the
// fixture cache, bench/out, build output) are never listed by git.
export function gitDirtyPaths(root = REPO_ROOT): string[] {
  const out = git(
    ['status', '--porcelain', '--', '.', ':(exclude)bench/results'],
    root
  );
  return parsePorcelain(out);
}

// The paths in `git status --porcelain` output. Each line is a two-letter
// status, a space and the path, so leading spaces belong to the status.
export function parsePorcelain(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.slice(3));
}

function sudoWorks(): boolean {
  try {
    return (
      Bun.spawnSync(['sudo', '-n', 'true'], {
        stdout: 'ignore',
        stderr: 'ignore',
      }).exitCode === 0
    );
  } catch {
    return false;
  }
}

// Flushes dirty pages and drops the kernel page cache, dentries and inodes,
// so the next cold sample reads from disk.
async function dropPageCache(): Promise<void> {
  const proc = Bun.spawn(DROP_PAGE_CACHE, { stdout: 'ignore', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`dropping the page cache failed: ${stderr.trim()}`);
  }
}

// The real host: this machine, this checkout and `BENCH_MACHINE`.
export function defaultHost(): Host {
  return {
    machineId: process.env.BENCH_MACHINE,
    probe: hostProbe,
    machinesDir: MACHINES_DIR,
    dirtyPaths: gitDirtyPaths,
    sudoOk: sudoWorks,
    commit: () => ({
      sha: git(['rev-parse', 'HEAD']).trim(),
      short: git(['rev-parse', '--short', 'HEAD']).trim(),
    }),
    dropPageCache,
    resultsDir: join(BENCH_ROOT, 'results'),
    outDir: join(BENCH_ROOT, 'out'),
    runSuite,
    log: (line) => process.stderr.write(`${line}\n`),
  };
}

// Validates a run against the schema and writes it as indented JSON. A run
// that fails validation is a bug in the suite, so nothing is written.
export function writeRun(path: string, run: BenchRun): void {
  const errors = validateRun(run);
  if (errors.length > 0) {
    throw new Error(`run does not match the schema:\n${errors.join('\n')}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
}

// `bench record [--baseline]`: checks the machine with `preflight`, then runs
// every suite on every recorded fixture, with sweeps and both page-cache
// modes, and files the result as results/<machine>/<date>-<short sha>.json.
// `--baseline` also copies it to baseline.json. Returns the exit code.
export async function record(
  argv: readonly string[],
  host: Host
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { baseline: { type: 'boolean', default: false } },
    strict: true,
  });

  const id = host.machineId;
  if (id === undefined || readMachineFile(id, host.machinesDir) === undefined) {
    const known = knownMachines(host.machinesDir).join(', ');
    host.log(
      `bench record: set BENCH_MACHINE to a machine in bench/machines (${known})${id === undefined ? '' : `; there is no ${id}.json`}`
    );
    return 1;
  }

  const machine = detectMachine(id, {
    probe: host.probe,
    machinesDir: host.machinesDir,
  });
  const refusal = preflight({
    loadAvg1: machine.loadAvg1,
    memAvailableBytes: machine.memAvailableBytes,
    dirtyPaths: host.dirtyPaths(),
    sudoOk: host.sudoOk(),
    needSudo: true,
  });
  if (refusal !== null) {
    host.log(
      `bench record: refusing to start:\n  ${refusal.split('\n').join('\n  ')}`
    );
    return 1;
  }

  const { sha, short } = host.commit();
  const keepalive = setInterval(() => host.sudoOk(), SUDO_KEEPALIVE_MS);
  let run: BenchRun;
  try {
    run = await host.runSuite(
      {
        suite: 'all',
        fixtures: RECORD_FIXTURES,
        sweeps: true,
        pageCache: ['warm', 'dropped'],
        ...RECORD_METHOD,
      },
      {
        machine,
        commit: sha,
        dirty: false,
        dropPageCache: host.dropPageCache,
        log: host.log,
      }
    );
  } finally {
    clearInterval(keepalive);
  }

  // The tree must still be the commit the run names: an edit during a
  // multi-hour record would otherwise go unnoticed.
  const changed = host.dirtyPaths();
  if (changed.length > 0) {
    host.log(
      `bench record: the checkout changed during the run (${changed.slice(0, 5).join(', ')}); no result written`
    );
    return 1;
  }

  const dir = join(host.resultsDir, id);
  const file = join(dir, `${run.recordedAt.slice(0, 10)}-${short}.json`);
  writeRun(file, run);
  host.log(`wrote ${file}`);
  if (values.baseline) {
    copyFileSync(file, join(dir, 'baseline.json'));
    host.log(`copied it to ${join(dir, 'baseline.json')}`);
  }
  return 0;
}
