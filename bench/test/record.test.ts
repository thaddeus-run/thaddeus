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
import libraryCases from '../src/cases/index';
import { run } from '../src/cli';
import { detectMachine, type MachineProbe } from '../src/machine';
import {
  defaultHost,
  type Host,
  parsePorcelain,
  preflight,
  record,
  runSuite,
  type SuiteEnv,
  type SuiteOptions,
  suiteVersion,
} from '../src/record';
import { type BenchRun, validateRun } from '../src/result';
import { childrenRunning } from '../src/runner';
import suiteCases from './fixtures/suite-cases';

const SUITE_FAKES = join(import.meta.dir, 'fixtures', 'suite-cases.ts');
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

// The full library suite on tiny, and the first build of the sweep fixtures,
// take longer than bun's 5 s default.
const SLOW = 600_000;

const scratch = mkdtempSync(join(tmpdir(), 'bench-record-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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

const fakeProbe: MachineProbe = {
  cpuinfo: () => 'processor\t: 0\nmodel name\t: Test CPU\n',
  meminfo: () => 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\n',
  loadAvg1: () => 0.1,
  virtualization: () => 'kvm',
  os: () => 'Test OS',
  bun: () => Bun.version,
};

function suiteEnv(overrides: Partial<SuiteEnv> = {}): SuiteEnv {
  return {
    machine: detectMachine('local', { probe: fakeProbe }),
    commit: 'c'.repeat(40),
    dirty: false,
    registryFor: (suite) => (suite === 'library' ? SUITE_FAKES : null),
    sweepSizes: [1_000, 2_000],
    log: () => {},
    ...overrides,
  };
}

test(
  'a cold case gets a warm and a dropped result, and sweeps run warm',
  async () => {
    const lines: string[] = [];
    let drops = 0;
    const result = await runSuite(
      {
        suite: 'all',
        fixtures: ['tiny'],
        sweeps: true,
        pageCache: ['warm', 'dropped'],
        repeats: 2,
        warmup: 0,
        budgetMs: 60_000,
      },
      suiteEnv({
        log: (line) => lines.push(line),
        dropPageCache: () => {
          drops += 1;
          return Promise.resolve();
        },
      })
    );
    expect(validateRun(result)).toEqual([]);
    expect(
      result.cases.map((c) => [c.id, c.fixture, c.pageCache, c.status])
    ).toEqual([
      ['suite.cold', 'tiny', 'warm', 'ok'],
      ['suite.cold', 'tiny', 'dropped', 'ok'],
    ]);
    // One drop before each of the dropped run's two per-sample children.
    expect(drops).toBe(2);
    expect(result.sweeps.map((s) => [s.id, s.points.length])).toEqual([
      ['suite.sweep', 2],
    ]);
    expect(result.suiteVersion).toBe(suiteVersion(suiteCases));
    expect(result.method).toEqual({
      repeats: 2,
      warmup: 0,
      budgetMs: 60_000,
      isolation: 'subprocess',
    });
    expect(lines).toContain('e2e suite not available yet');
  },
  SLOW
);

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
    // The sweep stops at its first size, whose fixture never got built.
    expect(result.sweeps).toEqual([
      expect.objectContaining({
        id: 'suite.sweep',
        status: 'exceeded',
        failedAtN: 1_000,
        points: [],
      }),
    ]);
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
    expect(result.sweeps.map((s) => [s.status, s.failedAtN])).toEqual([
      ['error', 1_000],
    ]);
    expect(spawned).toEqual([]);
  },
  SLOW
);

