// The everyday-command budgets: a committed file of per-command targets,
// and the report that sets a bench run against them. Every function here is
// pure except `readBudgets`; the CLI reads the run files and prints.

import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import schema from '../schema/budgets.schema.json';
import type { BenchCase } from './case';
import {
  type PageCacheMode,
  registryFor,
  type SuiteName,
  type SuiteOptions,
} from './record';
import type { BenchRun, CaseResult } from './result';
import { effectiveRepeats } from './runner';
import { logMeanStdev, tQuantile } from './stats';

// The committed budgets of the everyday commands.
export const BUDGETS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'budgets',
  'everyday.json'
);

// The ceilings the CI gate holds the thaddeus p50 of each row to, calibrated
// on the GitHub runner.
export const CEILINGS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'budgets',
  'ceilings-github-ubuntu-latest.json'
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

// The key a line goes by in the CI ceilings file (its row key): command and
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

// What the CI gate measures: every case a budget row names, on small, with
// 3 repeats and 1 warm-up. Server cases cannot seed medium until THA-21, so
// small is the largest fixture the gate can run today. Both page-cache modes
// run, because the ci-checkout row is a dropped-cache row; `only` is not
// part of it, because it comes from the budgets file (see `gateOptions`).
export const GATE_METHOD = {
  suite: 'all' as const,
  fixtures: ['small'],
  sweeps: false,
  pageCache: ['warm', 'dropped'] as PageCacheMode[],
  repeats: 3,
  warmup: 1,
  budgetMs: 300_000,
};

// The suite options of one gate measurement: `GATE_METHOD` over exactly the
// cases the budgets name. `gate-run` (what CI runs) and `calibrate` both
// call this, so the method a ceiling was calibrated with is the method the
// gate measures with. `pageCache` narrows the modes (a machine that cannot
// drop its page cache passes `['warm']`).
export function gateOptions(
  budgets: Budgets,
  pageCache: PageCacheMode[] = GATE_METHOD.pageCache
): SuiteOptions {
  return {
    ...GATE_METHOD,
    fixtures: [...GATE_METHOD.fixtures],
    pageCache,
    only: budgetCaseIds(budgets),
  };
}

// What one row key's ceiling rests on: the thaddeus p50 (ms) of its row
// over `n` calibration runs, as the geometric mean and the standard deviation
// of the logs, and the Student-t quantile `t` that sets the ceiling
// exp(log(geoMeanMs) + t * logSd).
export interface P50Ceiling {
  ceilingMs: number;
  n: number;
  t: number;
  geoMeanMs: number;
  logSd: number;
}

// The ceilings of one group of calibration runs (one CPU model, or all of
// them pooled): for each row key (see `ratioKey`), the largest thaddeus p50
// that host noise plausibly produces within the group. `runs` and `hosts`
// count what they rest on.
export interface CeilingGroup {
  runs: number;
  /** How many distinct hosts the runs came from. */
  hosts: number;
  /** How many keys got a ceiling (N in the Bonferroni split). */
  familySize: number;
  p50Ceilings: Record<string, P50Ceiling>;
}

// The result of a calibration study. The gate holds the thaddeus p50 of each
// row to a ceiling; the multiple of git is only reported, because git's
// median drifts between runs more than thaddeus's own. Hosts differ in speed
// by CPU model (a row's p50 differs 2x between models on GitHub's runners),
// and one pooled ceiling over a mix of models has to sit above the slowest
// model, so the file keeps a group per CPU model next to the pooled one. The
// gate uses a model's group when it rests on enough runs and hosts (see
// `ceilingGroupFor`) and the pooled one otherwise.
export interface Ceilings {
  studiedAt: string;
  runnerImage: string;
  /** How many calibration runs the study had in all. */
  runs: number;
  /** The page-cache modes the study measured; the gate requires only those. */
  pageCache: PageCacheMode[];
  /** Every gated case id and the version the study measured, so a changed case invalidates its ceilings. */
  caseVersions: Record<string, number>;
  /**
   * Every gated case id and the manifest hash of the fixture the study
   * measured it on, so a changed fixture invalidates the ceilings. A file
   * without it (written before the field existed) is stale to the gate.
   */
  manifestHashes?: Record<string, string>;
  method: 'lognormal-family-wise-t-p50';
  pooled: CeilingGroup;
  /** By `machine.cpu` of the runs. */
  byCpu: Record<string, CeilingGroup>;
}

