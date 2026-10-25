import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addExtra, type BenchCase, loadCase, type RunExtra } from './case';
import type { ChildReport, ChildRequest } from './child';
import { generateFixture, manifestHash } from './fixtures/plan';
import { resolveFixture, sweepSpec } from './fixtures/spec';
import {
  type CaseResult,
  type CaseStatus,
  FILEBACKEND_DURABILITY,
  type SweepResult,
} from './result';
import { fitExponent, summarize } from './stats';

// History lengths of the growth sweep, in ops. Each step doubles.
export const SWEEP_SIZES = [
  1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000,
] as const;

export interface RunOptions {
  repeats: number;
  warmup: number;
  /** Wall-clock budget for the whole case, setup included, across all children. */
  budgetMs: number;
  /** Path of a registry module that default-exports `readonly BenchCase[]`. */
  registry: string;
  pageCache?: 'warm' | 'dropped';
  /** Runs in the parent before each per-sample spawn (e.g. drop the page cache). */
  beforeSample?: () => Promise<void>;
  /** Passed through to the case as `ctx.durationMs`. */
  durationMs?: number;
}

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url));

const OOM_STDERR = /out of memory|JavaScript heap|Allocation failed/i;

const STDERR_TAIL_BYTES = 2_048;

interface ChildOutcome {
  status: CaseStatus;
  /** The last phase the child announced; `setup` if it announced none. */
  phase: 'setup' | 'run';
  report?: ChildReport;
  stderr: string;
  exitCode: number | null;
  peakRssBytes: number;
  elapsedMs: number;
}

// Process groups of children that are still running. A child runs in its own
// group so a budget kill also takes down whatever it started (an e2e case's
// `thaddeus serve`). Being in its own group also means it no longer gets the
// terminal's Ctrl-C, so the parent forwards SIGINT and SIGTERM while any
// child is alive.
const liveGroups = new Set<number>();

function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // ESRCH: every process in the group has already exited.
  }
}

// Kills every live child group, then re-raises the signal with the default
// handler so the parent dies the way it would have without children.
function forwardSignal(signal: NodeJS.Signals): void {
  for (const pgid of liveGroups) killGroup(pgid);
  untrackSignals();
  process.kill(process.pid, signal);
}

const onSigint = () => forwardSignal('SIGINT');
const onSigterm = () => forwardSignal('SIGTERM');

function trackSignals(): void {
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
}

function untrackSignals(): void {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
}

// Reads a child's stdout line by line and hands each JSON object to `onLine`.
// Lines that are not JSON objects are a case's own logging and are skipped.
async function readJsonLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: Record<string, unknown>) => void
): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = '';
  const handle = (text: string) => {
    try {
      const value: unknown = JSON.parse(text);
      if (value !== null && typeof value === 'object') {
        onLine(value as Record<string, unknown>);
      }
    } catch {
      // Not JSON: the case printed something.
    }
  };
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      handle(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
  }
  buffered += decoder.decode();
  if (buffered.length > 0) handle(buffered);
}

