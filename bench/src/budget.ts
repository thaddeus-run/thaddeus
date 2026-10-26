// The everyday-command budgets: a committed file of per-command targets,
// and the report that sets a bench run against them. Every function here is
// pure except `readBudgets`; the CLI reads the run files and prints.

import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import schema from '../schema/budgets.schema.json';
import type { BenchRun, CaseResult } from './result';

// The committed budgets of the everyday commands.
export const BUDGETS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'budgets',
  'everyday.json'
);

// One command in one environment. A measured row names the thaddeus case
// and the git case it is compared with; an unmeasured row has neither and
// says why, and which issue owns the missing measurement.
export interface BudgetRow {
  command: string;
  env: string;
  thaddeus?: string;
  git?: string;
  /** Only results of this page-cache mode pair; unset means non-cold, or warm. */
  pageCache?: 'warm' | 'dropped';
  /** The median target, applied on `Budgets.targetFixture` only. */
  targetMs: number;
  /** The most thaddeus may take as a multiple of git's median. */
  targetMultiple: number;
  unmeasured?: string;
  owner?: string;
}

// Why a miss happens: filled in from measured runs, keyed `command/env`.
export interface BudgetAttribution {
  owner: string | null;
  cause: string;
  evidence: string;
}

export interface Budgets {
  $schema?: string;
  version: 1;
  /** The fixture the absolute targets apply to. */
  targetFixture: string;
  rows: BudgetRow[];
  attribution: Record<string, BudgetAttribution>;
}

// One row's result on one fixture (and page-cache mode).
export interface BudgetLine {
  command: string;
  env: string;
  fixture: string | null;
  pageCache: 'warm' | 'dropped' | null;
  thaddeusP50: number | null;
  gitP50: number | null;
  multiple: number | null;
  targetMs: number;
  targetMultiple: number;
  /** null when the fixture is not the target fixture or a side did not finish. */
  targetMet: boolean | null;
  multipleMet: boolean | null;
  status: 'ok' | 'exceeded' | 'oom' | 'error' | 'missing' | 'unmeasured';
  /** The issue that owns an unmeasured row, or the attribution of a missed line. */
  owner: string | null;
  /** Why the row is unmeasured, why a side failed, or the attribution's cause. */
  cause: string | null;
  /** The attribution's evidence, on a missed line that has one. */
  evidence: string | null;
}

// Compiled once at import, as `validateRun` does for runs.
const validate = new Ajv2020({ allErrors: true }).compile(schema);

// Checks an unknown value against the budgets JSON Schema and returns one
// human-readable string per violation; an empty array means it is valid.
export function validateBudgets(value: unknown): string[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map(
    (e) =>
      `${e.instancePath === '' ? '(root)' : e.instancePath} ${e.message ?? 'is invalid'}`
  );
}

// Reads and validates a budgets file. A file that cannot be read, is not
// JSON, or fails the schema throws an Error naming the path (and, for the
// schema, the first violations), which the CLI reports as a bad input file.
export function readBudgets(path: string): Budgets {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  const errors = validateBudgets(value);
  if (errors.length > 0) {
    throw new Error(
      `${path} is not a budgets file:\n  ${errors.slice(0, 5).join('\n  ')}`
    );
  }
  return value as Budgets;
}

// The ids of every case the budgets measure, sorted and unique. CI runs
// exactly these cases and no others.
export function budgetCaseIds(budgets: Budgets): string[] {
  const ids = new Set<string>();
  for (const row of budgets.rows) {
    if (row.thaddeus !== undefined) ids.add(row.thaddeus);
    if (row.git !== undefined) ids.add(row.git);
  }
  return [...ids].sort();
}

// The key a line's ratio goes by in the CI ceilings file: command and
// environment, then the fixture and page-cache mode it was measured on.
export function ratioKey(line: BudgetLine): string {
  return `${line.command}/${line.env} ${line.fixture} ${line.pageCache}`;
}

