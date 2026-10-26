import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/cli';
import everydayCases from '../src/everyday/cases';
import { registryFor, runSuite, type SuiteOptions } from '../src/record';
import { validateRun } from '../src/result';
import { fakeHost, suiteEnv } from './fixtures/suite-env';

// The everyday registry's static shape and the suite wiring around it: the
// `--only` filter and what each case needs pre-built. The tests that run the
// cases against real working copies are in test-slow/everyday.test.ts.

const scratch = mkdtempSync(join(tmpdir(), 'bench-everyday-cases-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const EVERYDAY = join(import.meta.dir, '..', 'src', 'everyday', 'cases.ts');
const EVERYDAY_FAKES = join(
  import.meta.dir,
  'fixtures',
  'everyday-suite-cases.ts'
);

test('the everyday suite has the eight local cases', () => {
  expect(everydayCases.map((c) => c.id)).toEqual([
    'wc.status',
    'wc.diff',
    'wc.status.agents8',
    'wc.diff.agents8',
    'git.status',
    'git.diff',
    'git.status.agents8',
    'git.diff.agents8',
  ]);
  for (const c of everydayCases) {
    expect(c.suite).toBe('everyday');
    expect(c.version).toBe(1);
    expect(c.variant).toBe('serial');
    expect(c.isolation).toBe('per-case');
    expect(c.fixtures).toEqual(['tiny', 'small', 'medium', 'stress']);
    expect(c.note).toBeDefined();
  }
});

test('working-copy cases need the fixture cache and git cases the git cache', () => {
  for (const c of everydayCases) {
    expect(c.needs).toEqual(c.id.startsWith('git.') ? ['git'] : ['fixture']);
  }
});

test('the agent cases say they time the slowest of eight concurrent copies', () => {
  const agents = everydayCases.filter((c) => c.id.endsWith('.agents8'));
  expect(agents).toHaveLength(4);
  for (const c of agents) {
    expect(c.note).toContain('8 concurrent copies on one host');
    expect(c.note).toContain('the sample is the slowest');
  }
});

test('the everyday registry is the one suite runs use', () => {
  expect(registryFor('everyday')).toBe(EVERYDAY);
});

const opts: SuiteOptions = {
  suite: 'everyday',
  fixtures: ['tiny'],
  sweeps: false,
  pageCache: ['warm'],
  repeats: 1,
  warmup: 0,
  budgetMs: 60_000,
};

// Runs the fake everyday suite with `buildCommand` standing in for every
// pre-build, and returns the run, the log and each build's
// (fixture, repos, server, git) in order.
async function everydayRun(overrides: Partial<SuiteOptions> = {}) {
  const builds: [string, number, boolean, boolean][] = [];
  const lines: string[] = [];
  const result = await runSuite(
    { ...opts, ...overrides },
    suiteEnv({
      registryFor: (suite) => (suite === 'everyday' ? EVERYDAY_FAKES : null),
      log: (line) => lines.push(line),
      buildCommand: (fixture, repos, server, git) => {
        builds.push([fixture, repos, server, git]);
        return ['true'];
      },
    })
  );
  return { run: result, builds, lines };
}

test('a case builds the caches it needs and no others', async () => {
  const { run: result, builds } = await everydayRun();
  expect(validateRun(result)).toEqual([]);
  expect(result.cases.map((c) => [c.id, c.suite, c.status])).toEqual([
    ['git.fake', 'everyday', 'ok'],
    ['wc.fake', 'everyday', 'ok'],
    ['wc.fake.both', 'everyday', 'ok'],
  ]);
  expect(builds).toEqual([
    ['tiny-serial', 1, false, true],
    ['tiny-serial', 1, false, false],
  ]);
});

test('only: git.* runs the matching cases and builds nothing for the others', async () => {
  const { run: result, builds } = await everydayRun({ only: ['git.*'] });
  expect(result.cases.map((c) => c.id)).toEqual(['git.fake']);
  expect(builds).toEqual([['tiny-serial', 1, false, true]]);
});

test('only keeps the suite version of the full registry', async () => {
  const all = await everydayRun();
  const some = await everydayRun({ only: ['wc.fake'] });
  expect(some.run.cases.map((c) => c.id)).toEqual(['wc.fake']);
  expect(some.run.suiteVersion).toBe(all.run.suiteVersion);
});

test('only takes several globs, and a glob that matches nothing is logged', async () => {
  const { run: result, lines } = await everydayRun({
    only: ['git.*', 'wc.fake.both', 'no.such.*'],
  });
  expect(result.cases.map((c) => c.id)).toEqual(['git.fake', 'wc.fake.both']);
  expect(lines).toContain('--only no.such.* matched no case');
});

test('exclude still applies inside only', async () => {
  const { run: result } = await everydayRun({
    only: ['wc.*'],
    exclude: ['wc.fake.both'],
  });
  expect(result.cases.map((c) => c.id)).toEqual(['wc.fake']);
});

test('--suite all looks up library, e2e and everyday in that order', async () => {
  const looked: string[] = [];
  await runSuite(
    { ...opts, suite: 'all', fixtures: [] },
    suiteEnv({
      registryFor: (suite) => {
        looked.push(suite);
        return null;
      },
    })
  );
  expect(looked).toEqual(['library', 'e2e', 'everyday']);
});

test('run --suite everyday and --only reach the suite options', async () => {
  const { host, calls } = fakeHost(scratch);
  const out = join(scratch, 'everyday.json');
  const args = ['run', '--suite', 'everyday', '--only', 'git.*, wc.status'];
  expect(await run([...args, '--out', out], host)).toBe(0);
  expect(calls[0]?.opts.suite).toBe('everyday');
  expect(calls[0]?.opts.only).toEqual(['git.*', 'wc.status']);
});

test('run --suite all is accepted', async () => {
  const { host, calls } = fakeHost(scratch);
  const out = join(scratch, 'all.json');
  expect(await run(['run', '--suite', 'all', '--out', out], host)).toBe(0);
  expect(calls[0]?.opts.suite).toBe('all');
  expect(calls[0]?.opts.only).toEqual([]);
});
