// Base-against-head comparison of two commits, the A/A noise study that
// sets its thresholds, and the merging of interleaved round files. All
// functions here are pure; the CLI reads and writes the files.

import type { BenchRun, CaseResult, CaseStatus } from './result';
import { logMeanStdev, normalQuantile, summarize } from './stats';

// Where and how an A/A noise study ran. `pairs` counts the pairs it
// completed, which is fewer than asked when the study was cut off.
export interface ThresholdStudy {
  studiedAt: string;
  runnerImage: string;
  suiteVersion: string;
  pairs: number;
}

// The result of an A/A noise study: for each case (`id@version`), the
// largest head/base p50 ratio noise plausibly produces on this runner image.
// The bounds are set for the whole family of cases at once: with every case
// unchanged, nominally about 1% of PRs see any case over its threshold.
export interface Thresholds extends ThresholdStudy {
  method: 'lognormal-family-wise';
  /** How many cases got a threshold (N in the Bonferroni split). */
  familySize: number;
  /** The normal quantile of 1 - 0.01 / familySize; null when N is 0. */
  z: number | null;
  perCase: Record<string, number>;
}

// The family-wise error rate the thresholds allow: the chance that a PR
// changing nothing is flagged on noise alone.
const FAMILY_WISE_ALPHA = 0.01;

// A case needs at least this many A/A ratios for a standard deviation that
// means anything.
const MIN_RATIOS = 3;

export type Verdict =
  | 'ok'
  | 'regression'
  | 'improvement'
  | 'not-compared'
  | 'no-threshold';

export interface ComparisonRow {
  /** `id@version fixture`, plus the page-cache mode of a cold case. */
  key: string;
  /** `id@version`: the key into `Thresholds.perCase`. */
  thresholdKey: string;
  baseStatus?: CaseStatus;
  headStatus?: CaseStatus;
  baseP50: number | null;
  headP50: number | null;
  /** Head p50 over base p50. */
  ratio: number | null;
  threshold: number | null;
  verdict: Verdict;
  reason?: string;
}

export interface Comparison {
  rows: ComparisonRow[];
  regressed: boolean;
  /**
   * Whether thresholds were used: `none` without a file, `stale` when the
   * study ran another suite version than head (so none were used).
   */
  thresholds: 'current' | 'stale' | 'none';
  study?: Omit<Thresholds, 'perCase'>;
  baseCommit: string;
  headCommit: string;
  headSuiteVersion: string;
}

// The noise study's threshold for each case. A/A ratios are modelled as
// lognormal: with mu and sigma the mean and sample standard deviation of a
// case's log ratios, its threshold is exp(mu + z * sigma). z is the normal
// quantile of 1 - 0.01 / N for the N cases that get a threshold, a
// Bonferroni split that puts the chance of any false alarm in a PR at
// nominally about 1%.
// (An empirical 99th percentile over 20 pairs is about each case's maximum,
// which a new draw beats ~5% of the time per case.) A threshold below 1
// would flag a case that did not slow down at all, so thresholds are floored
// at 1. A case with fewer than three ratios gets none.
export function deriveThresholds(
  aa: Record<string, number[]>,
  meta: ThresholdStudy
): Thresholds {
  const studied = Object.entries(aa).filter(
    ([, ratios]) => ratios.length >= MIN_RATIOS
  );
  const familySize = studied.length;
  const z =
    familySize === 0
      ? null
      : normalQuantile(1 - FAMILY_WISE_ALPHA / familySize);
  const perCase: Record<string, number> = {};
  for (const [key, ratios] of studied) {
    const { mu, sigma } = logMeanStdev(ratios);
    perCase[key] = Math.max(1, Math.exp(mu + (z ?? 0) * sigma));
  }
  return {
    ...meta,
    method: 'lognormal-family-wise',
    familySize,
    z,
    perCase,
  };
}

