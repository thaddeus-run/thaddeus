import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import libraryCases from '../src/cases/index';
import { run } from '../src/cli';
import { runSuite, suiteVersion } from '../src/record';
import { type BenchRun, validateRun } from '../src/result';
import suiteCases from '../test/fixtures/suite-cases';
import { fakeHost, suiteEnv } from '../test/fixtures/suite-env';

// Suite runs that spawn case children end to end: the fake suites with real
// fixture builds, the full library suite on tiny, and a real `bench run`
// interrupted by SIGINT. The fast record and suite-builder tests are in
// test/record.test.ts.

const E2E_SUITE_FAKES = join(
  import.meta.dir,
  '..',
  'test',
  'fixtures',
  'e2e-suite-cases.ts'
);
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

// The full library suite on tiny, and the first build of the sweep fixtures,
// take longer than bun's 5 s default.
const SLOW = 600_000;

const scratch = mkdtempSync(join(tmpdir(), 'bench-record-suite-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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
      prebuildBudgetMs: 60_000,
      isolation: 'subprocess',
    });
    expect(lines).toContain('e2e suite not available yet');
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

// Runs the fake e2e suite on tiny with `buildCommand` standing in for every
// pre-build, and returns the run and the (fixture, repos, server) of each
// build in order.
async function e2eSuiteWithBuilds(
  command: (server: boolean) => string[]
): Promise<{ run: BenchRun; builds: [string, number, boolean][] }> {
  const builds: [string, number, boolean][] = [];
  const result = await runSuite(
    {
      suite: 'e2e',
      fixtures: ['tiny'],
      sweeps: false,
      pageCache: ['warm'],
      repeats: 1,
      warmup: 0,
      budgetMs: 60_000,
    },
    suiteEnv({
      registryFor: (suite) => (suite === 'e2e' ? E2E_SUITE_FAKES : null),
      buildCommand: (fixture, repos, server) => {
        builds.push([fixture, repos, server]);
        return command(server);
      },
    })
  );
  return { run: result, builds };
}

test(
  'a serial e2e case pre-builds its variant fixture, then its seeded server root',
  async () => {
    const { run: result, builds } = await e2eSuiteWithBuilds(() => ['true']);
    // A serial case runs on, and pre-builds, the serial variant.
    expect(builds).toEqual([
      ['tiny-serial', 1, false],
      ['tiny-serial', 1, true],
    ]);
    expect(result.cases.map((c) => [c.id, c.fixture, c.status])).toEqual([
      ['suite.e2e', 'tiny-serial', 'ok'],
    ]);
  },
  SLOW
);

test(
  'a failed fixture pre-build skips the seeded root and fails the e2e case in setup',
  async () => {
    const { run: result, builds } = await e2eSuiteWithBuilds(() => [
      'sh',
      '-c',
      'echo no fixture >&2; exit 1',
    ]);
    expect(builds).toEqual([['tiny-serial', 1, false]]);
    expect(result.cases.map((c) => [c.id, c.status, c.phase, c.note])).toEqual([
      ['suite.e2e', 'error', 'setup', 'fixture pre-build failed: no fixture'],
    ]);
  },
  SLOW
);

test(
  'run writes a schema-valid file',
  async () => {
    const out = join(scratch, 'run.json');
    const { host } = fakeHost(scratch, { runSuite, machineId: undefined });
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