// The results of one case that a row may use: with the row's page-cache
// mode set, only that mode; without it, non-cold results and the warm
// results of a cold case.
function candidates(
  run: BenchRun,
  id: string,
  row: BudgetRow
): Map<string, CaseResult> {
  const found = new Map<string, CaseResult>();
  for (const c of run.cases) {
    if (c.id !== id) continue;
    const usable =
      row.pageCache === undefined
        ? c.pageCache === undefined || c.pageCache === 'warm'
        : c.pageCache === row.pageCache;
    // Two results of one case, fixture and mode would be two rounds of one
    // run; the first stands in for them.
    if (usable && !found.has(pairId(c))) found.set(pairId(c), c);
  }
  return found;
}

function pairId(c: CaseResult): string {
  return `${c.fixture}\0${c.pageCache ?? ''}`;
}

// The line for a row with no result on either side: the row exists, but
// no case it needs ran.
function missingLine(row: BudgetRow, cause: string): BudgetLine {
  return {
    ...emptyLine(row),
    fixture: null,
    pageCache: row.pageCache ?? null,
    status: 'missing',
    cause,
  };
}

function emptyLine(row: BudgetRow): BudgetLine {
  return {
    command: row.command,
    env: row.env,
    fixture: null,
    pageCache: null,
    thaddeusP50: null,
    gitP50: null,
    multiple: null,
    targetMs: row.targetMs,
    targetMultiple: row.targetMultiple,
    targetMet: null,
    multipleMet: null,
    status: 'missing',
    owner: null,
    cause: null,
    evidence: null,
  };
}

// The line for one fixture and page-cache mode of a measured row. A side
// that did not finish `ok` gives its status and no multiple; targets are
// judged only when both sides finished, and the absolute target only on the
// target fixture.
function pairedLine(
  row: BudgetRow,
  budgets: Budgets,
  fixture: string,
  pageCache: 'warm' | 'dropped' | null,
  thaddeus: CaseResult | undefined,
  git: CaseResult | undefined
): BudgetLine {
  const line: BudgetLine = {
    ...emptyLine(row),
    fixture,
    pageCache,
    thaddeusP50: thaddeus?.p50Ms ?? null,
    gitP50: git?.p50Ms ?? null,
  };
  if (thaddeus === undefined || git === undefined) {
    const absent = thaddeus === undefined ? row.thaddeus : row.git;
    return { ...line, cause: `no ${absent} result on ${fixture}` };
  }
  const failed = [thaddeus, git].find((c) => c.status !== 'ok');
  if (failed !== undefined) {
    return {
      ...line,
      status: failed.status,
      cause: failed.note ?? null,
    };
  }
  const multiple =
    thaddeus.p50Ms !== null && git.p50Ms !== null && git.p50Ms > 0
      ? thaddeus.p50Ms / git.p50Ms
      : null;
  const done: BudgetLine = { ...line, status: 'ok', multiple };
  if (thaddeus.p50Ms !== null && fixture === budgets.targetFixture) {
    done.targetMet = thaddeus.p50Ms <= row.targetMs;
  }
  if (multiple !== null) done.multipleMet = multiple <= row.targetMultiple;
  return done;
}

// Whether a line missed a target, which is what gets an attribution.
function missed(line: BudgetLine): boolean {
  return line.targetMet === false || line.multipleMet === false;
}

// Sets a bench run against the budgets: one line per measured row and
// fixture that has a result (and page-cache mode), in row order, and one
// line per unmeasured row. A measured row with no result on any fixture
// gives one `missing` line. A missed line carries the attribution filed
// under its `command/env`, if there is one.
export function evaluateBudgets(run: BenchRun, budgets: Budgets): BudgetLine[] {
  const lines: BudgetLine[] = [];
  for (const row of budgets.rows) {
    if (
      row.thaddeus === undefined ||
      row.git === undefined ||
      row.unmeasured !== undefined
    ) {
      lines.push({
        ...emptyLine(row),
        status: 'unmeasured',
        owner: row.owner ?? null,
        cause: row.unmeasured ?? null,
      });
      continue;
    }
    const thaddeus = candidates(run, row.thaddeus, row);
    const git = candidates(run, row.git, row);
    const ids = [...new Set([...thaddeus.keys(), ...git.keys()])].sort();
    if (ids.length === 0) {
      lines.push(missingLine(row, `no ${row.thaddeus} or ${row.git} result`));
      continue;
    }
    for (const id of ids) {
      const sample = thaddeus.get(id) ?? git.get(id);
      if (sample === undefined) continue;
      const line = pairedLine(
        row,
        budgets,
        sample.fixture,
        sample.pageCache ?? null,
        thaddeus.get(id),
        git.get(id)
      );
      const why = budgets.attribution[`${row.command}/${row.env}`];
      if (missed(line) && why !== undefined) {
        line.owner = why.owner;
        line.cause = why.cause;
        line.evidence = why.evidence;
      }
      lines.push(line);
    }
  }
  return lines;
}

