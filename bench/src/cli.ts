import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { constants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  budgetCaseIds,
  BUDGETS_FILE,
  combineBudgetLines,
  evaluateBudgets,
  readBudgets,
  renderBudgets,
} from './budget';
import {
  compareRuns,
  deriveThresholds,
  mergeRuns,
  renderSummary,
  runnerImage,
  type Thresholds,
} from './compare';
import { seededRoot } from './e2e/seed';
import { gitFixture } from './everyday/git';
import { fixtureDir } from './fixtures/cache';
import { generateFixture } from './fixtures/plan';
import { resolveFixture } from './fixtures/spec';
import { detectMachine, readMachineFile } from './machine';
import {
  defaultHost,
  type Host,
  type PageCacheMode,
  record,
  type SuiteEnv,
  type SuiteName,
  type SuiteOptions,
  THRESHOLDS_FILE,
  UsageError,
  writeRun,
} from './record';
import { type BenchRun, validateRun } from './result';
import { childrenRunning, Interrupted } from './runner';

const USAGE = `usage:
  bun src/cli.ts run [--suite library|e2e|everyday|all] [--fixtures small,medium] [--sweeps]
                     [--repeats N] [--warmup N] [--page-cache warm,dropped]
                     [--exclude glob,...] [--only glob,...] [--out file]
                     [--budget-ms N] [--prebuild-budget-ms N]
  BENCH_MACHINE=<id> bun src/cli.ts record [--baseline]
  bun src/cli.ts fixture <name> [--repos N | --server | --git]
                     build a fixture cache (or the e2e seeded server root, or the
                     everyday suite's bare git repository), print its path
  bun src/cli.ts merge <round.json>... --out file
                     merge round files of one commit into one run
  bun src/cli.ts compare <base.json> <head.json> [--thresholds file]
                     print a base/head summary; exit 1 on a regression
  bun src/cli.ts budget <run.json>... [--budgets file]
                     report runs against the everyday-command budgets; exit 0
                     even when a target is missed
  bun src/cli.ts budget --case-ids [--budgets file]
                     print the comma-joined ids of the cases the budgets measure
  bun src/cli.ts noise [--rounds R] [--pairs P] [--suite ...] [--fixtures ...]
                     [--repeats N] [--warmup N] [--exclude glob,...] [--only glob,...]
                     [--out file]
                     A/A noise study of this commit; writes the thresholds file`;

// `run` defaults for the method. The budget is a fifth of `record`'s.
const RUN_DEFAULTS = { repeats: 10, warmup: 2, budgetMs: 120_000 };

// The PR check's method (see .github/workflows/bench.yml). The noise study
// defaults to it, because thresholds only hold for the method they were
// measured with.
const PR_METHOD = { repeats: 3, warmup: 1, rounds: 5, pairs: 20 };

// The machine id of a `run` without BENCH_MACHINE.
const LOCAL_MACHINE = 'local';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

// A process killed by a signal conventionally exits with 128 + its number.
function exitCodeFor(signal: NodeJS.Signals): number {
  return 128 + constants.signals[signal];
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function count(name: string, value: string, min: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new UsageError(`--${name} must be an integer of at least ${min}`);
  }
  return n;
}

// The parseArgs options that pick the cases and the method, shared by `run`
// and `noise` with their own repeat and warm-up defaults.
function suiteFlags(defaults: { repeats: number; warmup: number }) {
  return {
    suite: { type: 'string', default: 'library' },
    fixtures: { type: 'string', default: 'small' },
    repeats: { type: 'string', default: String(defaults.repeats) },
    warmup: { type: 'string', default: String(defaults.warmup) },
    exclude: { type: 'string', default: '' },
    only: { type: 'string', default: '' },
  } as const;
}

// Turns parsed suite flags into suite options (warm, no sweeps; `run` adds
// those flags itself), throwing a UsageError on a bad value.
function suiteOptionsOf(values: {
  suite: string;
  fixtures: string;
  repeats: string;
  warmup: string;
  exclude: string;
  only: string;
}): SuiteOptions {
  const suite = values.suite;
  if (
    suite !== 'library' &&
    suite !== 'e2e' &&
    suite !== 'everyday' &&
    suite !== 'all'
  ) {
    throw new UsageError(`unknown suite ${suite}`);
  }
  return {
    suite: suite as SuiteName | 'all',
    fixtures: list(values.fixtures),
    sweeps: false,
    pageCache: ['warm'],
    repeats: count('repeats', values.repeats, 1),
    warmup: count('warmup', values.warmup, 0),
    budgetMs: RUN_DEFAULTS.budgetMs,
    exclude: list(values.exclude),
    only: list(values.only),
  };
}

