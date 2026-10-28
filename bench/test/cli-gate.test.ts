import { afterAll, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  budgetCaseIds,
  BUDGETS_FILE,
  type Ceilings,
  readBudgets,
} from '../src/budget';
import { run } from '../src/cli';
import { defaultHost, type Host, type SuiteOptions } from '../src/record';
import type { BenchRun } from '../src/result';
import { logMeanStdev, tQuantile } from '../src/stats';
import { ceilingsOf, gateRun } from './fixtures/gate-run';

const scratch = mkdtempSync(join(tmpdir(), 'bench-cli-gate-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const budgets = readBudgets(BUDGETS_FILE);

// A Host whose suite runs return canned runs (and remember their options),
// so the gate commands can be tested without timing anything.
function hostOf(
  runs: (call: number) => BenchRun,
  logs: string[],
  over: Partial<Host> = {}
): { host: Host; seen: SuiteOptions[] } {
  const seen: SuiteOptions[] = [];
  const host: Host = {
    ...defaultHost(),
    machineId: undefined,
    dirtyPaths: () => [],
    sudoOk: () => true,
    commit: () => ({ sha: 'c'.repeat(40), short: 'ccccccc' }),
    runSuite: (opts) => {
      seen.push(opts);
      return Promise.resolve(runs(seen.length - 1));
    },
    outDir: scratch,
    log: (line) => logs.push(line),
    env: {},
    ...over,
  };
  return { host, seen };
}

function writeJson(name: string, value: unknown): string {
  const path = join(scratch, name);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}

// Runs a CLI command and captures what it writes to stdout.
async function cli(
  argv: string[],
  host: Host
): Promise<{ code: number; out: string }> {
  const write = process.stdout.write.bind(process.stdout);
  const out: string[] = [];
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await run(argv, host), out: out.join('') };
  } finally {
    process.stdout.write = write;
  }
}

test('calibrate --runs 3 runs the gate method each time and rewrites the file after every run', async () => {
  const out = join(scratch, 'ceilings-calibrate.json');
  const logs: string[] = [];
  // The thaddeus p50 of status/developer is 1500, 1600, 1700 over the runs.
  const filesBefore: (number | null)[] = [];
  const { host, seen } = hostOf((call) => {
    filesBefore.push(
      existsSync(out)
        ? (JSON.parse(readFileSync(out, 'utf8')) as Ceilings).runs
        : null
    );
    return gateRun(budgets, {
      dropped: true,
      p50s: { 'status/developer': 1500 + call * 100 },
    });
  }, logs);
  const { code } = await cli(['calibrate', '--runs', '3', '--out', out], host);
  expect(code).toBe(0);
  // Before each run the file holds every run done so far.
  expect(filesBefore).toEqual([null, 1, 2]);
  expect(seen).toHaveLength(3);
  for (const opts of seen) {
    expect(opts).toMatchObject({
      suite: 'all',
      fixtures: ['small'],
      pageCache: ['warm', 'dropped'],
      repeats: 3,
      warmup: 1,
      budgetMs: 300_000,
      only: budgetCaseIds(budgets),
    });
  }
  const c = JSON.parse(readFileSync(out, 'utf8')) as Ceilings;
  expect(c.runs).toBe(3);
  expect(c.method).toBe('lognormal-family-wise-t-p50');
  expect(c.pageCache).toEqual(['warm', 'dropped']);
  expect(c.pooled.familySize).toBe(8);
  expect(Object.keys(c.pooled.p50Ceilings)).toContain(
    'ci-checkout/ci small-serial dropped'
  );
  expect(c.caseVersions['e2e.pull']).toBe(1);
  const key = c.pooled.p50Ceilings['status/developer small-serial null'];
  const { mu, sigma } = logMeanStdev([1500, 1600, 1700]);
  expect(key.n).toBe(3);
  expect(key.ceilingMs).toBeCloseTo(
    Math.exp(mu + tQuantile(1 - 0.01 / 8, 2) * sigma),
    6
  );
  expect(
    c.pooled.p50Ceilings['pull/developer small-serial null'].ceilingMs
  ).toBeCloseTo(200, 6);
  // Only the third run has the three p50s a ceiling needs; it logs them for
  // the CPU model group and the pooled one. All runs are one host, so the
  // group is too thin for the gate to use.
  expect(
    logs.filter((l) => l.startsWith('ceilings:   status/developer'))
  ).toHaveLength(2);
  expect(c.pooled).toMatchObject({ runs: 3, hosts: 1 });
  expect(c.byCpu['Test CPU']).toMatchObject({ runs: 3, hosts: 1 });
});

