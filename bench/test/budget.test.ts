import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  budgetCaseIds,
  type BudgetLine,
  type Budgets,
  BUDGETS_FILE,
  ceilingGroupFor,
  ceilingsFromRuns,
  checkGate,
  deriveGroup,
  evaluateBudgets,
  gateOptions,
  GROUP_MIN_HOSTS,
  GROUP_MIN_RUNS,
  groupQualifies,
  hostOfFile,
  isCalibrationFile,
  ratioKey,
  readBudgets,
  readCeilings,
  renderBudgets,
  validateBudgets,
} from '../src/budget';
import { run } from '../src/cli';
import { defaultHost } from '../src/record';
import type { BenchRun, CaseResult, Machine } from '../src/result';
import { tQuantile } from '../src/stats';
import { ceilingsOf, gateRun, METHODS } from './fixtures/gate-run';

const scratch = mkdtempSync(join(tmpdir(), 'bench-budget-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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

// One ok case result with `p50` as its only sample; `over` changes anything.
function caseOf(
  id: string,
  p50: number | null,
  over: Partial<CaseResult> = {}
): CaseResult {
  return {
    id,
    version: 1,
    suite: id.startsWith('e2e.') ? 'e2e' : 'everyday',
    fixture: 'medium-serial',
    manifestHash: 'm1',
    status: 'ok',
    budgetMs: 120_000,
    repeats: 1,
    warmup: 0,
    samplesMs: p50 === null ? [] : [p50],
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
    recordedAt: '2026-10-26T00:00:00.000Z',
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

const budgets = readBudgets(BUDGETS_FILE);

function lineOf(lines: BudgetLine[], command: string, env: string) {
  const found = lines.filter((l) => l.command === command && l.env === env);
  expect(found).toHaveLength(1);
  return found[0];
}

test('the committed budgets file has the thirteen rows and five unmeasured', () => {
  expect(budgets.rows).toHaveLength(13);
  const unmeasured = budgets.rows.filter((r) => r.unmeasured !== undefined);
  expect(unmeasured.map((r) => `${r.command}/${r.env} ${r.owner}`)).toEqual([
    'rebase/developer THA-11',
    'rebase/agent THA-11',
    'commit/agent THA-118',
    'checkout/agent THA-118',
    'pull/agent THA-118',
  ]);
  // Every measured row has an attribution that names an owner issue, a cause
  // and its evidence, and nothing else is attributed.
  const measuredRows = budgets.rows
    .filter((r) => r.unmeasured === undefined)
    .map((r) => `${r.command}/${r.env}`)
    .sort();
  expect(Object.keys(budgets.attribution).sort()).toEqual(measuredRows);
  for (const entry of Object.values(budgets.attribution)) {
    expect(entry.owner).toMatch(/^THA-\d+$/);
    expect(entry.cause.length).toBeGreaterThan(0);
    expect(entry.evidence.length).toBeGreaterThan(0);
  }
});

test('budgetCaseIds is the sorted, unique set of measured case ids', () => {
  expect(budgetCaseIds(budgets)).toEqual([
    'e2e.checkout.cold',
    'e2e.pull',
    'e2e.push.10',
    'e2e.workspace',
    'git.clone',
    'git.commit',
    'git.diff',
    'git.diff.agents8',
    'git.pull',
    'git.status',
    'git.status.agents8',
    'git.worktree',
    'wc.diff',
    'wc.diff.agents8',
    'wc.status',
    'wc.status.agents8',
  ]);
});

test('a slow status on the target fixture misses both the target and the multiple', () => {
  const lines = evaluateBudgets(
    runOf([caseOf('wc.status', 120), caseOf('git.status', 10)]),
    budgets
  );
  const line = lineOf(lines, 'status', 'developer');
  expect(line.fixture).toBe('medium-serial');
  expect(line.pageCache).toBeNull();
  expect(line.thaddeusP50).toBe(120);
  expect(line.gitP50).toBe(10);
  expect(line.multiple).toBe(12);
  expect(line.targetMet).toBe(false);
  expect(line.multipleMet).toBe(false);
  expect(line.status).toBe('ok');
});

test('a fast status on the target fixture meets both', () => {
  const lines = evaluateBudgets(
    runOf([caseOf('wc.status', 8), caseOf('git.status', 10)]),
    budgets
  );
  const line = lineOf(lines, 'status', 'developer');
  expect(line.multiple).toBe(0.8);
  expect(line.targetMet).toBe(true);
  expect(line.multipleMet).toBe(true);
});

test('absolute targets apply to the target fixture only', () => {
  const lines = evaluateBudgets(
    runOf([
      caseOf('wc.status', 120, { fixture: 'small-serial' }),
      caseOf('git.status', 10, { fixture: 'small-serial' }),
    ]),
    budgets
  );
  const line = lineOf(lines, 'status', 'developer');
  expect(line.fixture).toBe('small-serial');
  expect(line.multiple).toBe(12);
  expect(line.targetMet).toBeNull();
  expect(line.multipleMet).toBe(false);
});

test('a thaddeus result that exceeded its budget has a status and no multiple', () => {
  const lines = evaluateBudgets(
    runOf([
      caseOf('wc.status', null, { status: 'exceeded', note: 'over budget' }),
      caseOf('git.status', 10),
    ]),
    budgets
  );
  const line = lineOf(lines, 'status', 'developer');
  expect(line.status).toBe('exceeded');
  expect(line.multiple).toBeNull();
  expect(line.targetMet).toBeNull();
  expect(line.multipleMet).toBeNull();
  expect(line.cause).toBe('over budget');
});

test('a git result that failed gives its status and no multiple', () => {
  const lines = evaluateBudgets(
    runOf([
      caseOf('wc.status', 20),
      caseOf('git.status', null, { status: 'error' }),
    ]),
    budgets
  );
  const line = lineOf(lines, 'status', 'developer');
  expect(line.status).toBe('error');
  expect(line.thaddeusP50).toBe(20);
  expect(line.gitP50).toBeNull();
  expect(line.multiple).toBeNull();
});

test('the ci-checkout row ignores warm results and pairs the dropped ones', () => {
  const warmOnly = evaluateBudgets(
    runOf([
      caseOf('e2e.checkout.cold', 500, { pageCache: 'warm' }),
      caseOf('git.clone', 50, { pageCache: 'warm' }),
    ]),
    budgets
  );
  const missing = lineOf(warmOnly, 'ci-checkout', 'ci');
  expect(missing.status).toBe('missing');
  expect(missing.multiple).toBeNull();

  const both = evaluateBudgets(
    runOf([
      caseOf('e2e.checkout.cold', 500, { pageCache: 'warm' }),
      caseOf('git.clone', 50, { pageCache: 'warm' }),
      caseOf('e2e.checkout.cold', 900, { pageCache: 'dropped' }),
      caseOf('git.clone', 300, { pageCache: 'dropped' }),
    ]),
    budgets
  );
  const line = lineOf(both, 'ci-checkout', 'ci');
  expect(line.pageCache).toBe('dropped');
  expect(line.thaddeusP50).toBe(900);
  expect(line.gitP50).toBe(300);
  expect(line.multiple).toBe(3);
  expect(line.targetMet).toBe(true);
});

test('a row without a page-cache mode pairs warm results of a cold case', () => {
  const lines = evaluateBudgets(
    runOf([
      caseOf('e2e.checkout.cold', 500, { pageCache: 'warm' }),
      caseOf('e2e.push.10', 400),
      caseOf('git.commit', 40),
    ]),
    {
      ...budgets,
      rows: [
        {
          command: 'cold',
          env: 'developer',
          thaddeus: 'e2e.checkout.cold',
          git: 'git.clone',
          targetMs: 1000,
          targetMultiple: 1,
        },
        ...budgets.rows,
      ],
    }
  );
  const cold = lineOf(lines, 'cold', 'developer');
  expect(cold.status).toBe('missing');
  const push = lineOf(lines, 'commit', 'developer');
  expect(push.pageCache).toBeNull();
  expect(push.multiple).toBe(10);
});

test('a thaddeus result and a git result of different page-cache modes do not pair', () => {
  const lines = evaluateBudgets(
    runOf([
      caseOf('e2e.push.10', 400, { pageCache: 'warm' }),
      caseOf('git.commit', 40),
    ]),
    budgets
  );
  // Each side stands alone, so each gets its own line with a missing partner.
  const found = lines.filter(
    (l) => l.command === 'commit' && l.env === 'developer'
  );
  expect(found.map((l) => [l.pageCache, l.status, l.multiple])).toEqual([
    [null, 'missing', null],
    ['warm', 'missing', null],
  ]);
});

test('each fixture with results gets its own line', () => {
  const lines = evaluateBudgets(
    runOf([
      caseOf('wc.diff', 30, { fixture: 'small-serial' }),
      caseOf('git.diff', 3, { fixture: 'small-serial' }),
      caseOf('wc.diff', 300),
      caseOf('git.diff', 100),
    ]),
    budgets
  ).filter((l) => l.command === 'diff' && l.env === 'developer');
  expect(lines.map((l) => [l.fixture, l.multiple])).toEqual([
    ['medium-serial', 3],
    ['small-serial', 10],
  ]);
});

test('a row with no results at all comes out once as missing', () => {
  const lines = evaluateBudgets(runOf([]), budgets);
  const line = lineOf(lines, 'pull', 'developer');
  expect(line.status).toBe('missing');
  expect(line.fixture).toBeNull();
});

test('an unmeasured row comes out once with its owner and cause', () => {
  const lines = evaluateBudgets(
    runOf([caseOf('wc.status', 8), caseOf('git.status', 10)]),
    budgets
  );
  const unmeasured = lines.filter((l) => l.status === 'unmeasured');
  expect(unmeasured).toHaveLength(5);
  const rebase = lineOf(lines, 'rebase', 'developer');
  expect(rebase.owner).toBe('THA-11');
  expect(rebase.cause).toContain('no rebase');
  expect(rebase.fixture).toBeNull();
  expect(rebase.targetMet).toBeNull();
  expect(lineOf(lines, 'pull', 'agent').owner).toBe('THA-118');
});

test('ratioKey names the command, environment, fixture and page-cache mode', () => {
  const lines = evaluateBudgets(
    runOf([
      caseOf('e2e.checkout.cold', 900, { pageCache: 'dropped' }),
      caseOf('git.clone', 300, { pageCache: 'dropped' }),
      caseOf('wc.status', 8),
      caseOf('git.status', 10),
    ]),
    budgets
  );
  expect(ratioKey(lineOf(lines, 'ci-checkout', 'ci'))).toBe(
    'ci-checkout/ci medium-serial dropped'
  );
  expect(ratioKey(lineOf(lines, 'status', 'developer'))).toBe(
    'status/developer medium-serial null'
  );
});

test('renderBudgets prints a table, unmeasured owners and attributions of missed lines', () => {
  const attributed: Budgets = {
    ...budgets,
    attribution: {
      'status/developer': {
        owner: 'THA-200',
        cause: 'status decrypts every file',
        evidence: 'bench/out/x.json',
      },
    },
  };
  const lines = evaluateBudgets(
    runOf([
      caseOf('wc.status', 120),
      caseOf('git.status', 10),
      caseOf('wc.diff', 400),
      caseOf('git.diff', 10),
    ]),
    attributed
  );
  const text = renderBudgets(lines);
  expect(text).toContain('| status | developer | medium-serial |');
  expect(text).toContain('THA-200');
  expect(text).toContain('status decrypts every file');
  expect(text).toContain('bench/out/x.json');
  expect(text).toMatch(/diff\/developer.*unattributed/);
  expect(text).toContain('THA-11');
  expect(text).toContain('THA-118');
});

test('the schema rejects a row with neither cases nor unmeasured', () => {
  const bad = {
    ...budgets,
    rows: [{ command: 'x', env: 'developer', targetMs: 1, targetMultiple: 1 }],
  };
  expect(validateBudgets(bad)).not.toEqual([]);
});

test('the schema rejects a measured row with an unmeasured reason, and an unmeasured row without an owner', () => {
  const measuredAndUnmeasured = {
    ...budgets,
    rows: [
      {
        command: 'x',
        env: 'developer',
        thaddeus: 'wc.status',
        git: 'git.status',
        unmeasured: 'why',
        owner: 'THA-1',
        targetMs: 1,
        targetMultiple: 1,
      },
    ],
  };
  expect(validateBudgets(measuredAndUnmeasured)).not.toEqual([]);
  const noOwner = {
    ...budgets,
    rows: [
      {
        command: 'x',
        env: 'developer',
        unmeasured: 'why',
        targetMs: 1,
        targetMultiple: 1,
      },
    ],
  };
  expect(validateBudgets(noOwner)).not.toEqual([]);
});

test('the schema rejects a malformed attribution entry', () => {
  const bad = {
    ...budgets,
    attribution: { 'status/developer': { owner: 'x' } },
  };
  expect(validateBudgets(bad)).not.toEqual([]);
});

test('the committed budgets file passes its schema', () => {
  expect(validateBudgets(budgets)).toEqual([]);
});

function writeJson(name: string, value: unknown): string {
  const path = join(scratch, name);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}

// Runs one CLI command, capturing what it writes to stdout and the log.
async function cli(
  argv: string[],
  env: Record<string, string | undefined> = {}
): Promise<{ code: number; out: string; logs: string[] }> {
  const logs: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const out: string[] = [];
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await run(argv, {
      ...defaultHost(),
      log: (line) => logs.push(line),
      env,
    });
  } finally {
    process.stdout.write = write;
  }
  return { code, out: out.join(''), logs };
}

test('bench budget --case-ids prints the comma-joined ids and exits 0', async () => {
  const { code, out } = await cli(['budget', '--case-ids']);
  expect(code).toBe(0);
  expect(out.trim()).toBe(budgetCaseIds(budgets).join(','));
});

test('bench budget prints the table, appends it to the step summary and exits 0 on a miss', async () => {
  const file = writeJson(
    'budget-run.json',
    runOf([caseOf('wc.status', 120), caseOf('git.status', 10)])
  );
  const summary = join(scratch, 'budget-summary.md');
  writeFileSync(summary, 'earlier step\n');
  const { code, out } = await cli(['budget', file], {
    GITHUB_STEP_SUMMARY: summary,
  });
  expect(code).toBe(0);
  expect(out).toContain('| status | developer | medium-serial |');
  const written = readFileSync(summary, 'utf8');
  expect(written.startsWith('earlier step\n')).toBe(true);
  expect(written).toContain('| status | developer | medium-serial |');
});

test('bench budget evaluates runs of different commits separately and combines the lines', async () => {
  const everyday = writeJson(
    'budget-everyday.json',
    runOf([caseOf('wc.status', 120), caseOf('git.status', 10)], {
      commit: 'a'.repeat(40),
      suiteVersion: 'suite-a',
    })
  );
  const server = writeJson(
    'budget-server.json',
    runOf(
      [
        caseOf('e2e.push.10', 400),
        caseOf('git.commit', 40),
        caseOf('git.status', 11),
      ],
      {
        commit: 'b'.repeat(40),
        suiteVersion: 'suite-b',
      }
    )
  );
  const { code, out } = await cli(['budget', everyday, server]);
  expect(code).toBe(0);
  expect(out).toContain('| status | developer | medium-serial |');
  expect(out).toContain('| commit | developer | medium-serial |');
  // One line per row: the status row is not repeated as missing.
  expect(out.match(/\| status \| developer \|/g)).toHaveLength(1);
});

test('bench budget exits 1 with the ajv message on a bad budgets file', async () => {
  const file = writeJson('budget-run-2.json', runOf([]));
  const bad = writeJson('bad-budgets.json', {
    ...budgets,
    rows: [{ command: 'x', env: 'developer', targetMs: 1, targetMultiple: 1 }],
  });
  const { code, logs } = await cli(['budget', file, '--budgets', bad]);
  expect(code).toBe(1);
  expect(logs.join('\n')).toContain('bad-budgets.json');
  expect(logs.join('\n')).toContain('/rows/0');
});

test('bench budget exits 1 on a budgets file that is not JSON', async () => {
  const file = writeJson('budget-run-3.json', runOf([]));
  const notJson = join(scratch, 'not-json.json');
  writeFileSync(notJson, '{ nope');
  const { code, logs } = await cli(['budget', file, '--budgets', notJson]);
  expect(code).toBe(1);
  expect(logs.join('\n')).toContain('not-json.json');
});

test('bench budget with no run files is a usage error', async () => {
  const { code } = await cli(['budget']);
  expect(code).toBe(2);
});

// The gate: ceilings from a calibration study, and the check of a run
// against them.

const smallKey = (command: string, env: string) =>
  `${command}/${env} small-serial null`;

const meta = { runs: 3, hosts: 3 };

test('deriveGroup is exp(mu + t * sigma) of the log p50s and records what it rests on', () => {
  const key = 'status/developer small-serial null';
  const c = deriveGroup({ [key]: [1500, 1600, 1700] }, meta);
  const logs = [1500, 1600, 1700].map(Math.log);
  const mu = logs.reduce((a, b) => a + b) / 3;
  const sigma = Math.sqrt(logs.reduce((a, x) => a + (x - mu) ** 2, 0) / 2);
  expect(c.familySize).toBe(1);
  // Three runs: two degrees of freedom, t(0.99, 2) = 6.965 (table value).
  expect(c.p50Ceilings[key].t).toBeCloseTo(6.965, 2);
  expect(c.p50Ceilings[key].t).toBeCloseTo(tQuantile(0.99, 2), 12);
  expect(c.p50Ceilings[key].n).toBe(3);
  expect(c.p50Ceilings[key].logSd).toBeCloseTo(sigma, 12);
  expect(c.p50Ceilings[key].geoMeanMs).toBeCloseTo(Math.exp(mu), 9);
  expect(c.p50Ceilings[key].ceilingMs).toBeCloseTo(
    Math.exp(mu + tQuantile(0.99, 2) * sigma),
    9
  );
  expect(c).toMatchObject(meta);
});

test('deriveGroup gives a key with two runs no ceiling and splits alpha over the keys that got one', () => {
  const c = deriveGroup(
    { a: [100, 110, 120], b: [200, 210, 220], few: [300, 310] },
    meta
  );
  expect(Object.keys(c.p50Ceilings).sort()).toEqual(['a', 'b']);
  expect(c.familySize).toBe(2);
  // The family of two splits alpha: each key's t is at 1 - 0.01 / 2, with n - 1
  // degrees of freedom; a key of four runs gets a smaller t than one of three.
  expect(c.p50Ceilings.a.t).toBeCloseTo(tQuantile(1 - 0.01 / 2, 2), 12);
  const four = deriveGroup({ a: [100, 110, 120, 115] }, meta);
  expect(four.p50Ceilings.a.n).toBe(4);
  expect(four.p50Ceilings.a.t).toBeCloseTo(tQuantile(0.99, 3), 12);
  expect(four.p50Ceilings.a.t).toBeLessThan(c.p50Ceilings.a.t);
  const none = deriveGroup({ few: [300, 310] }, meta);
  expect(none.p50Ceilings).toEqual({});
  expect(none.familySize).toBe(0);
});

test('a ceiling is a time, so a faster thaddeus keeps its headroom instead of being floored', () => {
  const c = deriveGroup({ k: [0.4, 0.41, 0.42] }, meta);
  expect(c.p50Ceilings.k.ceilingMs).toBeLessThan(1);
});

test('checkGate passes a run whose p50s are at or below their ceilings and prints the multiple of git', () => {
  const r = gateRun(budgets);
  const result = checkGate(r, budgets, ceilingsOf(budgets, r, 200), METHODS);
  expect(result.failed).toBe(false);
  expect(result.lines).toHaveLength(8);
  expect(result.lines[0]).toBe(
    'ceilings: using the group of CPU model Test CPU (6 runs from 3 hosts)'
  );
  expect(result.lines.slice(1).every((l) => l.startsWith('ok '))).toBe(true);
  expect(result.lines[1]).toBe(
    'ok status/developer small-serial null: p50 200.0 ms <= ceiling 200.0 ms (2.0x git)'
  );
});

test('checkGate reports a regression on the key above its ceiling and fails', () => {
  const r = gateRun(budgets, { p50s: { 'status/developer': 260 } });
  const ceilings = ceilingsOf(budgets, gateRun(budgets), 250);
  const result = checkGate(r, budgets, ceilings, METHODS);
  expect(result.failed).toBe(true);
  expect(result.lines.filter((l) => l.startsWith('regression'))).toEqual([
    'regression status/developer small-serial null: p50 260.0 ms is above its ceiling 250.0 ms (2.6x git)',
  ]);
  expect(result.lines.filter((l) => l.startsWith('ok '))).toHaveLength(6);
});

test('the multiple of git never fails the gate, whatever it is', () => {
  // Git is 1000x faster than thaddeus here, and 50 ms slower: both in bounds
  // for the thaddeus p50, so both pass.
  const r = gateRun(budgets, { gitP50: 0.2 });
  const ceilings = ceilingsOf(budgets, gateRun(budgets), 250);
  const fast = checkGate(r, budgets, ceilings, METHODS);
  expect(fast.failed).toBe(false);
  expect(fast.lines[1]).toContain('(1000.0x git)');
  const slowGit = checkGate(
    gateRun(budgets, { gitP50: 5000 }),
    budgets,
    ceilings,
    METHODS
  );
  expect(slowGit.failed).toBe(false);
  // A zero git median leaves no multiple, and still passes.
  const zero = gateRun(budgets, {
    caseOver: (c) =>
      c.id === 'git.status' ? { p50Ms: 0, samplesMs: [0, 0, 0] } : {},
  });
  const zeroResult = checkGate(zero, budgets, ceilings, METHODS);
  expect(zeroResult.failed).toBe(false);
  expect(zeroResult.lines[1]).toContain('(no multiple of git)');
});

test('checkGate fails on a null ceilings file, naming calibration', () => {
  const result = checkGate(gateRun(budgets), budgets, null, METHODS);
  expect(result.failed).toBe(true);
  expect(result.lines.join('\n')).toContain('no ceilings file');
});

test('checkGate fails when a gated case is not ok, whatever the p50', () => {
  const ceilings = ceilingsOf(budgets, gateRun(budgets), 100_000);
  for (const status of ['exceeded', 'oom', 'error'] as const) {
    const r = gateRun(budgets, {
      caseOver: (c) =>
        c.id === 'e2e.pull'
          ? { status, p50Ms: null, samplesMs: [], note: 'it broke' }
          : {},
    });
    const result = checkGate(r, budgets, ceilings, METHODS);
    expect(result.failed).toBe(true);
    expect(result.lines).toContain(
      `not ok pull/developer small-serial null: ${status} (it broke)`
    );
  }
  // A git baseline that does not finish fails its row too.
  const gitFailed = gateRun(budgets, {
    caseOver: (c) =>
      c.id === 'git.pull'
        ? { status: 'error', p50Ms: null, samplesMs: [], note: 'git broke' }
        : {},
  });
  expect(checkGate(gitFailed, budgets, ceilings, METHODS).failed).toBe(true);
});

test('checkGate fails when a measured row has no result at all', () => {
  const full = gateRun(budgets);
  const r = {
    ...full,
    cases: full.cases.filter((c) => c.id !== 'git.pull' && c.id !== 'e2e.pull'),
  };
  const result = checkGate(
    r,
    budgets,
    ceilingsOf(budgets, full, 100_000),
    METHODS
  );
  expect(result.failed).toBe(true);
  expect(result.lines.join('\n')).toContain('not ok pull/developer: missing');
});

test('checkGate fails on a p50 with no ceiling', () => {
  const r = gateRun(budgets);
  const ceilings = ceilingsOf(budgets, r, 100_000);
  // Missing from both groups. The CPU group still covers every row pooled
  // has, so the gate uses it, and that row has no ceiling.
  delete ceilings.byCpu['Test CPU'].p50Ceilings[smallKey('diff', 'developer')];
  delete ceilings.pooled.p50Ceilings[smallKey('diff', 'developer')];
  const result = checkGate(r, budgets, ceilings, METHODS);
  expect(result.failed).toBe(true);
  expect(result.lines).toContain(
    'not ok diff/developer small-serial null: no ceiling; re-run calibration'
  );
});

test('checkGate fails a result not measured with the gate method', () => {
  const ceilings = ceilingsOf(budgets, gateRun(budgets), 100_000);
  // The thaddeus case ran 10 repeats, as a plain `bench run` would.
  const tenRepeats = gateRun(budgets, {
    caseOver: (c) => (c.id === 'wc.status' ? { repeats: 10 } : {}),
  });
  const a = checkGate(tenRepeats, budgets, ceilings, METHODS);
  expect(a.failed).toBe(true);
  expect(a.lines.join('\n')).toContain(
    `not ok wc.status small-serial: not measured with the gate method: 10 repeats and ${METHODS['wc.status'].warmup} warm-ups, where the gate takes ${METHODS['wc.status'].repeats} and ${METHODS['wc.status'].warmup}`
  );
  // A git case with the run's 3 repeats instead of its minimum of 25.
  const threeGit = gateRun(budgets, {
    caseOver: (c) => (c.id === 'git.status' ? { repeats: 3 } : {}),
  });
  expect(checkGate(threeGit, budgets, ceilings, METHODS).failed).toBe(true);
  // A different warm-up.
  const noWarmup = gateRun(budgets, {
    caseOver: (c) => (c.id === 'wc.status' ? { warmup: 0 } : {}),
  });
  expect(checkGate(noWarmup, budgets, ceilings, METHODS).failed).toBe(true);
});

test('gateMethods gives the git cases their minimum and leaves the others at the gate method', () => {
  expect(METHODS['git.status']).toEqual({ repeats: 25, warmup: 1 });
  expect(METHODS['git.clone']).toEqual({ repeats: 25, warmup: 1 });
  expect(METHODS['wc.status']).toEqual({ repeats: 3, warmup: 1 });
  expect(METHODS['e2e.push.10']).toEqual({ repeats: 3, warmup: 1 });
  // e2e.pull takes no warm-up of its own (its maxWarmup is 0).
  expect(METHODS['e2e.pull']).toEqual({ repeats: 3, warmup: 0 });
  expect(Object.keys(METHODS).sort()).toEqual(budgetCaseIds(budgets));
});

test('checkGate fails when the ceilings were calibrated on other case versions', () => {
  const r = gateRun(budgets);
  const ceilings = ceilingsOf(budgets, r, 100_000);
  ceilings.caseVersions['e2e.pull'] = 2;
  const result = checkGate(r, budgets, ceilings, METHODS);
  expect(result.failed).toBe(true);
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]).toContain(
    'e2e.pull is v1 in the run and v2 in the ceilings'
  );
  expect(result.lines[0]).toContain('re-run calibration');

  const withoutVersion = ceilingsOf(budgets, r, 100_000);
  delete withoutVersion.caseVersions['wc.diff'];
  expect(checkGate(r, budgets, withoutVersion, METHODS).failed).toBe(true);
});

test('checkGate passes when every gated fixture hash matches the ceilings, and fails when one changed or the file records none', () => {
  const r = gateRun(budgets);
  const ceilings = ceilingsOf(budgets, r, 100_000);
  expect(checkGate(r, budgets, ceilings, METHODS).failed).toBe(false);

  const moved = gateRun(budgets, {
    caseOver: (c) => (c.id === 'wc.status' ? { manifestHash: 'm2' } : {}),
  });
  const changed = checkGate(moved, budgets, ceilings, METHODS);
  expect(changed.failed).toBe(true);
  expect(changed.lines).toHaveLength(1);
  expect(changed.lines[0]).toContain('stale ceilings; re-run calibration');
  expect(changed.lines[0]).toContain('wc.status');

  const without = ceilingsOf(budgets, r, 100_000);
  delete without.manifestHashes;
  const missing = checkGate(r, budgets, without, METHODS);
  expect(missing.failed).toBe(true);
  expect(missing.lines).toEqual([
    'not ok stale ceilings; re-run calibration (the ceilings file records no fixture hashes)',
  ]);

  const lacking = ceilingsOf(budgets, r, 100_000);
  delete lacking.manifestHashes?.['git.diff'];
  const absent = checkGate(r, budgets, lacking, METHODS);
  expect(absent.failed).toBe(true);
  expect(absent.lines[0]).toContain('git.diff');
});

test('checkGate gates the dropped row when the ceilings measured it, and skips it when they did not', () => {
  const dropped = gateRun(budgets, { dropped: true });
  const both = ceilingsOf(budgets, dropped, 200, ['warm', 'dropped']);
  const ok = checkGate(dropped, budgets, both, METHODS);
  expect(ok.failed).toBe(false);
  expect(ok.lines).toContain(
    'ok ci-checkout/ci small-serial dropped: p50 200.0 ms <= ceiling 200.0 ms (2.0x git)'
  );
  // Warm-only ceilings with a run that has no dropped results pass...
  const warm = gateRun(budgets);
  expect(
    checkGate(warm, budgets, ceilingsOf(budgets, warm, 200), METHODS).failed
  ).toBe(false);
  // ...but ceilings that did measure dropped fail a run that has none.
  const missing = checkGate(warm, budgets, both, METHODS);
  expect(missing.failed).toBe(true);
  expect(missing.lines).toContain(
    'not ok ci-checkout/ci dropped: missing (no e2e.checkout.cold or git.clone result)'
  );
});

test('checkGate ignores unmeasured rows and a missed absolute target', () => {
  // 10 s for status is far over its 50 ms target, but under its ceiling.
  const r = gateRun(budgets, { p50s: { 'status/developer': 10_000 } });
  const result = checkGate(r, budgets, ceilingsOf(budgets, r, 20_000), METHODS);
  expect(result.failed).toBe(false);
  expect(result.lines.join('\n')).not.toContain('rebase');
});

test('checkGate fails a run that has results only on a fixture without ceilings', () => {
  const r = gateRun(budgets);
  const onMedium = {
    ...r,
    cases: r.cases.map((c) => ({ ...c, fixture: 'medium-serial' })),
  };
  const result = checkGate(
    onMedium,
    budgets,
    ceilingsOf(budgets, r, 100_000),
    METHODS
  );
  expect(result.failed).toBe(true);
  expect(result.lines.slice(1).every((l) => l.startsWith('not ok'))).toBe(true);
});

// A run of `gateRun` on the CPU model `cpu`.
function onCpu(cpu: string, options: Parameters<typeof gateRun>[1] = {}) {
  const base = gateRun(budgets, options);
  return { ...base, machine: { ...base.machine, cpu } };
}

test('hostOfFile reads the host of run-<host>-<k>.json and counts any other file as a host of its own', () => {
  expect(hostOfFile('/tmp/calruns/everyday-gate-run-3/run-3-2.json')).toBe('3');
  expect(hostOfFile('run-12-1.json')).toBe('12');
  expect(hostOfFile('out/p50-run-1.json')).toBe('out/p50-run-1.json');
  expect(hostOfFile('other.json')).toBe('other.json');
});

test('ceilingsFromRuns keeps a group per CPU model next to the pooled one, each counting its runs and hosts', () => {
  const at = (cpu: string, host: string, k: number, p50: number) => ({
    name: `run-${host}-${k}.json`,
    host,
    run: onCpu(cpu, { p50, dropped: true }),
  });
  const runs = [
    at('Fast', '1', 1, 100),
    at('Fast', '1', 2, 104),
    at('Fast', '2', 1, 98),
    at('Fast', '3', 1, 101),
    at('Slow', '4', 1, 200),
    at('Slow', '4', 2, 204),
  ];
  const c = ceilingsFromRuns(runs, budgets, {
    studiedAt: 's',
    runnerImage: 'r',
  });
  expect(c.runs).toBe(6);
  expect(c.pageCache).toEqual(['warm', 'dropped']);
  expect(c.caseVersions['e2e.pull']).toBe(1);
  expect(Object.keys(c.byCpu).sort()).toEqual(['Fast', 'Slow']);
  expect(c.byCpu.Fast).toMatchObject({ runs: 4, hosts: 3, familySize: 8 });
  expect(c.byCpu.Slow).toMatchObject({ runs: 2, hosts: 1, familySize: 0 });
  expect(c.pooled).toMatchObject({ runs: 6, hosts: 4, familySize: 8 });
  const key = smallKey('status', 'developer');
  const fast = c.byCpu.Fast.p50Ceilings[key];
  expect(fast.n).toBe(4);
  expect(fast.geoMeanMs).toBeCloseTo(
    Math.exp([100, 104, 98, 101].reduce((a, x) => a + Math.log(x), 0) / 4),
    9
  );
  expect(fast.t).toBeCloseTo(tQuantile(1 - 0.01 / 8, 3), 12);
  // A group of two runs has no ceilings; the pooled one pools both models, so
  // its ceiling sits well above the fast model's.
  expect(c.byCpu.Slow.p50Ceilings).toEqual({});
  expect(c.pooled.p50Ceilings[key].n).toBe(6);
  expect(c.pooled.p50Ceilings[key].ceilingMs).toBeGreaterThan(
    fast.ceilingMs * 2
  );
  expect(c.pooled.p50Ceilings['ci-checkout/ci small-serial dropped'].n).toBe(6);
  // Warm-only runs measure only warm; files that do not match the naming each
  // count as a host.
  const warm = ceilingsFromRuns(
    [0, 1, 2].map((i) => ({
      name: `w${i}.json`,
      host: hostOfFile(`w${i}.json`),
      run: gateRun(budgets),
    })),
    budgets,
    { studiedAt: 's', runnerImage: 'r' }
  );
  expect(warm.pageCache).toEqual(['warm']);
  expect(warm.pooled.hosts).toBe(3);
});

test('ceilingsFromRuns refuses runs of other case versions and a run lost by one case only thins that key', () => {
  const file = (name: string, run: BenchRun) => ({ name, host: name, run });
  const a = file('a.json', gateRun(budgets));
  const newer = file(
    'b.json',
    gateRun(budgets, {
      caseOver: (c) => (c.id === 'wc.diff' ? { version: 2 } : {}),
    })
  );
  expect(() =>
    ceilingsFromRuns([a, newer], budgets, { studiedAt: 's', runnerImage: 'r' })
  ).toThrow('b.json has other case versions than a.json (wc.diff)');
  const otherFixture = file(
    'f.json',
    gateRun(budgets, {
      caseOver: (c) => (c.id === 'git.status' ? { manifestHash: 'm2' } : {}),
    })
  );
  expect(() =>
    ceilingsFromRuns([a, otherFixture], budgets, {
      studiedAt: 's',
      runnerImage: 'r',
    })
  ).toThrow('f.json has other fixture hashes than a.json (git.status)');
  expect(
    ceilingsFromRuns([a, file('g.json', gateRun(budgets))], budgets, {
      studiedAt: 's',
      runnerImage: 'r',
    }).manifestHashes?.['git.status']
  ).toBe('m1');
  expect(() =>
    ceilingsFromRuns([], budgets, { studiedAt: 's', runnerImage: 'r' })
  ).toThrow('no runs');
  const lost = file(
    'lost.json',
    gateRun(budgets, {
      caseOver: (c) =>
        c.id === 'e2e.pull'
          ? { status: 'exceeded', p50Ms: null, samplesMs: [] }
          : {},
    })
  );
  const c = ceilingsFromRuns(
    [
      a,
      lost,
      file('c.json', gateRun(budgets)),
      file('d.json', gateRun(budgets)),
    ],
    budgets,
    { studiedAt: 's', runnerImage: 'r' }
  );
  expect(c.pooled.p50Ceilings[smallKey('pull', 'developer')].n).toBe(3);
  expect(c.pooled.p50Ceilings[smallKey('status', 'developer')].n).toBe(4);
});

test('ceilingGroupFor uses the CPU model group only with enough runs and hosts, and says which group applies', () => {
  const r = gateRun(budgets);
  const own = (runs: number, hosts: number) =>
    ceilingsOf(budgets, r, 200, ['warm'], { own: { runs, hosts } });
  expect([GROUP_MIN_RUNS, GROUP_MIN_HOSTS]).toEqual([6, 3]);
  const used = ceilingGroupFor(own(6, 3), 'Test CPU');
  expect(used.group.runs).toBe(6);
  expect(used.note).toBe(
    'ceilings: using the group of CPU model Test CPU (6 runs from 3 hosts)'
  );
  // One run short, or one host short, falls back.
  for (const [runs, hosts] of [
    [5, 3],
    [10, 2],
  ]) {
    const thin = ceilingGroupFor(own(runs, hosts), 'Test CPU');
    expect(thin.group.runs).toBe(20);
    expect(thin.note).toBe(
      `ceilings: using the pooled group (20 runs from 10 hosts); CPU model Test CPU was calibrated on only ${runs} runs from ${hosts} hosts, and a group needs 6 runs from 3 hosts`
    );
  }
  // A group large enough but without a ceiling for one row would fail that
  // row on every run of its CPU model, so the pooled group applies instead.
  const holed = own(6, 3);
  const missing = smallKey('pull', 'developer');
  delete holed.byCpu['Test CPU'].p50Ceilings[missing];
  const partial = ceilingGroupFor(holed, 'Test CPU');
  expect(partial.group.runs).toBe(20);
  expect(partial.note).toBe(
    `ceilings: using the pooled group (20 runs from 10 hosts); CPU model Test CPU has no ceiling for ${missing}`
  );
  const unknown = ceilingGroupFor(own(6, 3), 'Unseen CPU');
  expect(unknown.group.runs).toBe(20);
  expect(unknown.note).toBe(
    'ceilings: using the pooled group (20 runs from 10 hosts); CPU model Unseen CPU was not calibrated'
  );
});

test('groupQualifies needs enough runs and hosts and a CPU model the host identified', () => {
  const of = (runs: number, hosts: number) =>
    ceilingsOf(budgets, gateRun(budgets), 200, ['warm'], {
      own: { runs, hosts },
    });
  const pooled = of(6, 3).pooled;
  const group = (runs: number, hosts: number) =>
    of(runs, hosts).byCpu['Test CPU'];
  expect(groupQualifies('Test CPU', group(6, 3), pooled)).toBe(true);
  expect(groupQualifies('Test CPU', group(5, 3), pooled)).toBe(false);
  expect(groupQualifies('Test CPU', group(10, 2), pooled)).toBe(false);
  // Every row the pooled group covers must have a ceiling in the CPU group.
  const holed = group(6, 3);
  delete holed.p50Ceilings[smallKey('status', 'developer')];
  expect(groupQualifies('Test CPU', holed, pooled)).toBe(false);
  // Hosts that could not read their CPU all report these names, so a group
  // under them mixes unrelated machines whatever its size.
  expect(groupQualifies('unknown', group(20, 10), pooled)).toBe(false);
  expect(groupQualifies('', group(20, 10), pooled)).toBe(false);
});

test('ceilingGroupFor never uses a group keyed unknown or empty, even a large one', () => {
  const r = gateRun(budgets);
  const base = ceilingsOf(budgets, r, 200, ['warm'], {
    own: { runs: 20, hosts: 10 },
  });
  for (const cpu of ['unknown', '']) {
    const ceilings = { ...base, byCpu: { [cpu]: base.byCpu['Test CPU'] } };
    const chosen = ceilingGroupFor(ceilings, cpu);
    expect(chosen.group).toBe(ceilings.pooled);
    expect(chosen.note).toContain('using the pooled group');
    expect(chosen.note).toContain('is not a CPU model the host identified');
  }
});

test('isCalibrationFile accepts only run-<host>-<k>.json names', () => {
  expect(isCalibrationFile('/tmp/calruns/run-3-2.json')).toBe(true);
  expect(isCalibrationFile('run-abc-def-1.json')).toBe(true);
  expect(isCalibrationFile('out/p50-run-1.json')).toBe(false);
  expect(isCalibrationFile('other.json')).toBe(false);
});

test('checkGate holds a run on a calibrated CPU to that CPU group, so a regression inside the pooled ceiling still fails', () => {
  // The model's group allows 200 ms; the pooled group, spanning slower models,
  // allows 500 ms. A 300 ms p50 is a regression for this CPU only.
  const r = gateRun(budgets, { p50: 300 });
  const ceilings = ceilingsOf(budgets, r, 200, ['warm'], { pooledMs: 500 });
  const result = checkGate(r, budgets, ceilings, METHODS);
  expect(result.failed).toBe(true);
  expect(result.lines[0]).toContain('using the group of CPU model Test CPU');
  expect(result.lines.filter((l) => l.startsWith('regression'))).toHaveLength(
    7
  );
  expect(result.lines[1]).toContain('is above its ceiling 200.0 ms');
});

test('checkGate falls back to the pooled ceilings, and says so, for a thin or unknown CPU model', () => {
  const r = gateRun(budgets, { p50: 300 });
  const thin = checkGate(
    r,
    budgets,
    ceilingsOf(budgets, r, 200, ['warm'], {
      pooledMs: 500,
      own: { runs: 4, hosts: 2 },
    }),
    METHODS
  );
  expect(thin.failed).toBe(false);
  expect(thin.lines[0]).toContain(
    'using the pooled group (20 runs from 10 hosts)'
  );
  expect(thin.lines[0]).toContain('calibrated on only 4 runs from 2 hosts');
  expect(thin.lines[1]).toBe(
    'ok status/developer small-serial null: p50 300.0 ms <= ceiling 500.0 ms (3.0x git)'
  );
  const unknown = checkGate(
    r,
    budgets,
    ceilingsOf(budgets, r, 200, ['warm'], { pooledMs: 500, own: null }),
    METHODS
  );
  expect(unknown.failed).toBe(false);
  expect(unknown.lines[0]).toContain('CPU model Test CPU was not calibrated');
  // The pooled ceilings still catch a regression of their own.
  const slow = gateRun(budgets, { p50: 600 });
  expect(
    checkGate(
      slow,
      budgets,
      ceilingsOf(budgets, slow, 200, ['warm'], {
        pooledMs: 500,
        own: null,
      }),
      METHODS
    ).failed
  ).toBe(true);
});

test('readCeilings reads a ceilings file, returns null for a missing one and throws on a bad one', () => {
  const ceilings = ceilingsOf(budgets, gateRun(budgets), 200);
  const path = writeJson('ceilings-ok.json', ceilings);
  expect(readCeilings(path)).toEqual(ceilings);
  expect(readCeilings(join(scratch, 'nope.json'))).toBeNull();
  const key = smallKey('status', 'developer');
  const bad = writeJson('ceilings-bad.json', {
    ...ceilings,
    pooled: {
      ...ceilings.pooled,
      p50Ceilings: {
        [key]: { ...ceilings.pooled.p50Ceilings[key], ceilingMs: 'x' },
      },
    },
  });
  const noPooled = writeJson('ceilings-nopooled.json', {
    ...ceilings,
    pooled: undefined,
  });
  expect(() => readCeilings(noPooled)).toThrow('is not a ceilings file');
  const badGroup = writeJson('ceilings-badgroup.json', {
    ...ceilings,
    byCpu: { x: { runs: 1 } },
  });
  expect(() => readCeilings(badGroup)).toThrow('is not a ceilings file');
  expect(() => readCeilings(bad)).toThrow('is not a ceilings file');
  // A file of an earlier method (ratio ceilings) is not this format.
  const old = writeJson('ceilings-old.json', {
    ...ceilings,
    method: 'lognormal-family-wise-t',
  });
  expect(() => readCeilings(old)).toThrow('is not a ceilings file');
  const notJson = join(scratch, 'ceilings-notjson.json');
  writeFileSync(notJson, '{ nope');
  expect(() => readCeilings(notJson)).toThrow('ceilings-notjson.json');
});

test('gateOptions is the gate method over exactly the budgeted cases', () => {
  const opts = gateOptions(budgets);
  expect(opts).toMatchObject({
    suite: 'all',
    fixtures: ['small'],
    sweeps: false,
    pageCache: ['warm', 'dropped'],
    repeats: 3,
    warmup: 1,
    budgetMs: 300_000,
  });
  expect(opts.only).toEqual(budgetCaseIds(budgets));
  expect(gateOptions(budgets, ['warm']).pageCache).toEqual(['warm']);
});