// A CPU model's group is used by the gate only with at least this many runs
// from at least this many hosts: two runs on one host agree within a few
// percent, so they say little about the model's host-to-host spread.
export const GROUP_MIN_RUNS = 6;
export const GROUP_MIN_HOSTS = 3;

// Whether the gate may use the ceilings group of CPU model `cpu`. It needs
// enough runs and hosts, and a model the runs actually identified: `unknown`
// and the empty string are what a host reports when it could not read its
// CPU, and unrelated hosts would share that group.
export function groupQualifies(cpu: string, group: CeilingGroup): boolean {
  return (
    cpu !== 'unknown' &&
    cpu !== '' &&
    group.runs >= GROUP_MIN_RUNS &&
    group.hosts >= GROUP_MIN_HOSTS
  );
}

// The family-wise error rate the ceilings allow: the chance that an
// unchanged PR fails the gate on noise alone.
const FAMILY_WISE_ALPHA = 0.01;

// A key needs at least this many runs for a standard deviation that means
// anything.
const MIN_RUNS = 3;

// The ceilings of one group: the largest thaddeus p50 that host and runner
// noise plausibly produce for each row key, from the group's runs. The p50s
// of a key are modelled as lognormal: with mu and sigma the mean and sample
// standard deviation of their logs, the ceiling is exp(mu + t * sigma). t is
// the Student-t quantile of 1 - 0.01 / N at n - 1 degrees of freedom, for the
// N keys that get a ceiling: a Bonferroni split that puts the chance of any
// false alarm in a PR at nominally about 1%. Student's t rather than the
// normal, because sigma is estimated from only n runs. A key with fewer than
// three p50s gets no ceiling.
export function deriveGroup(
  p50s: Record<string, number[]>,
  counts: { runs: number; hosts: number }
): CeilingGroup {
  const studied = Object.entries(p50s).filter(([, r]) => r.length >= MIN_RUNS);
  const p50Ceilings: Record<string, P50Ceiling> = {};
  for (const [key, r] of studied) {
    const t = tQuantile(1 - FAMILY_WISE_ALPHA / studied.length, r.length - 1);
    const { mu, sigma } = logMeanStdev(r);
    p50Ceilings[key] = {
      ceilingMs: Math.exp(mu + t * sigma),
      n: r.length,
      t,
      geoMeanMs: Math.exp(mu),
      logSd: sigma,
    };
  }
  return { ...counts, familySize: studied.length, p50Ceilings };
}

// The file name `hostOfFile` reads a host from: `run-<host>-<k>.json`.
const CALIBRATION_FILE = /^run-(.+)-\d+\.json$/;

// The host a result file came from: the `<host>` of `run-<host>-<k>.json` (the
// CI calibration names its files so), or the file name itself, which counts
// the file as a host of its own.
export function hostOfFile(name: string): string {
  const match = CALIBRATION_FILE.exec(name.slice(name.lastIndexOf('/') + 1));
  return match === null ? name : match[1];
}

// Whether `name` is named `run-<host>-<k>.json`. Any other file counts as a
// host of its own, which inflates the host count of its CPU group.
export function isCalibrationFile(name: string): boolean {
  return CALIBRATION_FILE.test(name.slice(name.lastIndexOf('/') + 1));
}