test('calibrate leaves a case that did not finish out of that run only', async () => {
  const out = join(scratch, 'ceilings-partial.json');
  const logs: string[] = [];
  const { host } = hostOf(
    (call) =>
      gateRun(budgets, {
        caseOver: (c) =>
          call === 1 && c.id === 'e2e.pull'
            ? { status: 'exceeded', p50Ms: null, samplesMs: [] }
            : {},
      }),
    logs
  );
  expect(
    (
      await cli(
        ['calibrate', '--runs', '4', '--out', out, '--page-cache', 'warm'],
        host
      )
    ).code
  ).toBe(0);
  const c = JSON.parse(readFileSync(out, 'utf8')) as Ceilings;
  // The pull row has three p50s and the others four.
  expect(c.pooled.p50Ceilings['pull/developer small-serial null'].n).toBe(3);
  expect(c.pooled.p50Ceilings['status/developer small-serial null'].n).toBe(4);
  // The run that lost a case says so; the warm-only study does not report the
  // dropped-cache row it never asked for.
  expect(logs).toContain(
    'calibrate: run 2/4 done, 6 p50s, not ok: pull/developer exceeded'
  );
  expect(logs.join('\n')).not.toContain('ci-checkout');
});

test('calibrate needs --runs, and the dropped mode needs sudo', async () => {
  const logs: string[] = [];
  const { host, seen } = hostOf(() => gateRun(budgets), logs, {
    sudoOk: () => false,
  });
  expect((await cli(['calibrate'], host)).code).toBe(2);
  const noSudo = await cli(
    ['calibrate', '--runs', '3', '--out', join(scratch, 'x.json')],
    host
  );
  expect(noSudo.code).toBe(1);
  expect(logs.join('\n')).toContain('--page-cache warm');
  expect(seen).toHaveLength(0);
});

test('gate-run measures the gate method over the budgeted cases and writes the run', async () => {
  const out = join(scratch, 'gate-run.json');
  const { host, seen } = hostOf(() => gateRun(budgets), []);
  const { code } = await cli(
    ['gate-run', '--page-cache', 'warm', '--out', out],
    host
  );
  expect(code).toBe(0);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    suite: 'all',
    fixtures: ['small'],
    sweeps: false,
    pageCache: ['warm'],
    repeats: 3,
    warmup: 1,
    budgetMs: 300_000,
    only: budgetCaseIds(budgets),
  });
  expect(
    (JSON.parse(readFileSync(out, 'utf8')) as BenchRun).cases
  ).not.toHaveLength(0);
});

test('gate-run defaults to both page-cache modes and refuses without sudo', async () => {
  const { host, seen } = hostOf(() => gateRun(budgets), [], {});
  await cli(['gate-run', '--out', join(scratch, 'gate-run-2.json')], host);
  expect(seen[0].pageCache).toEqual(['warm', 'dropped']);
  const logs: string[] = [];
  const noSudo = hostOf(() => gateRun(budgets), logs, { sudoOk: () => false });
  expect((await cli(['gate-run'], noSudo.host)).code).toBe(1);
  expect(noSudo.seen).toHaveLength(0);
  expect(logs.join('\n')).toContain('sudo -n');
});