test(
  'a page-cache drop that throws fails only its own job',
  async () => {
    const result = await runSuite(
      {
        suite: 'library',
        fixtures: ['tiny'],
        sweeps: false,
        pageCache: ['dropped', 'warm'],
        repeats: 1,
        warmup: 0,
        budgetMs: 60_000,
      },
      suiteEnv({
        dropPageCache: () =>
          Promise.reject(new Error('sudo: a password is required')),
      })
    );
    expect(validateRun(result)).toEqual([]);
    expect(
      result.cases.map((c) => [c.pageCache, c.status, c.phase, c.note])
    ).toEqual([
      [
        'dropped',
        'error',
        'setup',
        'dropping the page cache failed: sudo: a password is required',
      ],
      ['warm', 'ok', undefined, undefined],
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

// A host that answers from fixed values and records what `record` asked the
// suite to run, without running it.
function fakeHost(overrides: Partial<Host> = {}): {
  host: Host;
  calls: { opts: SuiteOptions; env: SuiteEnv }[];
  lines: string[];
} {
  const calls: { opts: SuiteOptions; env: SuiteEnv }[] = [];
  const lines: string[] = [];
  const host: Host = {
    ...defaultHost(),
    machineId: 'kvm-epyc-rome-4vcpu',
    probe: fakeProbe,
    dirtyPaths: () => [],
    sudoOk: () => true,
    commit: () => ({ sha: 'a'.repeat(40), short: 'aaaaaaa' }),
    dropPageCache: () => Promise.resolve(),
    resultsDir: mkdtempSync(join(scratch, 'results-')),
    runSuite: (opts, env): Promise<BenchRun> => {
      calls.push({ opts, env });
      return Promise.resolve({
        schemaVersion: 1,
        commit: env.commit,
        dirty: env.dirty,
        suiteVersion: 'v',
        recordedAt: '2026-10-25T12:00:00.000Z',
        machine: env.machine,
        method: {
          repeats: opts.repeats,
          warmup: opts.warmup,
          budgetMs: opts.budgetMs,
          isolation: 'subprocess',
        },
        cases: [],
        sweeps: [],
      });
    },
    log: (line) => lines.push(line),
    ...overrides,
  };
  return { host, calls, lines };
}

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

test('run --suite e2e says the suite is not available yet', async () => {
  const out = join(scratch, 'e2e.json');
  const { host, lines } = fakeHost({ runSuite });
  expect(await run(['run', '--suite', 'e2e', '--out', out], host)).toBe(0);
  expect(lines).toContain('e2e suite not available yet');
  const written = JSON.parse(readFileSync(out, 'utf8')) as BenchRun;
  expect(written.cases).toEqual([]);
});

test(
  'run writes a schema-valid file',
  async () => {
    const out = join(scratch, 'run.json');
    const { host } = fakeHost({ runSuite, machineId: undefined });
    await run(
      [
        'run',
        '--suite',
        'library',
        '--fixtures',
        'tiny',
        '--repeats',
        '1',
        '--warmup',
        '0',
        '--out',
        out,
      ],
      host
    );
    const written = JSON.parse(readFileSync(out, 'utf8')) as BenchRun;
    expect(validateRun(written)).toEqual([]);
    expect(written.suiteVersion).toBe(suiteVersion(libraryCases));
    expect(written.machine.id).toBe('local');
    expect(written.method.budgetMs).toBe(120_000);
    expect(written.method.repeats).toBe(1);
    expect(written.method.warmup).toBe(0);
    expect(written.cases.map((c) => c.id).sort()).toEqual(
      libraryCases.map((c) => c.id).sort()
    );
    // Warm only: `run` asks for the dropped page cache only on request.
    expect(
      written.cases
        .filter((c) => c.pageCache !== undefined)
        .map((c) => c.pageCache)
    ).toEqual(['warm', 'warm', 'warm', 'warm']);
  },
  SLOW
);

test(
  'SIGINT stops a run with exit code 130 and writes no result',
  async () => {
    const out = join(scratch, 'interrupted.json');
    const proc = Bun.spawn(
      [
        process.execPath,
        CLI,
        'run',
        '--fixtures',
        'tiny',
        '--repeats',
        '1',
        '--warmup',
        '0',
        '--out',
        out,
      ],
      { stdout: 'ignore', stderr: 'pipe' }
    );
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let stderr = '';
    // Signal once the first case has finished, so cases are under way.
    while (!stderr.includes('[1/')) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value, { stream: true });
    }
    proc.kill('SIGINT');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value, { stream: true });
    }
    expect(await proc.exited).toBe(130);
    expect(stderr).toContain('interrupted by SIGINT');
    expect(existsSync(out)).toBe(false);
  },
  SLOW
);