// The ceilings the gate uses for a run, and why: the group of the run's CPU
// model when it qualifies (see `groupQualifies`), else the pooled group.
// `note` is the one line the gate prints about the choice.
export function ceilingGroupFor(
  ceilings: Ceilings,
  cpu: string
): { group: CeilingGroup; note: string } {
  const own = ceilings.byCpu[cpu];
  const counted = (g: CeilingGroup) => `${g.runs} runs from ${g.hosts} hosts`;
  if (own !== undefined && groupQualifies(cpu, own)) {
    return {
      group: own,
      note: `ceilings: using the group of CPU model ${cpu} (${counted(own)})`,
    };
  }
  const why =
    own === undefined
      ? 'was not calibrated'
      : cpu === 'unknown' || cpu === ''
        ? 'is not a CPU model the host identified'
        : `was calibrated on only ${counted(own)}, and a group needs ${GROUP_MIN_RUNS} runs from ${GROUP_MIN_HOSTS} hosts`;
  return {
    group: ceilings.pooled,
    note: `ceilings: using the pooled group (${counted(ceilings.pooled)}); CPU model ${cpu} ${why}`,
  };
}

// The thaddeus p50 of every line that finished `ok`, by row key. A line
// that did not finish contributes nothing, so a calibration run that lost a
// case simply has one fewer p50 for it.
export function linesP50(lines: readonly BudgetLine[]): Record<string, number> {
  const p50s: Record<string, number> = {};
  for (const line of lines) {
    if (line.status === 'ok' && line.thaddeusP50 !== null) {
      p50s[ratioKey(line)] = line.thaddeusP50;
    }
  }
  return p50s;
}

// The version of every gated case that has a result in a run. The versions
// of one suite version do not differ between results of the same case.
export function gatedCaseVersions(
  run: BenchRun,
  budgets: Budgets
): Record<string, number> {
  const gated = new Set(budgetCaseIds(budgets));
  const versions: Record<string, number> = {};
  for (const c of run.cases) {
    if (gated.has(c.id)) versions[c.id] = c.version;
  }
  return versions;
}

// The manifest hash of every gated case in `run`, by case id. A case measured
// on several fixtures gets its distinct hashes, sorted and joined by commas,
// so any change among them shows. The hash covers the fixture's plan, so it
// moves when the generated repository does.
export function gatedManifestHashes(
  run: BenchRun,
  budgets: Budgets
): Record<string, string> {
  const gated = new Set(budgetCaseIds(budgets));
  const seen: Record<string, Set<string>> = {};
  for (const c of run.cases) {
    if (gated.has(c.id)) (seen[c.id] ??= new Set()).add(c.manifestHash);
  }
  return Object.fromEntries(
    Object.entries(seen).map(([id, hashes]) => [
      id,
      [...hashes].sort().join(','),
    ])
  );
}

// The repeats and warm-ups each gated case records when measured with
// `GATE_METHOD`: the method's, raised or capped by the case's own
// `minRepeats`, `maxRepeats` and `maxWarmup`. Read from the case registries,
// so a case that changes its limits changes what the gate expects.
export async function gateMethods(
  budgets: Budgets,
  lookup: (suite: SuiteName) => string | null = registryFor
): Promise<Record<string, { repeats: number; warmup: number }>> {
  const gated = new Set(budgetCaseIds(budgets));
  const methods: Record<string, { repeats: number; warmup: number }> = {};
  for (const suite of ['e2e', 'everyday'] as const) {
    const registry = lookup(suite);
    if (registry === null) continue;
    const mod = (await import(registry)) as { default: readonly BenchCase[] };
    for (const benchCase of mod.default) {
      if (gated.has(benchCase.id)) {
        methods[benchCase.id] = effectiveRepeats(benchCase, GATE_METHOD);
      }
    }
  }
  return methods;
}