test('ceilings derives the file from gate-run result files and logs what each ceiling rests on', async () => {
  const files = [180, 190, 200, 210, 220].map((p50, i) =>
    writeJson(`cei-run-${i}.json`, gateRun(budgets, { p50 }))
  );
  const out = join(scratch, 'ceilings-from-files.json');
  const logs: string[] = [];
  const { host, seen } = hostOf(() => gateRun(budgets), logs);
  const { code } = await cli(['ceilings', ...files, '--out', out], host);
  expect(code).toBe(0);
  // It derives; it measures nothing.
  expect(seen).toHaveLength(0);
  const c = JSON.parse(readFileSync(out, 'utf8')) as Ceilings;
  expect(c.runs).toBe(5);
  expect(c.pageCache).toEqual(['warm']);
  expect(c.pooled.familySize).toBe(7);
  const { mu, sigma } = logMeanStdev([180, 190, 200, 210, 220]);
  const k = c.pooled.p50Ceilings['status/developer small-serial null'];
  expect(k.n).toBe(5);
  expect(k.ceilingMs).toBeCloseTo(
    Math.exp(mu + tQuantile(1 - 0.01 / 7, 4) * sigma),
    6
  );
  // Each file named other than run-<host>-<k>.json is a host of its own, and
  // the log warns about each one.
  expect(c.pooled).toMatchObject({ runs: 5, hosts: 5 });
  for (const file of files) {
    expect(logs).toContain(
      `ceilings: warning: ${file} is not named run-<host>-<k>.json, so it counts as a host of its own`
    );
  }
  expect(
    logs.some((l) =>
      l.startsWith('ceilings:   status/developer small-serial null: n 5')
    )
  ).toBe(true);
  // A file derived this way gates a run of the same method.
  const fresh = writeJson('cei-fresh.json', gateRun(budgets, { p50: 200 }));
  expect(
    (
      await cli(
        ['gate', fresh, '--ceilings', out, '--page-cache', 'warm'],
        host
      )
    ).code
  ).toBe(0);
});

test('ceilings counts hosts from run-<host>-<k>.json names and logs each CPU model group with whether the gate uses it', async () => {
  const dir = join(scratch, 'cei-hosts');
  mkdirSync(dir, { recursive: true });
  const write = (name: string, cpu: string, p50: number) => {
    const base = gateRun(budgets, { p50 });
    const path = join(dir, name);
    writeFileSync(
      path,
      `${JSON.stringify({ ...base, machine: { ...base.machine, cpu } })}\n`
    );
    return path;
  };
  const files = [
    write('run-1-1.json', 'Fast', 100),
    write('run-1-2.json', 'Fast', 102),
    write('run-2-1.json', 'Fast', 99),
    write('run-2-2.json', 'Fast', 101),
    write('run-3-1.json', 'Fast', 103),
    write('run-3-2.json', 'Fast', 98),
    write('run-4-1.json', 'Slow', 200),
    write('run-4-2.json', 'Slow', 205),
  ];
  const out = join(scratch, 'ceilings-hosts.json');
  const logs: string[] = [];
  const { host } = hostOf(() => gateRun(budgets), logs);
  expect((await cli(['ceilings', ...files, '--out', out], host)).code).toBe(0);
  const c = JSON.parse(readFileSync(out, 'utf8')) as Ceilings;
  expect(c.byCpu.Fast).toMatchObject({ runs: 6, hosts: 3 });
  expect(c.byCpu.Slow).toMatchObject({ runs: 2, hosts: 1 });
  expect(c.pooled).toMatchObject({ runs: 8, hosts: 4 });
  // Files named run-<host>-<k>.json draw no warning.
  expect(logs.filter((l) => l.startsWith('ceilings: warning'))).toEqual([]);
  expect(logs).toContain(
    'ceilings: CPU model Fast: 6 runs from 3 hosts, used by the gate'
  );
  expect(logs).toContain(
    'ceilings: CPU model Slow: 2 runs from 1 hosts, too thin for the gate (needs 6 runs from 3 hosts), pooled applies'
  );
  expect(logs).toContain(
    'ceilings: pooled: 8 runs from 4 hosts, used for any other CPU model'
  );
  expect(
    logs.some((l) =>
      /^ceilings: {3}status\/developer small-serial null: n 6, .*ceiling\/geomean 1\.\d+$/.test(
        l
      )
    )
  ).toBe(true);
  // The gate prints which group it used.
  const fresh = writeJson(
    'cei-hosts-fresh.json',
    gateRun(budgets, { p50: 101 })
  );
  const gate = await cli(
    ['gate', fresh, '--ceilings', out, '--page-cache', 'warm'],
    host
  );
  expect(gate.out.split('\n')[0]).toContain(
    'CPU model Test CPU was not calibrated'
  );
});

