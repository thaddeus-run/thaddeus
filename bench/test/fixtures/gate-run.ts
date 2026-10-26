import {
  type Budgets,
  BUDGETS_FILE,
  type Ceilings,
  evaluateBudgets,
  gateMethods,
  linesP50,
  readBudgets,
} from '../../src/budget';
import { detectMachine } from '../../src/machine';
import type { BenchRun, CaseResult } from '../../src/result';
import { fakeProbe } from './suite-env';

// Test runs of the gate's cases: one result per case a budget row names, on
// small-serial, so `checkGate` and the gate commands can be tested without
// timing anything.

// What each gated case records when measured with the gate method, read from
// the real registries the way the gate reads them.
export const METHODS = await gateMethods(readBudgets(BUDGETS_FILE));

// Every thaddeus case the committed budgets pair with a git case takes `p50`
// ms (200 unless `p50s` names its `command/env` row) and every git case
// 100 ms (or `gitP50`), each recording the repeats and warm-ups the gate
// method gives it. `dropped` also gives the dropped-cache results the
// ci-checkout row needs.
export function gateRun(
  budgets: Budgets,
  options: {
    p50?: number;
    p50s?: Record<string, number>;
    gitP50?: number;
    dropped?: boolean;
    over?: Partial<BenchRun>;
    caseOver?: (c: CaseResult) => Partial<CaseResult>;
  } = {}
): BenchRun {
  const cases: CaseResult[] = [];
  const caseOf = (
    id: string,
    p50: number,
    pageCache?: 'warm' | 'dropped'
  ): CaseResult => {
    const c: CaseResult = {
      id,
      version: 1,
      suite: id.startsWith('e2e.') ? 'e2e' : 'everyday',
      fixture: 'small-serial',
      manifestHash: 'm1',
      status: 'ok',
      budgetMs: 300_000,
      repeats: METHODS[id].repeats,
      warmup: METHODS[id].warmup,
      samplesMs: [p50, p50, p50],
      p50Ms: p50,
      p95Ms: p50,
      cv: 0,
      peakRssBytes: 1024,
      ...(pageCache !== undefined && { pageCache }),
    };
    return { ...c, ...options.caseOver?.(c) };
  };
  for (const row of budgets.rows) {
    if (row.thaddeus === undefined || row.git === undefined) continue;
    const p50 =
      options.p50s?.[`${row.command}/${row.env}`] ?? options.p50 ?? 200;
    const git = options.gitP50 ?? 100;
    if (row.pageCache === 'dropped') {
      if (options.dropped !== true) continue;
      cases.push(caseOf(row.thaddeus, p50, 'dropped'));
      cases.push(caseOf(row.git, git, 'dropped'));
    } else {
      cases.push(caseOf(row.thaddeus, p50));
      cases.push(caseOf(row.git, git));
    }
  }
  return {
    schemaVersion: 1,
    commit: 'c'.repeat(40),
    dirty: false,
    suiteVersion: 'suite-a',
    recordedAt: '2026-10-26T00:00:00.000Z',
    machine: detectMachine('local', { probe: fakeProbe }),
    method: {
      repeats: 3,
      warmup: 1,
      budgetMs: 300_000,
      isolation: 'subprocess',
    },
    cases,
    sweeps: [],
    ...options.over,
  };
}

// Ceilings that allow a thaddeus p50 up to `ceilingMs` on every key `run` has
// a p50 for, calibrated on case version 1. The pooled group allows
// `groups.pooledMs` (default `ceilingMs`); the group of the run's CPU model
// allows `ceilingMs` on `groups.own` runs and hosts (default 6 and 3, enough
// for the gate to use it), or does not exist when `own` is null.
export function ceilingsOf(
  budgets: Budgets,
  run: BenchRun,
  ceilingMs: number,
  pageCache: ('warm' | 'dropped')[] = ['warm'],
  groups: {
    pooledMs?: number;
    own?: { runs: number; hosts: number } | null;
  } = {}
): Ceilings {
  const keys = Object.keys(linesP50(evaluateBudgets(run, budgets)));
  const groupOf = (ms: number, runs: number, hosts: number) => ({
    runs,
    hosts,
    familySize: keys.length,
    p50Ceilings: Object.fromEntries(
      keys.map((k) => [
        k,
        { ceilingMs: ms, n: runs, t: 2.5, geoMeanMs: ms / 2, logSd: 0.1 },
      ])
    ),
  });
  const own = groups.own === undefined ? { runs: 6, hosts: 3 } : groups.own;
  const caseVersions = Object.fromEntries(run.cases.map((c) => [c.id, 1]));
  return {
    studiedAt: '2026-10-26T00:00:00.000Z',
    runnerImage: 'unknown',
    runs: 20,
    pageCache,
    caseVersions,
    method: 'lognormal-family-wise-t-p50',
    pooled: groupOf(groups.pooledMs ?? ceilingMs, 20, 10),
    byCpu:
      own === null
        ? { 'Other CPU': groupOf(1, 10, 5) }
        : { [run.machine.cpu]: groupOf(ceilingMs, own.runs, own.hosts) },
  };
}