// Spawns one child in its own process group and waits for it, killing the
// whole group with SIGKILL once `budgetMs` passes. Classifies the exit:
// our kill is `exceeded`; a SIGKILL we did not send (the kernel OOM killer)
// or an out-of-memory message is `oom`; any other failure is `error`. After
// the child exits the group is killed regardless, so a leftover grandchild
// can neither keep running nor hold the stdio pipes open.
async function spawnChild(
  req: ChildRequest,
  budgetMs: number
): Promise<ChildOutcome> {
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, CHILD, JSON.stringify(req)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // Read the environment at spawn time, not at parent startup.
    env: { ...process.env },
    detached: true,
  });
  if (liveGroups.size === 0) trackSignals();
  liveGroups.add(proc.pid);

  let phase: 'setup' | 'run' = 'setup';
  let report: ChildReport | undefined;
  const stdoutDone = readJsonLines(proc.stdout, (line) => {
    if (line.phase === 'setup' || line.phase === 'run') phase = line.phase;
    if (Array.isArray(line.samplesMs)) report = line as unknown as ChildReport;
  });
  const stderrDone = new Response(proc.stderr).arrayBuffer();

  let killedByBudget = false;
  const timer = setTimeout(() => {
    killedByBudget = true;
    killGroup(proc.pid);
  }, budgetMs);
  await proc.exited;
  clearTimeout(timer);
  killGroup(proc.pid);
  liveGroups.delete(proc.pid);
  if (liveGroups.size === 0) untrackSignals();

  await stdoutDone;
  const stderrBytes = new Uint8Array(await stderrDone);
  const stderr = new TextDecoder().decode(stderrBytes);
  const childRss = (proc.resourceUsage()?.maxRSS ?? 0) * 1024;
  const peakRssBytes = Math.max(report?.peakRssBytes ?? 0, childRss);

  let status: CaseStatus;
  if (killedByBudget) status = 'exceeded';
  else if (proc.exitCode === 0 && report !== undefined) status = 'ok';
  else if (proc.signalCode === 'SIGKILL' || OOM_STDERR.test(stderr))
    status = 'oom';
  else status = 'error';

  return {
    status,
    phase,
    ...(report !== undefined && { report }),
    stderr: new TextDecoder().decode(stderrBytes.subarray(-STDERR_TAIL_BYTES)),
    exitCode: proc.exitCode,
    peakRssBytes,
    elapsedMs: performance.now() - started,
  };
}

// The note stored with a failed case: where the budget or memory ran out, or
// for an error the end of the child's stderr.
function failureNote(
  outcome: ChildOutcome,
  budgetMs: number,
  n: number
): string {
  if (outcome.status === 'exceeded')
    return `exceeded ${budgetMs} ms at n = ${n}`;
  if (outcome.status === 'oom') return `oom at n = ${n}`;
  const tail = outcome.stderr.trim();
  if (tail.length > 0) return tail;
  return outcome.report === undefined
    ? `child exited with code ${outcome.exitCode} without a result`
    : `child exited with code ${outcome.exitCode}`;
}

// Converts the summed extra over the summed timed milliseconds into the one
// throughput a case reports. Bytes win over ops, ops over repos, because a
// case that counts bytes is a bandwidth case even if it also counts ops.
function throughputOf(
  extra: RunExtra,
  samplesMs: number[]
): CaseResult['throughput'] {
  const totalMs = samplesMs.reduce((a, b) => a + b, 0);
  if (totalMs <= 0) return undefined;
  const { bytes = 0, ops = 0, repos = 0 } = extra;
  if (bytes > 0)
    return { value: bytes / 1e6 / (totalMs / 1_000), unit: 'MB/s' };
  if (ops > 0) return { value: ops / (totalMs / 1_000), unit: 'ops/s' };
  if (repos > 0)
    return { value: repos / (totalMs / 60_000), unit: 'repos/min' };
  return undefined;
}

// The children one case needs: a single child doing warm-ups and repeats for
// `per-case`, or one child per warm-up and per repeat for `per-sample`.
// `timed: false` children are warm-ups whose samples are thrown away.
function childPlan(
  benchCase: BenchCase,
  opts: RunOptions
): { repeats: number; warmup: number; timed: boolean }[] {
  if (benchCase.isolation === 'per-case') {
    return [{ repeats: opts.repeats, warmup: opts.warmup, timed: true }];
  }
  return [
    ...Array.from({ length: opts.warmup }, () => ({
      repeats: 1,
      warmup: 0,
      timed: false,
    })),
    ...Array.from({ length: opts.repeats }, () => ({
      repeats: 1,
      warmup: 0,
      timed: true,
    })),
  ];
}