test('ceilings refuses files of other case versions, files not measured with the gate method, and no files', async () => {
  const good = writeJson('cei-good.json', gateRun(budgets));
  const newer = writeJson(
    'cei-newer.json',
    gateRun(budgets, {
      caseOver: (c) => (c.id === 'wc.diff' ? { version: 2 } : {}),
    })
  );
  const logs: string[] = [];
  const { host } = hostOf(() => gateRun(budgets), logs);
  const out = join(scratch, 'ceilings-refused.json');
  expect((await cli(['ceilings', good, newer, '--out', out], host)).code).toBe(
    1
  );
  expect(logs.join('\n')).toContain(
    'cei-newer.json has other case versions than'
  );
  expect(existsSync(out)).toBe(false);

  const tenRepeats = writeJson(
    'cei-ten.json',
    gateRun(budgets, {
      caseOver: (c) => (c.id === 'wc.status' ? { repeats: 10 } : {}),
    })
  );
  logs.length = 0;
  expect(
    (await cli(['ceilings', good, tenRepeats, '--out', out], host)).code
  ).toBe(1);
  expect(logs.join('\n')).toContain('not measured with the gate method');
  expect(existsSync(out)).toBe(false);

  expect((await cli(['ceilings'], host)).code).toBe(2);
});

test('gate exits 0 on a run within its ceilings and appends the lines to the step summary', async () => {
  const r = gateRun(budgets);
  const file = writeJson('gate-pass-run.json', r);
  const ceilings = writeJson(
    'gate-pass-ceilings.json',
    ceilingsOf(budgets, r, 200)
  );
  const summary = join(scratch, 'gate-summary.md');
  writeFileSync(summary, 'earlier step\n');
  const { host } = hostOf(() => r, [], {
    env: { GITHUB_STEP_SUMMARY: summary },
  });
  const { code, out } = await cli(
    ['gate', file, '--ceilings', ceilings, '--page-cache', 'warm'],
    host
  );
  expect(code).toBe(0);
  expect(out).toContain('ok status/developer small-serial null: p50 200.0 ms');
  const written = readFileSync(summary, 'utf8');
  expect(written.startsWith('earlier step\n')).toBe(true);
  expect(written).toContain('ok status/developer small-serial null');
});

test('gate exits 1 on a regression, a result not measured with the gate method, a missing ceilings file and a bad one', async () => {
  const slow = gateRun(budgets, { p50s: { 'status/developer': 500 } });
  const ceilings = writeJson(
    'gate-fail-ceilings.json',
    ceilingsOf(budgets, gateRun(budgets), 250)
  );
  const file = writeJson('gate-fail-run.json', slow);
  const { host } = hostOf(() => slow, []);
  const regressed = await cli(
    ['gate', file, '--ceilings', ceilings, '--page-cache', 'warm'],
    host
  );
  expect(regressed.code).toBe(1);
  expect(regressed.out).toContain(
    'regression status/developer small-serial null: p50 500.0 ms is above its ceiling 250.0 ms'
  );

  const tenRepeats = writeJson(
    'gate-ten-run.json',
    gateRun(budgets, {
      caseOver: (c) => (c.id === 'wc.status' ? { repeats: 10 } : {}),
    })
  );
  const method = await cli(
    ['gate', tenRepeats, '--ceilings', ceilings, '--page-cache', 'warm'],
    host
  );
  expect(method.code).toBe(1);
  expect(method.out).toContain('not measured with the gate method');

  const missing = await cli(
    ['gate', file, '--ceilings', join(scratch, 'absent.json')],
    host
  );
  expect(missing.code).toBe(1);
  expect(missing.out).toContain('no ceilings file');

  const logs: string[] = [];
  const bad = writeJson('gate-bad-ceilings.json', { nope: true });
  const { host: quiet } = hostOf(() => slow, logs);
  expect((await cli(['gate', file, '--ceilings', bad], quiet)).code).toBe(1);
  expect(logs.join('\n')).toContain('is not a ceilings file');
});