// The machine and commit a `run` or `noise` measures, with the commit's
// short sha, or an exit code when BENCH_MACHINE names no machine file.
function suiteEnvOf(host: Host): { env: SuiteEnv; short: string } | number {
  const id = host.machineId ?? LOCAL_MACHINE;
  if (
    host.machineId !== undefined &&
    readMachineFile(id, host.machinesDir) === undefined
  ) {
    host.log(`bench: BENCH_MACHINE=${id} has no file in bench/machines`);
    return 1;
  }
  const { sha, short } = host.commit();
  const env = {
    machine: detectMachine(id, {
      probe: host.probe,
      machinesDir: host.machinesDir,
    }),
    commit: sha,
    dirty: host.dirtyPaths().length > 0,
    dropPageCache: host.dropPageCache,
    log: host.log,
  };
  return { env, short };
}

// `bench run`: runs a suite with the given method and writes the result to
// `--out` (default bench/out/<date>-<short sha>.json). Unlike `record` it has
// no preflight: a dirty tree is recorded as `dirty: true`, not refused.
async function runCommand(
  argv: readonly string[],
  host: Host
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      ...suiteFlags(RUN_DEFAULTS),
      sweeps: { type: 'boolean', default: false },
      'page-cache': { type: 'string', default: 'warm' },
      out: { type: 'string' },
      'budget-ms': { type: 'string', default: String(RUN_DEFAULTS.budgetMs) },
      'prebuild-budget-ms': { type: 'string' },
    },
    strict: true,
  });

  const opts = suiteOptionsOf(values);
  opts.budgetMs = count('budget-ms', values['budget-ms'], 1);
  if (values['prebuild-budget-ms'] !== undefined) {
    opts.prebuildBudgetMs = count(
      'prebuild-budget-ms',
      values['prebuild-budget-ms'],
      1
    );
  }
  const pageCache = list(values['page-cache']);
  for (const mode of pageCache) {
    if (mode !== 'warm' && mode !== 'dropped') {
      throw new UsageError(`unknown page-cache mode ${mode}`);
    }
  }
  if (pageCache.includes('dropped') && !host.sudoOk()) {
    host.log(
      'bench run: --page-cache dropped needs sudo -n to drop the page cache; run sudo -v first'
    );
    return 1;
  }
  const target = suiteEnvOf(host);
  if (typeof target === 'number') return target;

  const run = await host.runSuite(
    {
      ...opts,
      sweeps: values.sweeps,
      pageCache: pageCache as PageCacheMode[],
    },
    target.env
  );
  const out =
    values.out === undefined
      ? join(host.outDir, `${run.recordedAt.slice(0, 10)}-${target.short}.json`)
      : resolve(values.out);
  writeRun(out, run);
  host.log(`wrote ${out}`);
  return 0;
}

// Reads and validates a BenchRun file, or throws a FileError naming it.
function readRun(path: string): BenchRun {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new FileError(`${path}: ${(error as Error).message}`);
  }
  const errors = validateRun(value);
  if (errors.length > 0) {
    throw new FileError(
      `${path} is not a bench run:\n  ${errors.slice(0, 5).join('\n  ')}`
    );
  }
  return value as BenchRun;
}

// Reads a thresholds file, or throws a FileError naming it when it is not
// one. Only the fields `compareRuns` relies on are checked.
function readThresholds(path: string): Thresholds {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new FileError(`${path}: ${(error as Error).message}`);
  }
  const t = value as Partial<Thresholds> | null;
  const perCase = t?.perCase;
  const valid =
    typeof t?.suiteVersion === 'string' &&
    typeof t.studiedAt === 'string' &&
    typeof t.runnerImage === 'string' &&
    typeof t.pairs === 'number' &&
    t.method === 'lognormal-family-wise' &&
    typeof t.familySize === 'number' &&
    (t.z === null || typeof t.z === 'number') &&
    typeof perCase === 'object' &&
    perCase !== null &&
    Object.values(perCase).every((v) => typeof v === 'number' && v >= 1);
  if (!valid) throw new FileError(`${path} is not a thresholds file`);
  return value as Thresholds;
}