// Runs one case on one fixture in fresh Bun subprocesses and returns its
// result. A timeout, OOM or crash is a result, not an exception; only an
// unknown case id or fixture name throws.
export async function runCase(
  id: string,
  fixture: string,
  opts: RunOptions
): Promise<CaseResult> {
  const registry = resolve(opts.registry);
  const benchCase = await loadCase(registry, id);
  const spec = resolveFixture(fixture);
  const pageCache = opts.pageCache ?? 'warm';
  const base = {
    id,
    version: benchCase.version,
    suite: benchCase.suite,
    fixture,
    manifestHash: manifestHash(generateFixture(spec)),
    budgetMs: opts.budgetMs,
    repeats: opts.repeats,
    warmup: opts.warmup,
  };
  const flags = {
    ...(benchCase.writes === true && { durability: FILEBACKEND_DURABILITY }),
    ...(benchCase.cold === true && { pageCache }),
  };

  const samplesMs: number[] = [];
  const extra: RunExtra = {};
  let peakRssBytes = 0;
  let spentMs = 0;
  const perSample = benchCase.isolation === 'per-sample';
  for (const child of childPlan(benchCase, opts)) {
    if (perSample) await opts.beforeSample?.();
    const workDir = await mkdtemp(join(tmpdir(), 'thaddeus-bench-'));
    let outcome: ChildOutcome;
    try {
      outcome = await spawnChild(
        {
          registry,
          id,
          fixture,
          repeats: child.repeats,
          warmup: child.warmup,
          pageCache,
          workDir,
          ...(opts.durationMs !== undefined && { durationMs: opts.durationMs }),
        },
        Math.max(0, opts.budgetMs - spentMs)
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
    spentMs += outcome.elapsedMs;
    peakRssBytes = Math.max(peakRssBytes, outcome.peakRssBytes);
    if (outcome.status !== 'ok') {
      return {
        ...base,
        status: outcome.status,
        phase: outcome.phase,
        ...(outcome.status !== 'error' && { failedAtN: spec.ops }),
        samplesMs: [],
        ...summarize([]),
        peakRssBytes,
        ...flags,
        note: failureNote(outcome, opts.budgetMs, spec.ops),
      };
    }
    if (child.timed && outcome.report !== undefined) {
      samplesMs.push(...outcome.report.samplesMs);
      addExtra(extra, outcome.report.extra);
    }
  }

  const throughput = throughputOf(extra, samplesMs);
  return {
    ...base,
    status: 'ok',
    samplesMs,
    ...summarize(samplesMs),
    ...(throughput !== undefined && { throughput }),
    peakRssBytes,
    ...flags,
  };
}

// Runs a case at each history length in `sizes` (fixture `sweep-<n>`) and
// fits t = c * n^exponent over the median times. Stops at the first size that
// does not come back ok and records it as `failedAtN`, because a larger size
// would only fail the same way more slowly.
export async function runSweep(
  id: string,
  sizes: readonly number[],
  opts: RunOptions
): Promise<SweepResult> {
  const benchCase = await loadCase(resolve(opts.registry), id);
  const points: { n: number; p50Ms: number }[] = [];
  let status: CaseStatus = 'ok';
  let failedAtN: number | undefined;
  for (const n of sizes) {
    const result = await runCase(id, sweepSpec(n).name, opts);
    if (result.status !== 'ok') {
      status = result.status;
      failedAtN = n;
      break;
    }
    if (result.p50Ms !== null) points.push({ n, p50Ms: result.p50Ms });
  }
  // A median of exactly 0 ms has no logarithm; fit over the rest.
  const fit = fitExponent(
    points.filter((p) => p.p50Ms > 0).map((p) => ({ n: p.n, t: p.p50Ms }))
  );
  return {
    id,
    version: benchCase.version,
    points,
    exponent: fit?.exponent ?? null,
    r2: fit?.r2 ?? null,
    status,
    ...(failedAtN !== undefined && { failedAtN }),
  };
}