// Why results of gated cases were not measured with the gate method: one
// message per result whose recorded repeats or warm-ups differ from what
// `gateMethods` expects for its case. A p50 of 10 repeats is not comparable
// with ceilings calibrated on 3.
export function methodMismatches(
  run: BenchRun,
  budgets: Budgets,
  methods: Record<string, { repeats: number; warmup: number }>
): { name: string; why: string }[] {
  const gated = new Set(budgetCaseIds(budgets));
  const found: { name: string; why: string }[] = [];
  for (const c of run.cases) {
    if (!gated.has(c.id)) continue;
    const expected = methods[c.id];
    const name = `${c.id} ${c.fixture}${c.pageCache === undefined ? '' : ` ${c.pageCache}`}`;
    if (expected === undefined) {
      found.push({
        name,
        why: 'no registered case to take the gate method from',
      });
    } else if (c.repeats !== expected.repeats || c.warmup !== expected.warmup) {
      found.push({
        name,
        why: `not measured with the gate method: ${c.repeats} repeats and ${c.warmup} warm-ups, where the gate takes ${expected.repeats} and ${expected.warmup}`,
      });
    }
  }
  return found;
}

// The page-cache modes a set of runs measured: `warm` for any result that
// ran warm or has no mode, and `dropped` for a dropped-cache result.
function measuredModes(
  runs: readonly BenchRun[],
  budgets: Budgets
): PageCacheMode[] {
  const gated = new Set(budgetCaseIds(budgets));
  const modes = new Set<PageCacheMode>();
  for (const run of runs) {
    for (const c of run.cases) {
      if (gated.has(c.id)) modes.add(c.pageCache ?? 'warm');
    }
  }
  return (['warm', 'dropped'] as const).filter((m) => modes.has(m));
}

// The p50 of every gated row in each of `runs`, by row key.
function p50sOf(
  runs: readonly { run: BenchRun }[],
  budgets: Budgets
): Record<string, number[]> {
  const p50s: Record<string, number[]> = {};
  for (const { run } of runs) {
    for (const [key, p50] of Object.entries(
      linesP50(evaluateBudgets(run, budgets))
    )) {
      (p50s[key] ??= []).push(p50);
    }
  }
  return p50s;
}

// Derives the ceilings file from runs of the gate method, one run per file,
// each with the host it ran on: a group per CPU model (`machine.cpu`) and the
// pooled group over all runs. Used by `bench ceilings` (runs gathered on many
// hosts) and by `bench calibrate` (runs of one host in a loop), so both derive
// the same way. Throws an Error when two runs measured different case
// versions, because their p50s are not of the same work.
export function ceilingsFromRuns(
  runs: readonly { name: string; host: string; run: BenchRun }[],
  budgets: Budgets,
  meta: { studiedAt: string; runnerImage: string }
): Ceilings {
  if (runs.length === 0) throw new Error('no runs to derive ceilings from');
  const caseVersions = gatedCaseVersions(runs[0].run, budgets);
  const manifestHashes = gatedManifestHashes(runs[0].run, budgets);
  for (const { name, run } of runs.slice(1)) {
    const versions = gatedCaseVersions(run, budgets);
    const differing = [
      ...new Set([...Object.keys(caseVersions), ...Object.keys(versions)]),
    ].filter((id) => caseVersions[id] !== versions[id]);
    if (differing.length > 0) {
      throw new Error(
        `${name} has other case versions than ${runs[0].name} (${differing.join(', ')}); ceilings need runs of one set of case versions`
      );
    }
    const hashes = gatedManifestHashes(run, budgets);
    const moved = Object.keys(manifestHashes).filter(
      (id) => manifestHashes[id] !== hashes[id]
    );
    if (moved.length > 0) {
      throw new Error(
        `${name} has other fixture hashes than ${runs[0].name} (${moved.join(', ')}); ceilings need runs of one set of fixtures`
      );
    }
  }
  const groupOf = (members: typeof runs) =>
    deriveGroup(p50sOf(members, budgets), {
      runs: members.length,
      hosts: new Set(members.map((m) => m.host)).size,
    });
  const byCpu: Record<string, CeilingGroup> = {};
  for (const cpu of new Set(runs.map((r) => r.run.machine.cpu))) {
    byCpu[cpu] = groupOf(runs.filter((r) => r.run.machine.cpu === cpu));
  }
  return {
    ...meta,
    runs: runs.length,
    pageCache: measuredModes(
      runs.map((r) => r.run),
      budgets
    ),
    caseVersions,
    manifestHashes,
    method: 'lognormal-family-wise-t-p50',
    pooled: groupOf(runs),
    byCpu,
  };
}