test('gate refuses ceilings that do not cover the gate page-cache modes unless --page-cache names the run modes', async () => {
  const warmOnly = gateRun(budgets);
  const run = writeJson('gate-modes-run.json', warmOnly);
  const warmCeilings = writeJson(
    'gate-modes-warm.json',
    ceilingsOf(budgets, warmOnly, 250)
  );
  const logs: string[] = [];
  const { host } = hostOf(() => warmOnly, logs);

  // The gate method measures warm and dropped, so warm-only ceilings would
  // leave the ci-checkout row ungated: refuse them, and say how to proceed.
  const refused = await cli(['gate', run, '--ceilings', warmCeilings], host);
  expect(refused.code).toBe(1);
  expect(refused.out).toBe('');
  expect(logs.join('\n')).toContain(
    'ceilings cover page-cache warm but the gate checks warm,dropped'
  );
  expect(logs.join('\n')).toContain('--page-cache warm');

  // Naming the modes the run used (warm only) lets the same files gate.
  const named = await cli(
    ['gate', run, '--ceilings', warmCeilings, '--page-cache', 'warm'],
    host
  );
  expect(named.code).toBe(0);

  // Naming a mode the ceilings lack is refused too.
  logs.length = 0;
  const both = await cli(
    ['gate', run, '--ceilings', warmCeilings, '--page-cache', 'warm,dropped'],
    host
  );
  expect(both.code).toBe(1);
  expect(logs.join('\n')).toContain(
    'ceilings cover page-cache warm but the gate checks warm,dropped'
  );

  // Ceilings that cover both modes gate a warm and dropped run with no flag.
  const full = gateRun(budgets, { dropped: true });
  const fullRun = writeJson('gate-modes-full-run.json', full);
  const fullCeilings = writeJson(
    'gate-modes-full.json',
    ceilingsOf(budgets, full, 250, ['warm', 'dropped'])
  );
  expect(
    (await cli(['gate', fullRun, '--ceilings', fullCeilings], host)).code
  ).toBe(0);

  // An unknown mode is a usage error.
  expect((await cli(['gate', run, '--page-cache', 'hot'], host)).code).toBe(2);
});

test('gate takes exactly one run file', async () => {
  const { host } = hostOf(() => gateRun(budgets), []);
  expect((await cli(['gate'], host)).code).toBe(2);
});

test('a calibrated file gates a fresh run of the same method', async () => {
  const out = join(scratch, 'ceilings-roundtrip.json');
  const { host } = hostOf(
    (call) =>
      gateRun(budgets, {
        p50: 200 + call * 10,
        p50s: { 'status/developer': 1500 + call * 50 },
      }),
    []
  );
  await cli(
    ['calibrate', '--runs', '4', '--out', out, '--page-cache', 'warm'],
    host
  );
  const fresh = writeJson(
    'roundtrip-run.json',
    gateRun(budgets, { p50: 215, p50s: { 'status/developer': 1560 } })
  );
  expect(
    (
      await cli(
        ['gate', fresh, '--ceilings', out, '--page-cache', 'warm'],
        host
      )
    ).code
  ).toBe(0);
  const slow = writeJson(
    'roundtrip-slow.json',
    gateRun(budgets, { p50: 215, p50s: { 'status/developer': 4000 } })
  );
  expect(
    (await cli(['gate', slow, '--ceilings', out, '--page-cache', 'warm'], host))
      .code
  ).toBe(1);
});
