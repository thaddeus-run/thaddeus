import { constants } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { fixtureDir } from './fixtures/cache';
import { generateFixture } from './fixtures/plan';
import { resolveFixture } from './fixtures/spec';
import { detectMachine, readMachineFile } from './machine';
import {
  defaultHost,
  type Host,
  type PageCacheMode,
  record,
  type SuiteName,
  UsageError,
  writeRun,
} from './record';
import { childrenRunning, Interrupted } from './runner';

const USAGE = `usage:
  bun src/cli.ts run [--suite library|e2e|all] [--fixtures small,medium] [--sweeps]
                     [--repeats N] [--warmup N] [--page-cache warm,dropped] [--out file]
  BENCH_MACHINE=<id> bun src/cli.ts record [--baseline]
  bun src/cli.ts fixture <name> [--repos N]   build a fixture cache, print its path`;

// `run` defaults for the method. The budget is a fifth of `record`'s.
const RUN_DEFAULTS = { repeats: 10, warmup: 2, budgetMs: 120_000 };

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
      suite: { type: 'string', default: 'library' },
      fixtures: { type: 'string', default: 'small' },
      sweeps: { type: 'boolean', default: false },
      repeats: { type: 'string', default: String(RUN_DEFAULTS.repeats) },
      warmup: { type: 'string', default: String(RUN_DEFAULTS.warmup) },
      'page-cache': { type: 'string', default: 'warm' },
      out: { type: 'string' },
    },
    strict: true,
  });

  const suite = values.suite;
  if (suite !== 'library' && suite !== 'e2e' && suite !== 'all') {
    throw new UsageError(`unknown suite ${suite}`);
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
  const id = host.machineId ?? LOCAL_MACHINE;
  if (
    host.machineId !== undefined &&
    readMachineFile(id, host.machinesDir) === undefined
  ) {
    host.log(`bench run: BENCH_MACHINE=${id} has no file in bench/machines`);
    return 1;
  }

  const { sha, short } = host.commit();
  const run = await host.runSuite(
    {
      suite: suite as SuiteName | 'all',
      fixtures: list(values.fixtures),
      sweeps: values.sweeps,
      pageCache: pageCache as PageCacheMode[],
      repeats: count('repeats', values.repeats, 1),
      warmup: count('warmup', values.warmup, 0),
      budgetMs: RUN_DEFAULTS.budgetMs,
    },
    {
      machine: detectMachine(id, {
        probe: host.probe,
        machinesDir: host.machinesDir,
      }),
      commit: sha,
      dirty: host.dirtyPaths().length > 0,
      dropPageCache: host.dropPageCache,
      log: host.log,
    }
  );
  const out =
    values.out === undefined
      ? join(host.outDir, `${run.recordedAt.slice(0, 10)}-${short}.json`)
      : resolve(values.out);
  writeRun(out, run);
  host.log(`wrote ${out}`);
  return 0;
}

// `bench fixture <name> [--repos N]`: builds the cached FileBackend root of a
// fixture (with N - 1 filler repositories) and prints its path. Suite runs
// call it in a child process to build fixtures before timing anything.
async function fixtureCommand(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { repos: { type: 'string', default: '1' } },
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
  const dir = await fixtureDir(generateFixture(spec), { repos });
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