// Reads a ceilings file. A file that does not exist is `null`, which the gate
// fails on; one that exists but is not a ceilings file throws an Error naming
// the path, which the CLI reports as a bad input file.
export function readCeilings(path: string): Ceilings | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  const c = value as Partial<Ceilings> | null;
  const positive = (v: unknown): boolean => typeof v === 'number' && v > 0;
  const validGroup = (g: CeilingGroup | undefined): boolean =>
    typeof g === 'object' &&
    g !== null &&
    typeof g.runs === 'number' &&
    typeof g.hosts === 'number' &&
    typeof g.familySize === 'number' &&
    typeof g.p50Ceilings === 'object' &&
    g.p50Ceilings !== null &&
    Object.values(g.p50Ceilings).every(
      (k) =>
        positive(k.ceilingMs) &&
        positive(k.geoMeanMs) &&
        positive(k.t) &&
        typeof k.logSd === 'number' &&
        typeof k.n === 'number' &&
        k.n >= MIN_RUNS
    );
  const valid =
    typeof c?.studiedAt === 'string' &&
    typeof c.runnerImage === 'string' &&
    typeof c.runs === 'number' &&
    Array.isArray(c.pageCache) &&
    c.pageCache.every((m) => m === 'warm' || m === 'dropped') &&
    c.method === 'lognormal-family-wise-t-p50' &&
    typeof c.caseVersions === 'object' &&
    c.caseVersions !== null &&
    Object.values(c.caseVersions).every(positive) &&
    (c.manifestHashes === undefined ||
      (typeof c.manifestHashes === 'object' &&
        c.manifestHashes !== null &&
        Object.values(c.manifestHashes).every((h) => typeof h === 'string'))) &&
    validGroup(c.pooled) &&
    typeof c.byCpu === 'object' &&
    c.byCpu !== null &&
    Object.values(c.byCpu).every(validGroup);
  if (!valid) throw new Error(`${path} is not a ceilings file`);
  return value as Ceilings;
}

// A line's name in gate output: its row key when it has a fixture, else
// the row alone (a row with no result on any fixture).
function lineName(line: BudgetLine): string {
  return line.fixture === null
    ? `${line.command}/${line.env}${line.pageCache === null ? '' : ` ${line.pageCache}`}`
    : ratioKey(line);
}

function msText(value: number): string {
  return `${value.toFixed(1)} ms`;
}