// Writes a thresholds file through a temporary file and a rename, so a
// study killed mid-write never leaves a truncated file behind.
function writeThresholds(path: string, thresholds: Thresholds): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(thresholds, null, 2)}\n`);
  renameSync(tmp, path);
}

// A bad input file: printed without the usage, exit code 1.
class FileError extends Error {
  override name = 'FileError';
}

// `bench merge <round.json>... --out file`: merges the round files of one
// commit (the PR check runs each side in interleaved rounds) into one run.
function mergeCommand(argv: readonly string[], host: Host): number {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { out: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length === 0) throw new UsageError('merge takes round files');
  if (values.out === undefined) throw new UsageError('merge needs --out');
  let merged: BenchRun;
  try {
    merged = mergeRuns(positionals.map(readRun));
  } catch (error) {
    if (error instanceof FileError) throw error;
    throw new FileError(`merge: ${(error as Error).message}`);
  }
  const out = resolve(values.out);
  writeRun(out, merged);
  host.log(`merged ${positionals.length} rounds into ${out}`);
  return 0;
}

// `bench compare <base.json> <head.json> [--thresholds file]`: prints the
// markdown summary, appends it to $GITHUB_STEP_SUMMARY when that is set, and
// exits 1 when a case regressed. Without `--thresholds` it reads the
// committed file and compares without thresholds when there is none yet.
function compareCommand(argv: readonly string[], host: Host): number {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { thresholds: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const [basePath, headPath, ...extra] = positionals;
  if (basePath === undefined || headPath === undefined || extra.length > 0) {
    throw new UsageError('compare takes a base and a head run');
  }
  const explicit = values.thresholds;
  if (explicit !== undefined && !existsSync(explicit)) {
    throw new UsageError(`no thresholds file at ${explicit}`);
  }
  const thresholdsPath = explicit ?? host.thresholdsFile ?? THRESHOLDS_FILE;
  const thresholds = existsSync(thresholdsPath)
    ? readThresholds(thresholdsPath)
    : null;
  const cmp = compareRuns(readRun(basePath), readRun(headPath), thresholds);
  const summary = renderSummary(cmp);
  process.stdout.write(summary);
  const stepSummary = (host.env ?? process.env).GITHUB_STEP_SUMMARY;
  if (stepSummary !== undefined && stepSummary !== '') {
    appendFileSync(stepSummary, summary);
  }
  return cmp.regressed ? 1 : 0;
}

// `bench budget <run.json>... [--budgets file]`: sets the runs against the
// everyday-command budgets, prints the Markdown report and appends it to
// $GITHUB_STEP_SUMMARY when that is set. Runs of one commit and suite
// version are merged first; runs of different commits cannot be, so each
// group is evaluated on its own and the lines are combined (see
// `combineBudgetLines`). A missed target is reported and does not change the
// exit code. `--case-ids` prints the ids of the cases the budgets measure
// (what CI runs) and exits 0.
function budgetCommand(argv: readonly string[], host: Host): number {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      budgets: { type: 'string' },
      'case-ids': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  let budgets;
  try {
    budgets = readBudgets(values.budgets ?? BUDGETS_FILE);
  } catch (error) {
    throw new FileError((error as Error).message);
  }
  if (values['case-ids']) {
    if (positionals.length > 0) {
      throw new UsageError('budget --case-ids takes no run files');
    }
    process.stdout.write(`${budgetCaseIds(budgets).join(',')}\n`);
    return 0;
  }
  if (positionals.length === 0) throw new UsageError('budget takes run files');
  const groups = new Map<string, BenchRun[]>();
  for (const path of positionals) {
    const r = readRun(path);
    const key = `${r.commit}\0${r.suiteVersion}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const sets = [...groups.values()].map((group) => {
    try {
      const [only, ...more] = group;
      return evaluateBudgets(
        more.length === 0 ? only : mergeRuns(group),
        budgets
      );
    } catch (error) {
      throw new FileError(`budget: ${(error as Error).message}`);
    }
  });
  const report = renderBudgets(combineBudgetLines(sets));
  process.stdout.write(report);
  const stepSummary = (host.env ?? process.env).GITHUB_STEP_SUMMARY;
  if (stepSummary !== undefined && stepSummary !== '') {
    appendFileSync(stepSummary, report);
  }
  return 0;
}