// The runner image a noise study ran on, from the variables GitHub's hosted
// runners set (e.g. `ubuntu24-20261020.1`), or "unknown" elsewhere.
export function runnerImage(
  env: Record<string, string | undefined> = process.env
): string {
  const parts = [env.ImageOS, env.ImageVersion].filter(
    (part): part is string => part !== undefined && part !== ''
  );
  return parts.length === 0 ? 'unknown' : parts.join('-');
}

function thresholdKeyOf(c: CaseResult): string {
  return `${c.id}@${c.version}`;
}

// Pairs a base case with its head case: same id, fixture and page-cache
// mode. Version and manifest hash are checked after pairing, so a changed
// case shows up as one "not compared" row instead of a removed and a new one.
function pairKey(c: CaseResult): string {
  return [c.id, c.fixture, c.pageCache ?? ''].join('\0');
}

function displayKey(c: CaseResult): string {
  const mode = c.pageCache === undefined ? '' : ` ${c.pageCache}`;
  return `${thresholdKeyOf(c)} ${c.fixture}${mode}`;
}

// Compares one paired case. Order matters: a case that changed is never
// compared; a status change wins over any threshold (a case that newly
// fails is a regression whatever the noise); only two ok results get a
// ratio, and only a current threshold turns that ratio into a verdict.
function compareCase(
  b: CaseResult,
  h: CaseResult,
  perCase: Record<string, number> | null
): ComparisonRow {
  const row = {
    key: displayKey(h),
    thresholdKey: thresholdKeyOf(h),
    baseStatus: b.status,
    headStatus: h.status,
    baseP50: b.p50Ms,
    headP50: h.p50Ms,
    ratio: null,
    threshold: null,
  };
  if (b.version !== h.version) {
    return {
      ...row,
      verdict: 'not-compared',
      reason: `case version changed (${b.version} in base, ${h.version} in head)`,
    };
  }
  if (b.manifestHash !== h.manifestHash) {
    return {
      ...row,
      verdict: 'not-compared',
      reason: 'fixture manifest changed',
    };
  }
  const baseOk = b.status === 'ok';
  const headOk = h.status === 'ok';
  if (!baseOk && !headOk) {
    return {
      ...row,
      verdict: 'not-compared',
      reason: `base ${b.status}, head ${h.status}`,
    };
  }
  if (!baseOk) {
    return { ...row, verdict: 'improvement', reason: `base ${b.status}` };
  }
  if (!headOk) {
    return { ...row, verdict: 'regression', reason: `head ${h.status}` };
  }
  if (b.p50Ms === null || h.p50Ms === null || b.p50Ms <= 0) {
    return { ...row, verdict: 'not-compared', reason: 'no p50 to compare' };
  }
  const ratio = h.p50Ms / b.p50Ms;
  const threshold = perCase?.[row.thresholdKey] ?? null;
  if (threshold === null) return { ...row, ratio, verdict: 'no-threshold' };
  let verdict: Verdict = 'ok';
  if (ratio > threshold) verdict = 'regression';
  else if (ratio < 1 / threshold) verdict = 'improvement';
  return { ...row, ratio, threshold, verdict };
}

// What a thresholds file says about its study, without the thresholds.
function studyOf(t: Thresholds): Omit<Thresholds, 'perCase'> {
  return {
    studiedAt: t.studiedAt,
    runnerImage: t.runnerImage,
    suiteVersion: t.suiteVersion,
    pairs: t.pairs,
    method: t.method,
    familySize: t.familySize,
    z: t.z,
  };
}

