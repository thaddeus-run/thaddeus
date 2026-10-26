import { afterAll, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BenchCase } from '../src/case';
import { run } from '../src/cli';
import { generateFixture, manifestHash } from '../src/fixtures/plan';
import { sweepSpec } from '../src/fixtures/spec';
import {
  BENCH_ROOT,
  type Host,
  parsePorcelain,
  preflight,
  record,
  registryFor,
  runSuite,
  type SuiteOptions,
  suiteVersion,
} from '../src/record';
import { type BenchRun, validateRun } from '../src/result';
import { childrenRunning } from '../src/runner';
import {
  fakeProbe,
  fakeHost as makeFakeHost,
  suiteEnv,
} from './fixtures/suite-env';

// The record and suite-builder tests that spawn no real case work: the
// preflight, the record and run commands over a fake host, and suite runs
// whose fixture pre-builds are stand-in commands. Suite runs that time real
// or fake cases end to end are in test-slow/record-suite.test.ts.

// Suite runs here spawn short stand-in builds and, at most, a few fake case
// children, which can take longer than bun's 5 s default on a busy machine.
const SLOW = 60_000;

const scratch = mkdtempSync(join(tmpdir(), 'bench-record-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const fakeHost = (overrides: Partial<Host> = {}) =>
  makeFakeHost(scratch, overrides);

const quiet = {
  loadAvg1: 0.2,
  memAvailableBytes: 3 * 2 ** 30,
  dirtyPaths: [],
  sudoOk: true,
  needSudo: true,
};

test('a quiet, clean machine with sudo passes the preflight', () => {
  expect(preflight(quiet)).toBeNull();
});

test('the preflight refuses a busy machine', () => {
  expect(preflight({ ...quiet, loadAvg1: 0.6 })).toContain(
    'load average 0.6 is above 0.5'
  );
  expect(preflight({ ...quiet, loadAvg1: 0.5 })).toBeNull();
});

test('the preflight refuses a machine short of memory', () => {
  expect(preflight({ ...quiet, memAvailableBytes: 1.9 * 2 ** 30 })).toContain(
    'less than 2 GiB available'
  );
  expect(preflight({ ...quiet, memAvailableBytes: 2 * 2 ** 30 })).toBeNull();
});

test('the preflight refuses uncommitted changes and names them', () => {
  const reason = preflight({
    ...quiet,
    dirtyPaths: ['packages/log/src/oplog.ts'],
  });
  expect(reason).toContain('uncommitted changes');
  expect(reason).toContain('packages/log/src/oplog.ts');
});

test('the preflight refuses when sudo -n is needed but unavailable', () => {
  expect(preflight({ ...quiet, sudoOk: false })).toContain('sudo -v');
  expect(preflight({ ...quiet, sudoOk: false, needSudo: false })).toBeNull();
});

test('the preflight lists every reason at once', () => {
  const reason = preflight({ ...quiet, loadAvg1: 3, sudoOk: false }) ?? '';
  expect(reason).toContain('load average 3 is above 0.5');
  expect(reason).toContain('sudo -v');
});

test('parsePorcelain keeps the path after the two-letter status', () => {
  expect(
    parsePorcelain(' M bench/moon.yml\n?? bench/machines/\nM  a b.ts\n')
  ).toEqual(['bench/moon.yml', 'bench/machines/', 'a b.ts']);
  expect(parsePorcelain('')).toEqual([]);
});

test('suiteVersion hashes the sorted id@version lines', () => {
  const a = { id: 'a', version: 1 } as BenchCase;
  const b = { id: 'b', version: 1 } as BenchCase;
  const v = suiteVersion([a, b]);
  expect(v).toMatch(/^[0-9a-f]{64}$/);
  expect(suiteVersion([b, a])).toBe(v);
  expect(suiteVersion([a, { ...b, version: 2 }])).not.toBe(v);
  expect(suiteVersion([a])).not.toBe(v);
});

// Runs the fake suite on tiny, warm and dropped, with sweeps, while every
// fixture pre-build runs `buildCommand` instead of the real build. Returns
// the run, the log, how often the cache was dropped and which case children
// started.
async function suiteWithFailingBuilds(
  buildCommand: () => string[],
  budgetMs: number
): Promise<{
  run: BenchRun;
  lines: string[];
  drops: number;
  spawned: string[];
}> {
  const probeDir = mkdtempSync(join(scratch, 'probe-'));
  process.env.SUITE_PROBE_DIR = probeDir;
  const lines: string[] = [];
  let drops = 0;
  try {
    const result = await runSuite(
      {
        suite: 'library',
        fixtures: ['tiny'],
        sweeps: true,
        pageCache: ['warm', 'dropped'],
        repeats: 2,
        warmup: 0,
        budgetMs,
      },
      suiteEnv({
        log: (line) => lines.push(line),
        buildCommand,
        dropPageCache: () => {
          drops += 1;
          return Promise.resolve();
        },
      })
    );
    return { run: result, lines, drops, spawned: readdirSync(probeDir) };
  } finally {
    delete process.env.SUITE_PROBE_DIR;
  }
}

test(
  'a pre-build that overruns the budget becomes a setup result per job',
  async () => {
    const {
      run: result,
      lines,
      drops,
      spawned,
    } = await suiteWithFailingBuilds(() => ['sleep', '30'], 300);
    expect(validateRun(result)).toEqual([]);
    expect(
      result.cases.map((c) => [
        c.id,
        c.pageCache,
        c.status,
        c.phase,
        c.failedAtN,
        c.note,
      ])
    ).toEqual([
      [
        'suite.cold',
        'warm',
        'exceeded',
        'setup',
        20,
        'fixture pre-build failed: exceeded 300 ms at n = 20',
      ],
      [
        'suite.cold',
        'dropped',
        'exceeded',
        'setup',
        20,
        'fixture pre-build failed: exceeded 300 ms at n = 20',
      ],
    ]);
    expect(result.cases.every((c) => c.samplesMs.length === 0)).toBe(true);
    // The sweep stops at its first size, whose fixture never got built, and
    // says so; the larger size is not even attempted.
    expect(result.sweeps).toEqual([
      expect.objectContaining({
        id: 'suite.sweep',
        status: 'exceeded',
        failedAtN: 1_000,
        points: [],
        note: 'fixture pre-build failed: exceeded 300 ms at n = 1000',
      }),
    ]);
    expect(lines).toContain('fixture sweep-2000: skipped, sweep-1000 failed');
    // Without a pre-build budget of its own, a pre-build gets the case budget.
    expect(result.method.prebuildBudgetMs).toBe(300);
    // No case child ran, so nothing dropped the cache or left a probe.
    expect(drops).toBe(0);
    expect(spawned).toEqual([]);
    expect(lines).toContain(
      'fixture tiny: exceeded, fixture pre-build failed: exceeded 300 ms at n = 20'
    );
    expect(childrenRunning()).toBe(false);
  },
  SLOW
);

test(
  'a pre-build that fails records its stderr as the note',
  async () => {
    const { run: result, spawned } = await suiteWithFailingBuilds(
      () => ['sh', '-c', 'echo disk full >&2; exit 1'],
      60_000
    );
    expect(result.cases.map((c) => [c.status, c.failedAtN, c.note])).toEqual([
      ['error', undefined, 'fixture pre-build failed: disk full'],
      ['error', undefined, 'fixture pre-build failed: disk full'],
    ]);
    expect(result.sweeps.map((s) => [s.status, s.failedAtN, s.note])).toEqual([
      ['error', 1_000, 'fixture pre-build failed: disk full'],
    ]);
    expect(spawned).toEqual([]);
  },
  SLOW
);

// A sweep-only suite run (no case fixtures) whose pre-builds run
// `command(fixture)`, with three sweep sizes. Returns the run, the log and
// the fixtures whose build was started, in order.
async function sweepSuite(
  command: (fixture: string) => string[],
  budgets: { budgetMs: number; prebuildBudgetMs?: number }
): Promise<{ run: BenchRun; lines: string[]; builds: string[] }> {
  const lines: string[] = [];
  const builds: string[] = [];
  const result = await runSuite(
    {
      suite: 'library',
      fixtures: [],
      sweeps: true,
      pageCache: ['warm'],
      repeats: 1,
      warmup: 0,
      ...budgets,
    },
    suiteEnv({
      log: (line) => lines.push(line),
      sweepSizes: [1_000, 2_000, 4_000],
      buildCommand: (fixture) => {
        builds.push(fixture);
        return command(fixture);
      },
    })
  );
  return { run: result, lines, builds };
}

test(
  'pre-builds run under their own budget, which the method records',
  async () => {
    const { run: result } = await sweepSuite(() => ['sleep', '30'], {
      budgetMs: 60_000,
      prebuildBudgetMs: 300,
    });
    expect(validateRun(result)).toEqual([]);
    expect(result.method).toEqual({
      repeats: 1,
      warmup: 0,
      budgetMs: 60_000,
      prebuildBudgetMs: 300,
      isolation: 'subprocess',
    });
    expect(result.sweeps.map((s) => s.note)).toEqual([
      'fixture pre-build failed: exceeded 300 ms at n = 1000',
    ]);
  },
  SLOW
);

test(
  'sweep pre-builds stop at the first size that fails, and the sweep says it was the build',
  async () => {
    const {
      run: result,
      lines,
      builds,
    } = await sweepSuite(
      (fixture) =>
        fixture === 'sweep-2000'
          ? ['sh', '-c', 'echo no space >&2; exit 1']
          : ['true'],
      { budgetMs: 60_000 }
    );
    expect(validateRun(result)).toEqual([]);
    expect(builds).toEqual(['sweep-1000', 'sweep-2000']);
    expect(lines).toContain('fixture sweep-4000: skipped, sweep-2000 failed');
    const [sweep] = result.sweeps;
    expect(sweep.status).toBe('error');
    expect(sweep.failedAtN).toBe(2_000);
    expect(sweep.note).toBe('fixture pre-build failed: no space');
    // The size before the failure still ran, and names its fixture's hash.
    expect(sweep.points).toEqual([
      expect.objectContaining({
        n: 1_000,
        manifestHash: manifestHash(generateFixture(sweepSpec(1_000))),
      }),
    ]);
  },
  SLOW
);

test('a suite run asking for dropped needs a way to drop the cache', async () => {
  const opts: SuiteOptions = {
    suite: 'library',
    fixtures: ['tiny'],
    sweeps: false,
    pageCache: ['dropped'],
    repeats: 1,
    warmup: 0,
    budgetMs: 1_000,
  };
  const error = await runSuite(opts, suiteEnv()).catch((e: unknown) => e);
  expect(String(error)).toContain('dropPageCache');
});

test('a suite run rejects an unknown fixture before running anything', async () => {
  const opts: SuiteOptions = {
    suite: 'library',
    fixtures: ['huge'],
    sweeps: false,
    pageCache: ['warm'],
    repeats: 1,
    warmup: 0,
    budgetMs: 1_000,
  };
  const error = await runSuite(opts, suiteEnv()).catch((e: unknown) => e);
  expect(String(error)).toContain('unknown fixture huge');
});

test('record runs everything and writes <machine>/<date>-<sha>.json', async () => {
  const { host, calls } = fakeHost();
  expect(await record(['--baseline'], host)).toBe(0);
  expect(calls).toHaveLength(1);
  const { opts, env } = calls[0];
  expect(opts).toEqual({
    suite: 'all',
    fixtures: ['small', 'medium', 'stress'],
    sweeps: true,
    pageCache: ['warm', 'dropped'],
    repeats: 10,
    warmup: 2,
    budgetMs: 600_000,
    prebuildBudgetMs: 1_800_000,
  });
  expect(env.dirty).toBe(false);
  expect(env.commit).toBe('a'.repeat(40));
  expect(env.machine.id).toBe('kvm-epyc-rome-4vcpu');
  expect(env.machine.loadAvg1).toBe(0.1);
  expect(env.machine.memAvailableBytes).toBe(4_096_000_000);
  const dir = join(host.resultsDir, 'kvm-epyc-rome-4vcpu');
  const file = join(dir, '2026-10-25-aaaaaaa.json');
  const written = JSON.parse(readFileSync(file, 'utf8'));
  expect(validateRun(written)).toEqual([]);
  expect(readFileSync(join(dir, 'baseline.json'), 'utf8')).toBe(
    readFileSync(file, 'utf8')
  );
});

test('record writes nothing when the tree changed during the run', async () => {
  let checks = 0;
  const { host, calls, lines } = fakeHost({
    dirtyPaths: () => (checks++ === 0 ? [] : ['packages/log/src/oplog.ts']),
  });
  expect(await record(['--baseline'], host)).toBe(1);
  expect(calls).toHaveLength(1);
  expect(lines.join('\n')).toContain('changed during the run');
  expect(lines.join('\n')).toContain('packages/log/src/oplog.ts');
  expect(existsSync(join(host.resultsDir, 'kvm-epyc-rome-4vcpu'))).toBe(false);
});

test('record without --baseline leaves baseline.json alone', async () => {
  const { host } = fakeHost();
  expect(await record([], host)).toBe(0);
  const dir = join(host.resultsDir, 'kvm-epyc-rome-4vcpu');
  expect(existsSync(join(dir, '2026-10-25-aaaaaaa.json'))).toBe(true);
  expect(existsSync(join(dir, 'baseline.json'))).toBe(false);
});

test('record refuses a dirty tree before any case runs', async () => {
  const { host, calls, lines } = fakeHost({
    dirtyPaths: () => ['packages/log/src/oplog.ts'],
  });
  expect(await record([], host)).toBe(1);
  expect(calls).toHaveLength(0);
  expect(lines.join('\n')).toContain('uncommitted changes');
  expect(existsSync(join(host.resultsDir, 'kvm-epyc-rome-4vcpu'))).toBe(false);
});

test('record refuses when sudo -n cannot drop the page cache', async () => {
  const { host, calls, lines } = fakeHost({ sudoOk: () => false });
  expect(await record([], host)).toBe(1);
  expect(calls).toHaveLength(0);
  expect(lines.join('\n')).toContain('sudo -v');
});

test('record refuses a busy machine and names the load', async () => {
  const { host, calls, lines } = fakeHost({
    probe: { ...fakeProbe, loadAvg1: () => 1.25 },
  });
  expect(await record([], host)).toBe(1);
  expect(calls).toHaveLength(0);
  expect(lines.join('\n')).toContain('load average 1.25 is above 0.5');
});

test('record needs BENCH_MACHINE to name a file in bench/machines', async () => {
  for (const machineId of [undefined, 'nope']) {
    const { host, calls, lines } = fakeHost({ machineId });
    expect(await record([], host)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(lines.join('\n')).toContain('kvm-epyc-rome-4vcpu');
  }
});

test('run rejects an unknown suite with the usage', async () => {
  const { host, lines } = fakeHost();
  expect(await run(['run', '--suite', 'nope'], host)).toBe(2);
  expect(lines.join('\n')).toContain('usage');
});

test('run --suite e2e runs the e2e suite', async () => {
  const out = join(scratch, 'e2e.json');
  const { host, calls } = fakeHost();
  expect(await run(['run', '--suite', 'e2e', '--out', out], host)).toBe(0);
  expect(calls.map((c) => c.opts.suite)).toEqual(['e2e']);
});

test('the e2e suite has a registry', () => {
  expect(registryFor('e2e')).toBe(join(BENCH_ROOT, 'src', 'e2e', 'cases.ts'));
});
