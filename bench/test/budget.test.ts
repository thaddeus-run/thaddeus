import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  budgetCaseIds,
  type BudgetLine,
  type Budgets,
  BUDGETS_FILE,
  evaluateBudgets,
  ratioKey,
  readBudgets,
  renderBudgets,
  validateBudgets,
} from '../src/budget';
import { run } from '../src/cli';
import { defaultHost } from '../src/record';
import type { BenchRun, CaseResult, Machine } from '../src/result';

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
  expect(budgets.attribution).toEqual({});
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