// Compares every case of base and head. Thresholds from a study of another
// suite version describe other cases, so they are treated as absent and the
// comparison says they are stale. `regressed` is true when any row is a
// regression.
export function compareRuns(
  base: BenchRun,
  head: BenchRun,
  t: Thresholds | null
): Comparison {
  const stale = t !== null && t.suiteVersion !== head.suiteVersion;
  const perCase = t === null || stale ? null : t.perCase;
  const heads = new Map(head.cases.map((c) => [pairKey(c), c]));
  const paired = new Set<string>();
  const rows: ComparisonRow[] = [];
  for (const b of base.cases) {
    const h = heads.get(pairKey(b));
    if (h === undefined) {
      rows.push({
        key: displayKey(b),
        thresholdKey: thresholdKeyOf(b),
        baseStatus: b.status,
        baseP50: b.p50Ms,
        headP50: null,
        ratio: null,
        threshold: null,
        verdict: 'not-compared',
        reason: 'removed in head',
      });
      continue;
    }
    paired.add(pairKey(h));
    rows.push(compareCase(b, h, perCase));
  }
  for (const h of head.cases) {
    if (paired.has(pairKey(h))) continue;
    rows.push({
      key: displayKey(h),
      thresholdKey: thresholdKeyOf(h),
      headStatus: h.status,
      baseP50: null,
      headP50: h.p50Ms,
      ratio: null,
      threshold: null,
      verdict: 'not-compared',
      reason: 'new in head',
    });
  }
  return {
    rows,
    regressed: rows.some((r) => r.verdict === 'regression'),
    thresholds: t === null ? 'none' : stale ? 'stale' : 'current',
    ...(t !== null && { study: studyOf(t) }),
    baseCommit: base.commit,
    headCommit: head.commit,
    headSuiteVersion: head.suiteVersion,
  };
}

// Summary table order: what needs attention first.
const VERDICT_ORDER: Verdict[] = [
  'regression',
  'improvement',
  'not-compared',
  'no-threshold',
  'ok',
];