// Combines the lines of several evaluations (runs of different commits,
// which cannot be merged) into one report. Rows keep the order of their first
// appearance. Of two lines for one row, fixture and mode, the one that is
// not `missing` wins, then the earlier one; a row's fixture-less `missing`
// line goes when the row has any other.
export function combineBudgetLines(sets: BudgetLine[][]): BudgetLine[] {
  const rows = new Map<string, Map<string, BudgetLine>>();
  for (const line of sets.flat()) {
    const rowKey = `${line.command}/${line.env}`;
    const byKey = rows.get(rowKey) ?? new Map<string, BudgetLine>();
    rows.set(rowKey, byKey);
    const key = `${line.fixture ?? ''}\0${line.pageCache ?? ''}`;
    const have = byKey.get(key);
    if (
      have === undefined ||
      (have.status === 'missing' && line.status !== 'missing')
    ) {
      byKey.set(key, line);
    }
  }
  const combined: BudgetLine[] = [];
  for (const byKey of rows.values()) {
    const lines = [...byKey.values()];
    const hasOther = lines.some((l) => l.fixture !== null);
    for (const line of lines) {
      if (line.fixture === null && line.status === 'missing' && hasOther)
        continue;
      combined.push(line);
    }
  }
  return combined;
}

function ms(value: number | null): string {
  return value === null ? '-' : value.toFixed(1);
}

function yesNo(value: boolean | null): string {
  return value === null ? '-' : value ? 'yes' : 'no';
}

// The report as Markdown: a table with one row per line, then the
// attribution of every missed line ("unattributed" when it has none), then
// the owner of every unmeasured row.
export function renderBudgets(lines: readonly BudgetLine[]): string {
  const out = [
    '| Command | Env | Fixture | Page cache | thaddeus p50 (ms) | git p50 (ms) | Multiple | Target (ms) | Target multiple | Target met | Multiple met | Status |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |',
  ];
  for (const l of lines) {
    out.push(
      `| ${l.command} | ${l.env} | ${l.fixture ?? '-'} | ${l.pageCache ?? '-'} | ${ms(l.thaddeusP50)} | ${ms(l.gitP50)} | ${l.multiple === null ? '-' : l.multiple.toFixed(2)} | ${l.targetMs} | ${l.targetMultiple} | ${yesNo(l.targetMet)} | ${yesNo(l.multipleMet)} | ${l.status} |`
    );
  }
  const misses = lines.filter(missed);
  if (misses.length > 0) {
    out.push('', 'Missed:', '');
    for (const l of misses) {
      const why =
        l.cause === null
          ? 'unattributed'
          : `${l.owner ?? 'no owner'}: ${l.cause} (${l.evidence ?? 'no evidence'})`;
      const where = [l.fixture, l.pageCache].filter((p) => p !== null);
      out.push(`- ${[`${l.command}/${l.env}`, ...where].join(' ')}: ${why}`);
    }
  }
  const unmeasured = lines.filter((l) => l.status === 'unmeasured');
  if (unmeasured.length > 0) {
    out.push('', 'Unmeasured:', '');
    for (const l of unmeasured) {
      out.push(
        `- ${l.command}/${l.env}: ${l.owner ?? 'no owner'}, ${l.cause ?? ''}`
      );
    }
  }
  return `${out.join('\n')}\n`;
}
