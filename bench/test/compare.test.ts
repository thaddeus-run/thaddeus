import { afterAll, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/cli';
import {
  compareRuns,
  type Comparison,
  deriveThresholds,
  mergeRuns,
  renderSummary,
  runnerImage,
  type Thresholds,
} from '../src/compare';
import { defaultHost, type Host, runSuite } from '../src/record';
import {
  type BenchRun,
  type CaseResult,
  type Machine,
  validateRun,
} from '../src/result';
import { percentile } from '../src/stats';

const scratch = mkdtempSync(join(tmpdir(), 'bench-compare-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SUITE_FAKES = join(import.meta.dir, 'fixtures', 'suite-cases.ts');

const machine: Machine = {
  id: 'local',
  description: 'test',
  cpu: 'test cpu',
  vcpus: 4,
  memoryBytes: 7 * 2 ** 30,
  virtualization: 'KVM',
  os: 'linux',
  bun: '1.3.14',
  loadAvg1: 0.1,
  memAvailableBytes: 4 * 2 ** 30,
};

const meta = {
  studiedAt: '2026-10-26T00:00:00.000Z',
  runnerImage: 'ubuntu24-20261020.1',
  suiteVersion: 'suite-a',
  pairs: 20,
};

// One case result with `p50` as its only sample (or no samples when null).
function caseOf(
  p50: number | null,
  over: Partial<CaseResult> = {}
): CaseResult {
  const samplesMs = p50 === null ? [] : [p50];
  return {
    id: 'oplog.write',
    version: 1,
    suite: 'library',
    fixture: 'small',
    manifestHash: 'm1',
    status: 'ok',
    budgetMs: 120_000,
    repeats: 1,
    warmup: 0,
    samplesMs,
    p50Ms: p50,
    p95Ms: p50,
    cv: p50 === null ? null : 0,
    peakRssBytes: 1024,
    ...over,
  };
}

function runOf(cases: CaseResult[], over: Partial<BenchRun> = {}): BenchRun {
  return {
    schemaVersion: 1,
    commit: 'c'.repeat(40),
    dirty: false,
    suiteVersion: 'suite-a',
    recordedAt: '2026-10-26T01:00:00.000Z',
    machine,
    method: {
      repeats: 1,
      warmup: 0,
      budgetMs: 120_000,
      isolation: 'subprocess',
    },
    cases,
    sweeps: [],
    ...over,
  };
}

const base = (p50: number | null, over: Partial<CaseResult> = {}) =>
  runOf([caseOf(p50, over)], { commit: 'b'.repeat(40) });
const head = (p50: number | null, over: Partial<CaseResult> = {}) =>
  runOf([caseOf(p50, over)], { commit: 'h'.repeat(40) });

function thresholdsOf(
  perCase: Record<string, number>,
  over: Partial<Thresholds> = {}
): Thresholds {
  return { ...meta, perCase, ...over };
}

// Compares two one-case runs under a threshold of `t` for that case.
function cmp(b: BenchRun, h: BenchRun, t: number): Comparison {
  return compareRuns(b, h, thresholdsOf({ 'oplog.write@1': t }));
}

function verdict(c: Comparison): string {
  return c.rows[0].verdict;
}

const baseRun = base(100);
const headRun = head(150);

test('a threshold is the 99th percentile of the A/A ratios', () => {
  const t = deriveThresholds(
    { 'oplog.write@1': [1.0, 1.02, 0.98, 1.05, 1.01] },
    meta
  );
  expect(t.perCase['oplog.write@1']).toBeCloseTo(
    percentile([1.0, 1.02, 0.98, 1.05, 1.01], 99),
    9
  );
  expect(t).toMatchObject(meta);
});

test('a threshold is floored at 1.0', () => {
  expect(deriveThresholds({ 'x@1': [0.9, 0.95] }, meta).perCase['x@1']).toBe(1);
});

test('a case with no A/A ratios gets no threshold', () => {
  expect(deriveThresholds({ 'x@1': [] }, meta).perCase).toEqual({});
});

test('the ratio against the threshold decides the verdict', () => {
  expect(verdict(cmp(base(100), head(130), 1.2))).toBe('regression');
  expect(verdict(cmp(base(100), head(110), 1.2))).toBe('ok');
  expect(verdict(cmp(base(100), head(70), 1.2))).toBe('improvement');
  const row = cmp(base(100), head(130), 1.2).rows[0];
  expect(row).toMatchObject({
    baseP50: 100,
    headP50: 130,
    threshold: 1.2,
  });
  expect(row.ratio).toBeCloseTo(1.3, 9);
});

test('cases match only on id, version and manifest hash', () => {
  const version = cmp(
    base(100, { version: 1 }),
    head(100, { version: 2 }),
    1.2
  );
  expect(verdict(version)).toBe('not-compared');
  expect(version.rows[0].reason).toContain('version');
  const manifest = cmp(
    base(100, { manifestHash: 'a' }),
    head(100, { manifestHash: 'b' }),
    1.2
  );
  expect(verdict(manifest)).toBe('not-compared');
  expect(manifest.rows[0].reason).toContain('manifest');
});

test('a status change wins over the threshold', () => {
  expect(verdict(cmp(base(null, { status: 'exceeded' }), head(50), 1.2))).toBe(
    'improvement'
  );
  expect(verdict(cmp(base(50), head(null, { status: 'oom' }), 1.2))).toBe(
    'regression'
  );
  expect(verdict(cmp(base(50), head(null, { status: 'error' }), 1.2))).toBe(
    'regression'
  );
  expect(verdict(cmp(base(50), head(null, { status: 'exceeded' }), 1.2))).toBe(
    'regression'
  );
  const both = cmp(
    base(null, { status: 'exceeded' }),
    head(null, { status: 'oom' }),
    1.2
  );
  expect(verdict(both)).toBe('not-compared');
  expect(both.rows[0].reason).toContain('exceeded');
  expect(both.regressed).toBe(false);
});

test('a status change is a regression even without thresholds', () => {
  const c = compareRuns(base(50), head(null, { status: 'oom' }), null);
  expect(verdict(c)).toBe('regression');
  expect(c.regressed).toBe(true);
});

test('without thresholds every comparable case has no threshold', () => {
  expect(verdict(compareRuns(baseRun, headRun, null))).toBe('no-threshold');
  expect(compareRuns(baseRun, headRun, null).regressed).toBe(false);
  expect(compareRuns(baseRun, headRun, null).thresholds).toBe('none');
});

test('a case missing from the thresholds has no threshold', () => {
  const c = compareRuns(baseRun, headRun, thresholdsOf({ 'other@1': 1.1 }));
  expect(verdict(c)).toBe('no-threshold');
  expect(c.regressed).toBe(false);
});

test('thresholds for another suite version are stale and unused', () => {
  const c = compareRuns(
    baseRun,
    headRun,
    thresholdsOf({ 'oplog.write@1': 1.2 }, { suiteVersion: 'suite-old' })
  );
  expect(c.thresholds).toBe('stale');
  expect(verdict(c)).toBe('no-threshold');
  expect(c.regressed).toBe(false);
  expect(renderSummary(c)).toContain('stale');
});

test('a regression sets regressed', () => {
  expect(cmp(base(100), head(130), 1.2).regressed).toBe(true);
  expect(cmp(base(100), head(110), 1.2).regressed).toBe(false);
  expect(cmp(base(100), head(70), 1.2).regressed).toBe(false);
});

test('cases on one side only are new or removed, not compared', () => {
  const c = compareRuns(
    runOf([caseOf(10, { id: 'gone' })]),
    runOf([caseOf(10, { id: 'fresh' })]),
    null
  );
  expect(c.rows.map((r) => [r.key, r.verdict, r.reason])).toEqual([
    ['gone@1 small', 'not-compared', 'removed in head'],
    ['fresh@1 small', 'not-compared', 'new in head'],
  ]);
});

test('page-cache modes of a cold case are compared separately', () => {
  const both = (p: number) =>
    runOf([
      caseOf(p, { id: 'open.cold', pageCache: 'warm' }),
      caseOf(p * 2, { id: 'open.cold', pageCache: 'dropped' }),
    ]);
  const c = compareRuns(both(10), both(10), null);
  expect(c.rows.map((r) => [r.key, r.ratio])).toEqual([
    ['open.cold@1 small warm', 1],
    ['open.cold@1 small dropped', 1],
  ]);
});

test('the summary lists regressions first and says what was compared', () => {
  const b = runOf([
    caseOf(100, { id: 'steady' }),
    caseOf(100, { id: 'slower' }),
    caseOf(100, { id: 'faster' }),
  ]);
  const h = runOf([
    caseOf(100, { id: 'steady' }),
    caseOf(200, { id: 'slower' }),
    caseOf(50, { id: 'faster' }),
  ]);
  const md = renderSummary(
    compareRuns(
      b,
      h,
      thresholdsOf({ 'steady@1': 1.1, 'slower@1': 1.1, 'faster@1': 1.1 })
    )
  );
  const lines = md.split('\n').filter((line) => line.startsWith('| '));
  expect(lines[0]).toContain('Case');
  expect(lines[2]).toContain('slower@1 small');
  expect(lines[2]).toContain('regression');
  expect(lines[3]).toContain('faster@1 small');
  expect(lines[4]).toContain('steady@1 small');
  expect(md).toContain('1 regression');
  expect(md).toContain(meta.runnerImage);
});

test('the summary says when there is no thresholds file', () => {
  expect(renderSummary(compareRuns(baseRun, headRun, null))).toContain(
    'no thresholds'
  );
});

test('merging rounds concatenates samples per case and re-summarizes', () => {
  const round = (samples: number[], rss: number) =>
    runOf([
      caseOf(null, {
        samplesMs: samples,
        p50Ms: samples[0],
        repeats: samples.length,
        peakRssBytes: rss,
        throughput: { value: 10, unit: 'ops/s' },
      }),
    ]);
  const merged = mergeRuns([round([1, 2, 3], 100), round([4, 5, 6], 300)]);
  expect(validateRun(merged)).toEqual([]);
  expect(merged.cases).toHaveLength(1);
  const c = merged.cases[0];
  expect(c.samplesMs).toEqual([1, 2, 3, 4, 5, 6]);
  expect(c.p50Ms).toBe(3.5);
  expect(c.repeats).toBe(6);
  expect(c.peakRssBytes).toBe(300);
  expect(c.throughput).toEqual({ value: 10, unit: 'ops/s' });
  expect(merged.method.repeats).toBe(2);
});

test('merging keeps a failed round as the case status', () => {
  const merged = mergeRuns([
    runOf([caseOf(5)]),
    runOf([caseOf(null, { status: 'exceeded', note: 'over budget' })]),
  ]);
  expect(merged.cases[0]).toMatchObject({
    status: 'exceeded',
    note: 'over budget',
    samplesMs: [5],
  });
});

test('merging keeps cases with different manifests apart', () => {
  const merged = mergeRuns([
    runOf([caseOf(5, { manifestHash: 'a' })]),
    runOf([caseOf(6, { manifestHash: 'b' })]),
  ]);
  expect(merged.cases).toHaveLength(2);
});

test('merging refuses runs of different commits', () => {
  expect(() =>
    mergeRuns([runOf([], { commit: 'a' }), runOf([], { commit: 'b' })])
  ).toThrow('commit');
});

test('the runner image comes from ImageOS and ImageVersion', () => {
  expect(runnerImage({ ImageOS: 'ubuntu24', ImageVersion: '20261020.1' })).toBe(
    'ubuntu24-20261020.1'
  );
  expect(runnerImage({})).toBe('unknown');
});

// A Host whose suite runs return canned runs, so the CLI commands can be
// tested without timing anything.
function fakeHost(
  runs: (call: number) => BenchRun,
  logs: string[],
  env: Record<string, string | undefined> = {}
): Host {
  let call = 0;
  return {
    ...defaultHost(),
    machineId: undefined,
    dirtyPaths: () => [],
    commit: () => ({ sha: 'c'.repeat(40), short: 'ccccccc' }),
    runSuite: () => Promise.resolve(runs(call++)),
    log: (line) => logs.push(line),
    env,
  };
}

function writeJson(name: string, value: unknown): string {
  const path = join(scratch, name);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}

test('compare prints the summary, appends it to the step summary and exits 1 on a regression', async () => {
  const b = writeJson('cmp-base.json', base(100));
  const h = writeJson('cmp-head.json', head(130));
  const t = writeJson(
    'cmp-t.json',
    thresholdsOf({ 'oplog.write@1': 1.2 }, { suiteVersion: 'suite-a' })
  );
  const summary = join(scratch, 'step-summary.md');
  writeFileSync(summary, 'earlier step\n');
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await run(
      ['compare', b, h, '--thresholds', t],
      fakeHost(() => baseRun, [], { GITHUB_STEP_SUMMARY: summary })
    );
  } finally {
    process.stdout.write = write;
  }
  expect(code).toBe(1);
  expect(out.join('')).toContain('regression');
  const written = readFileSync(summary, 'utf8');
  expect(written.startsWith('earlier step\n')).toBe(true);
  expect(written).toContain('oplog.write@1 small');
});

test('compare exits 0 without a regression and reads no thresholds when the file is absent', async () => {
  const b = writeJson('ok-base.json', base(100));
  const h = writeJson('ok-head.json', head(130));
  const write = process.stdout.write.bind(process.stdout);
  const out: string[] = [];
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await run(['compare', b, h], {
      ...fakeHost(() => baseRun, []),
      thresholdsFile: join(scratch, 'absent.json'),
    });
  } finally {
    process.stdout.write = write;
  }
  expect(code).toBe(0);
  expect(out.join('')).toContain('no thresholds');
});

test('compare refuses an explicit thresholds file that does not exist', async () => {
  const b = writeJson('missing-base.json', base(100));
  const logs: string[] = [];
  const code = await run(
    ['compare', b, b, '--thresholds', join(scratch, 'nope.json')],
    fakeHost(() => baseRun, logs)
  );
  expect(code).toBe(2);
  expect(logs.join('\n')).toContain('nope.json');
});

test('compare refuses a file that is not a bench run', async () => {
  const b = writeJson('bad-base.json', { not: 'a run' });
  const logs: string[] = [];
  const code = await run(
    ['compare', b, b],
    fakeHost(() => baseRun, logs)
  );
  expect(code).toBe(1);
  expect(logs.join('\n')).toContain('bad-base.json');
});

test('merge writes one validated run from round files', async () => {
  const r1 = writeJson('round-1.json', runOf([caseOf(1)]));
  const r2 = writeJson('round-2.json', runOf([caseOf(3)]));
  const out = join(scratch, 'merged.json');
  const code = await run(
    ['merge', r1, r2, '--out', out],
    fakeHost(() => baseRun, [])
  );
  expect(code).toBe(0);
  const merged = JSON.parse(readFileSync(out, 'utf8')) as BenchRun;
  expect(merged.cases[0].samplesMs).toEqual([1, 3]);
  expect(merged.cases[0].p50Ms).toBe(2);
});

test('noise runs interleaved A/A pairs and writes thresholds', async () => {
  // Calls alternate A, B within each round: A is always 100 ms, B grows a
  // little with each pair, so every pair has a known ratio.
  const rounds = 2;
  const pairs = 3;
  const runs = (call: number) => {
    const pair = Math.floor(call / (2 * rounds));
    const side = call % 2;
    return runOf([caseOf(side === 0 ? 100 : 100 + pair)]);
  };
  const logs: string[] = [];
  const out = join(scratch, 'thresholds.json');
  const host = fakeHost(runs, logs, {
    ImageOS: 'ubuntu24',
    ImageVersion: '1.0',
  });
  let calls = 0;
  const counted: Host = {
    ...host,
    runSuite: (opts, env) => {
      calls++;
      return host.runSuite(opts, env);
    },
  };
  const code = await run(
    [
      'noise',
      '--rounds',
      String(rounds),
      '--pairs',
      String(pairs),
      '--out',
      out,
    ],
    counted
  );
  expect(code).toBe(0);
  expect(calls).toBe(2 * rounds * pairs);
  const t = JSON.parse(readFileSync(out, 'utf8')) as Thresholds;
  expect(t.pairs).toBe(pairs);
  expect(t.runnerImage).toBe('ubuntu24-1.0');
  expect(t.suiteVersion).toBe('suite-a');
  expect(t.perCase['oplog.write@1']).toBeCloseTo(
    percentile([1.0, 1.01, 1.02], 99),
    9
  );
});

test('run --exclude leaves matching cases out but keeps the suite version', async () => {
  const env = {
    machine,
    commit: 'c'.repeat(40),
    dirty: false,
    log: () => {},
    registryFor: () => SUITE_FAKES,
  };
  const opts = {
    suite: 'library' as const,
    fixtures: ['tiny'],
    sweeps: false,
    pageCache: ['warm' as const],
    repeats: 1,
    warmup: 0,
    budgetMs: 60_000,
  };
  const logs: string[] = [];
  const all = await runSuite(opts, env);
  const some = await runSuite(
    { ...opts, exclude: ['suite.c*', 'no.such.*'] },
    { ...env, log: (line: string) => logs.push(line) }
  );
  expect(all.cases.map((c) => c.id)).toEqual(['suite.cold']);
  expect(some.cases).toEqual([]);
  expect(some.suiteVersion).toBe(all.suiteVersion);
  expect(logs).toContain('--exclude no.such.* matched no case');
});

test('the run command passes --exclude through', async () => {
  let seen: string[] | undefined;
  const host: Host = {
    ...fakeHost(() => baseRun, []),
    runSuite: (opts) => {
      seen = opts.exclude;
      return Promise.resolve(baseRun);
    },
  };
  const out = join(scratch, 'excluded.json');
  const code = await run(
    [
      'run',
      '--exclude',
      'reputation.*.10000, open.cold.root-1000',
      '--out',
      out,
    ],
    host
  );
  expect(code).toBe(0);
  expect(seen).toEqual(['reputation.*.10000', 'open.cold.root-1000']);
  expect(existsSync(out)).toBe(true);
});