function formatMs(ms: number | null, status: CaseStatus | undefined): string {
  if (status !== undefined && status !== 'ok') return status;
  if (ms === null) return '–';
  return ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toPrecision(3)} ms`;
}

function verdictCell(row: ComparisonRow): string {
  if (row.verdict === 'regression') return '**regression**';
  if (row.verdict === 'no-threshold') return 'no threshold';
  if (row.verdict !== 'not-compared') return row.verdict;
  const changed =
    row.reason !== undefined &&
    /new in head|removed in head|version|manifest/.test(row.reason);
  return changed ? 'new or changed, not compared' : 'not compared';
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// The comparison as a GitHub job summary: a headline with the counts, where
// the thresholds came from, then one table row per case with regressions
// first. Rows keep their suite order within each verdict.
export function renderSummary(cmp: Comparison): string {
  const count = (v: Verdict) => cmp.rows.filter((r) => r.verdict === v).length;
  const lines = [
    '## Benchmarks (report only)',
    '',
    `Base \`${cmp.baseCommit.slice(0, 7)}\` against head \`${cmp.headCommit.slice(0, 7)}\`: ` +
      [
        plural(count('regression'), 'regression'),
        plural(count('improvement'), 'improvement'),
        `${count('ok')} ok`,
        `${count('no-threshold')} without a threshold`,
        `${count('not-compared')} not compared`,
      ].join(', ') +
      '.',
    '',
  ];
  const study = cmp.study;
  if (cmp.thresholds === 'current' && study !== undefined) {
    lines.push(
      `Thresholds from the A/A noise study of ${study.studiedAt.slice(0, 10)} on ${study.runnerImage} (${plural(study.pairs, 'pair')}): ` +
        `each is exp(mean + z × stdev) of the case's log A/A ratios, with z = ${study.z?.toFixed(2) ?? '–'} so that all ${study.familySize} studied cases together raise a false alarm in nominally about 1% of PRs. ` +
        'A case without a threshold is checked for status changes only.'
    );
  } else if (cmp.thresholds === 'stale' && study !== undefined) {
    lines.push(
      `Thresholds are stale: the noise study ran suite \`${study.suiteVersion.slice(0, 12)}\`, head is suite \`${cmp.headSuiteVersion.slice(0, 12)}\`. Ratios are shown without a verdict until the noise study is re-run.`
    );
  } else {
    lines.push(
      'There are no thresholds yet: ratios are shown without a verdict until a noise study is committed.'
    );
  }
  lines.push(
    '',
    '| Case | Base p50 | Head p50 | Ratio | Threshold | Verdict | Note |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  );
  const sorted = [...cmp.rows].sort(
    (a, b) =>
      VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict)
  );
  for (const row of sorted) {
    lines.push(
      `| ${[
        `\`${row.key}\``,
        formatMs(row.baseP50, row.baseStatus),
        formatMs(row.headP50, row.headStatus),
        row.ratio === null ? '–' : row.ratio.toFixed(3),
        row.threshold === null ? '–' : row.threshold.toFixed(3),
        verdictCell(row),
        row.reason ?? '',
      ].join(' | ')} |`
    );
  }
  return `${lines.join('\n')}\n`;
}

// Cases of round files that share a key are one case measured in several
// rounds; the manifest hash is part of the key so different inputs never mix.
function mergeKey(c: CaseResult): string {
  return [pairKey(c), c.version, c.manifestHash].join('\0');
}

// Combines the cases of several rounds into one result: samples are
// concatenated and re-summarized, and the peak RSS is the largest. The first
// failed round (if any) supplies the status, phase and note, because a case
// that failed in any round did not run cleanly. Throughput is kept only when
// every round has one, re-weighted by each round's timed total, which is how
// the runner computes it from a single run's samples.
function mergeCases(rounds: CaseResult[]): CaseResult {
  const [first] = rounds;
  const failed = rounds.find((c) => c.status !== 'ok');
  const { phase, failedAtN, note, throughput, ...common } = failed ?? first;
  const samplesMs = rounds.flatMap((c) => c.samplesMs);
  const merged: CaseResult = {
    ...common,
    status: failed?.status ?? 'ok',
    repeats: rounds.reduce((a, c) => a + c.repeats, 0),
    samplesMs,
    ...summarize(samplesMs),
    peakRssBytes: Math.max(...rounds.map((c) => c.peakRssBytes)),
    ...(phase !== undefined && { phase }),
    ...(failedAtN !== undefined && { failedAtN }),
    ...(note !== undefined && { note }),
  };
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const allMs = sum(samplesMs);
  if (
    failed === undefined &&
    throughput !== undefined &&
    rounds.every((c) => c.throughput?.unit === throughput.unit) &&
    allMs > 0
  ) {
    const weighted = sum(
      rounds.map((c) => (c.throughput?.value ?? 0) * sum(c.samplesMs))
    );
    merged.throughput = { value: weighted / allMs, unit: throughput.unit };
  }
  return merged;
}

// Merges round files of one commit, one suite and one method into a single
// run, as if the rounds had been one run with more repeats. Cases keep the
// order in which they first appear. `method.repeats` becomes the total
// timed repeats per case across the rounds. Sweeps are not merged: the PR
// check runs none, and a sweep has no samples to concatenate.
export function mergeRuns(runs: readonly BenchRun[]): BenchRun {
  const [first] = runs;
  if (first === undefined) throw new Error('merge needs at least one run');
  for (const r of runs) {
    if (r.commit !== first.commit) {
      throw new Error(
        `merge needs runs of one commit (${first.commit} and ${r.commit})`
      );
    }
    if (r.suiteVersion !== first.suiteVersion) {
      throw new Error('merge needs runs of one suite version');
    }
    if (r.sweeps.length > 0) throw new Error('merge does not combine sweeps');
  }
  const groups = new Map<string, CaseResult[]>();
  for (const r of runs) {
    for (const c of r.cases) {
      const group = groups.get(mergeKey(c));
      if (group === undefined) groups.set(mergeKey(c), [c]);
      else group.push(c);
    }
  }
  return {
    ...first,
    dirty: runs.some((r) => r.dirty),
    method: {
      ...first.method,
      repeats: runs.reduce((a, r) => a + r.method.repeats, 0),
    },
    cases: [...groups.values()].map(mergeCases),
    sweeps: [],
  };
}