// `bench noise --rounds R --pairs P`: the A/A noise study. Each pair runs
// this commit as "base" and again as "head", interleaved round by round the
// way the PR check runs base and head, merges each side and records every
// case's head/base p50 ratio. Noise is all that separates the two sides, so
// the ratios set each case's threshold (see `deriveThresholds`). Rewrites
// the thresholds file (by default the committed one) after every pair.
async function noiseCommand(
  argv: readonly string[],
  host: Host
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      ...suiteFlags(PR_METHOD),
      rounds: { type: 'string', default: String(PR_METHOD.rounds) },
      pairs: { type: 'string', default: String(PR_METHOD.pairs) },
      out: { type: 'string' },
    },
    strict: true,
  });
  const opts = suiteOptionsOf(values);
  const rounds = count('rounds', values.rounds, 1);
  const pairs = count('pairs', values.pairs, 1);
  const target = suiteEnvOf(host);
  if (typeof target === 'number') return target;
  const { env } = target;

  const out = values.out === undefined ? THRESHOLDS_FILE : resolve(values.out);
  const studiedAt = new Date().toISOString();
  const image = runnerImage(host.env ?? process.env);
  const ratios: Record<string, number[]> = {};
  for (let pair = 1; pair <= pairs; pair++) {
    const a: BenchRun[] = [];
    const b: BenchRun[] = [];
    for (let round = 1; round <= rounds; round++) {
      host.log(`noise: pair ${pair}/${pairs}, round ${round}/${rounds}`);
      a.push(await host.runSuite(opts, env));
      b.push(await host.runSuite(opts, env));
    }
    const cmp = compareRuns(mergeRuns(a), mergeRuns(b), null);
    for (const row of cmp.rows) {
      if (row.ratio === null) continue;
      (ratios[row.thresholdKey] ??= []).push(row.ratio);
    }
    const pairRatios = cmp.rows.flatMap((r) => r.ratio ?? []);
    host.log(
      pairRatios.length === 0
        ? `noise: pair ${pair}/${pairs} done, no case ok on both sides`
        : `noise: pair ${pair}/${pairs} done, largest ratio ${Math.max(...pairRatios).toFixed(3)}`
    );
    // Rewritten after every pair, so a study cut off by the job's time
    // limit still leaves the thresholds of the pairs it finished.
    writeThresholds(
      out,
      deriveThresholds(ratios, {
        studiedAt,
        runnerImage: image,
        suiteVersion: a[0].suiteVersion,
        pairs: pair,
      })
    );
  }
  host.log(`wrote ${out}`);
  return 0;
}

// `bench fixture <name> [--repos N | --server | --git]`: builds the cached
// FileBackend root of a fixture (with N - 1 filler repositories), or with
// `--server` the e2e suite's seeded server root, or with `--git` the everyday
// suite's bare git repository of the same plan, and prints its path. Suite
// runs call it in a child process to build caches before timing anything.
async function fixtureCommand(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      repos: { type: 'string', default: '1' },
      server: { type: 'boolean', default: false },
      git: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [name, ...extra] = positionals;
  if (name === undefined || extra.length > 0) {
    throw new UsageError('fixture takes one fixture name');
  }
  let spec;
  try {
    spec = resolveFixture(name);
  } catch (error) {
    throw new UsageError(String((error as Error).message));
  }
  const repos = count('repos', values.repos, 1);
  if (values.server && repos !== 1) {
    throw new UsageError('--server takes no --repos');
  }
  if (values.git && (values.server || repos !== 1)) {
    throw new UsageError('--git takes no --repos or --server');
  }
  const plan = generateFixture(spec);
  const dir = values.git
    ? await gitFixture(plan)
    : values.server
      ? await seededRoot(plan)
      : await fixtureDir(plan, { repos });
  process.stdout.write(`${dir}\n`);
  return 0;
}

// Runs one bench command and returns its exit code. An interrupted case
// means the run is incomplete, so nothing is written and the exit code is
// the signal's.
export async function run(
  argv: readonly string[],
  host: Host = defaultHost()
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'run') return await runCommand(rest, host);
    if (command === 'record') return await record(rest, host);
    if (command === 'fixture') return await fixtureCommand(rest);
    if (command === 'merge') return mergeCommand(rest, host);
    if (command === 'compare') return compareCommand(rest, host);
    if (command === 'budget') return budgetCommand(rest, host);
    if (command === 'noise') return await noiseCommand(rest, host);
    throw new UsageError(
      command === undefined ? 'no command' : `unknown command ${command}`
    );
  } catch (error) {
    if (error instanceof Interrupted) {
      host.log(`bench: interrupted by ${error.signal}; no result written`);
      return exitCodeFor(error.signal);
    }
    const parseError =
      error instanceof TypeError &&
      String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS');
    if (error instanceof FileError) {
      host.log(`bench: ${error.message}`);
      return 1;
    }
    if (error instanceof UsageError || parseError) {
      host.log(`bench: ${error.message}\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}

// While a case child or a fixture build runs, the runner listens for these
// signals too: it kills the child, removes its work directory and rejects
// with `Interrupted`, which `run` turns into the exit code. With no child
// running (between cases) nothing else would stop the process, so this
// listener exits at once.
function onSignal(signal: NodeJS.Signals): void {
  if (childrenRunning()) return;
  process.stderr.write(`bench: interrupted by ${signal}; no result written\n`);
  process.exit(exitCodeFor(signal));
}

if (import.meta.main) {
  for (const signal of SIGNALS) process.on(signal, () => onSignal(signal));
  process.exit(await run(process.argv.slice(2)));
}