// The gate: sets a run against the ceilings and says whether the build may
// pass. It checks the thaddeus p50 of every measured row, not its multiple of
// git: git's median drifts between runs, thaddeus's does not. It passes only
// when the ceilings were calibrated on the same case versions, every gated
// result was measured with the gate method (`methods`, from `gateMethods`),
// every measured row has results that finished `ok`, and every p50 is at or
// below its ceiling. A verdict it cannot reach (no ceilings file, a
// ceiling-less key) is a failure, never a pass. The ceilings are those of the
// run's CPU model when calibrated well enough, else the pooled ones; the
// first line says which (see `ceilingGroupFor`). Unmeasured rows are ignored,
// and neither a missed absolute target nor the multiple of git fails the
// gate; the multiple is printed for information. A row of a page-cache mode
// the calibration did not measure is skipped only when the run has no result
// for it at all. `lines` is one line per checked key: `ok`, `regression` or
// `not ok`.
export function checkGate(
  run: BenchRun,
  budgets: Budgets,
  ceilings: Ceilings | null,
  methods: Record<string, { repeats: number; warmup: number }>,
  modes?: readonly PageCacheMode[]
): { failed: boolean; lines: string[] } {
  if (ceilings === null) {
    return {
      failed: true,
      lines: [
        'not ok no ceilings file; run `bench calibrate` or `bench ceilings` to create one before gating',
      ],
    };
  }
  const have = gatedCaseVersions(run, budgets);
  const stale = Object.entries(have)
    .filter(([id, version]) => ceilings.caseVersions[id] !== version)
    .map(
      ([id, version]) =>
        `${id} is v${version} in the run and ${ceilings.caseVersions[id] === undefined ? 'absent' : `v${ceilings.caseVersions[id]}`} in the ceilings`
    );
  if (stale.length > 0) {
    return {
      failed: true,
      lines: [
        `not ok ceilings were calibrated on other case versions (${stale.join('; ')}); re-run calibration`,
      ],
    };
  }

  const hashes = gatedManifestHashes(run, budgets);
  const recorded = ceilings.manifestHashes;
  const moved =
    recorded === undefined
      ? ['the ceilings file records no fixture hashes']
      : Object.entries(hashes)
          .filter(([id, hash]) => recorded[id] !== hash)
          .map(
            ([id]) =>
              `${id} ran on another fixture than the one calibrated${recorded[id] === undefined ? ' (absent from the ceilings)' : ''}`
          );
  if (moved.length > 0) {
    return {
      failed: true,
      lines: [
        `not ok stale ceilings; re-run calibration (${moved.join('; ')})`,
      ],
    };
  }

  const { group, note } = ceilingGroupFor(ceilings, run.machine.cpu);
  const lines: string[] = [note];
  let failed = false;
  const fail = (name: string, why: string): void => {
    failed = true;
    lines.push(`not ok ${name}: ${why}`);
  };
  for (const { name, why } of methodMismatches(run, budgets, methods)) {
    fail(name, why);
  }
  let checked = 0;
  for (const line of evaluateBudgets(run, budgets)) {
    if (line.status === 'unmeasured') continue;
    if (
      line.status === 'missing' &&
      line.fixture === null &&
      line.pageCache !== null &&
      !ceilings.pageCache.includes(line.pageCache)
    ) {
      continue;
    }
    // A row in a page-cache mode the run did not measure (a warm-only run
    // on a host without `sudo -n`, named with --page-cache) is skipped, not
    // failed, and the output says so. CI passes no flag, so the modes are
    // the gate method's and nothing is skipped.
    if (
      line.status === 'missing' &&
      line.fixture === null &&
      line.pageCache !== null &&
      modes !== undefined &&
      !modes.includes(line.pageCache)
    ) {
      lines.push(
        `skip ${line.command}/${line.env} ${line.pageCache}: the run did not measure page-cache ${line.pageCache}`
      );
      continue;
    }
    checked++;
    const name = lineName(line);
    if (line.status !== 'ok') {
      fail(
        name,
        `${line.status}${line.cause === null ? '' : ` (${line.cause})`}`
      );
      continue;
    }
    if (line.thaddeusP50 === null) {
      fail(name, 'the thaddeus case recorded no p50');
      continue;
    }
    const ceiling = group.p50Ceilings[ratioKey(line)];
    if (ceiling === undefined) {
      fail(name, 'no ceiling; re-run calibration');
      continue;
    }
    const multiple =
      line.multiple === null
        ? 'no multiple of git'
        : `${line.multiple.toFixed(1)}x git`;
    if (line.thaddeusP50 > ceiling.ceilingMs) {
      failed = true;
      lines.push(
        `regression ${name}: p50 ${msText(line.thaddeusP50)} is above its ceiling ${msText(ceiling.ceilingMs)} (${multiple})`
      );
    } else {
      lines.push(
        `ok ${name}: p50 ${msText(line.thaddeusP50)} <= ceiling ${msText(ceiling.ceilingMs)} (${multiple})`
      );
    }
  }
  if (checked === 0) {
    failed = true;
    lines.push('not ok the budgets name no measured row to gate');
  }
  return { failed, lines };
}
