import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addExtra, type BenchCase, loadCase, type RunExtra } from './case';
import type { ChildReport, ChildRequest } from './child';
import { WORK_ROOT } from './fixtures/cache';
import { generateFixture, manifestHash } from './fixtures/plan';
import { type FixtureSpec, resolveFixture, sweepSpec } from './fixtures/spec';
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

// How long the parent keeps reading a child's stdout and stderr after the
// child exits. A grandchild outside the child's process group can hold the
// pipes open forever; past this limit the parent stops reading.
const DRAIN_AFTER_EXIT_MS = 2_000;

// Thrown by `runCase` when the parent received SIGINT, SIGTERM or SIGHUP while
// a child was running. An interrupted case was not measured, so it is not a
// result: nothing is recorded and the caller decides whether to stop.
export class Interrupted extends Error {
  constructor(readonly signal: NodeJS.Signals) {
    super(`interrupted by ${signal}`);
    this.name = 'Interrupted';
  }
}

// Process groups of children that are still running. A child runs in its own
// group so a budget kill also takes down whatever it started (an e2e case's
// `thaddeus serve`). Being in its own group also means it no longer gets the
// terminal's Ctrl-C or the SSH hangup, so while any child is alive the parent
// forwards those signals and kills the groups on exit.
const liveGroups = new Set<number>();

// The signal that made `forwardSignal` kill a group, keyed by group id, so the
// waiting `spawnChild` can tell an interruption from a kernel OOM kill.
const interruptedBy = new Map<number, NodeJS.Signals>();

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // ESRCH: every process in the group has already exited.
  }
}

function killLiveGroups(): void {
  for (const pgid of liveGroups) killGroup(pgid);
}

// Kills every live child group and marks it interrupted. If nobody else
// listens for the signal, re-raises it so the parent dies the way it would
// have without children; if someone does (a CLI cleaning up), they already
// got this delivery and decide what happens next.
function forwardSignal(signal: NodeJS.Signals): void {
  for (const pgid of liveGroups) interruptedBy.set(pgid, signal);
  killLiveGroups();
  untrackSignals();
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

const signalHandlers = FORWARDED_SIGNALS.map(
  (signal) => [signal, () => forwardSignal(signal)] as const
);

function trackSignals(): void {
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  process.on('exit', killLiveGroups);
}

function untrackSignals(): void {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  process.off('exit', killLiveGroups);
}

// Reads a stream chunk by chunk until it ends or `cancel` is called, so the
// caller can stop waiting on a pipe that a stray process keeps open.
function drain(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void
): { done: Promise<void>; cancel: () => void } {
  const reader = stream.getReader();
  const done = (async () => {
    for (;;) {
      const { done: ended, value } = await reader.read();
      if (ended) return;
      onChunk(value);
    }
  })();
  return {
    done: done.catch(() => {}),
    cancel: () => void reader.cancel().catch(() => {}),
  };
}

// Splits a byte stream into lines and hands each JSON object to `onLine`.
// Lines that are not JSON objects are a case's own logging and are skipped.
function jsonLineParser(onLine: (line: Record<string, unknown>) => void): {
  push: (chunk: Uint8Array) => void;
  end: () => void;
} {
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
  return {
    push: (chunk) => {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        handle(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    },
    end: () => {
      buffered += decoder.decode();
      if (buffered.length > 0) handle(buffered);
      buffered = '';
    },
  };
}

// What a budgeted child process did, before it is classified.
export interface SpawnOutcome {
  /** The budget ran out and the parent killed the child's group. */
  killedByBudget: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  /** The last STDERR_TAIL_BYTES of stderr. */
  stderrTail: string;
  /** Whether the full stderr looked like an out-of-memory death. */
  oomMessage: boolean;
  /** The child's own peak RSS, from the kernel's resource usage. */
  maxRssBytes: number;
  elapsedMs: number;
}

// Spawns `argv` in its own process group and waits for it, killing the whole
// group with SIGKILL once `budgetMs` passes. After the child exits the group
// is killed regardless, so a leftover grandchild cannot keep running, and the
// pipes are read for at most DRAIN_AFTER_EXIT_MS more. Stdout goes to
// `onStdout`. A kill from signal forwarding throws `Interrupted`. Used for
// case children and for fixture pre-builds, which need the same budget,
// cleanup and interrupt handling.
export async function spawnBudgeted(
  argv: string[],
  budgetMs: number,
  onStdout: (chunk: Uint8Array) => void = () => {}
): Promise<SpawnOutcome> {
  const started = performance.now();
  const proc = Bun.spawn(argv, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // Read the environment at spawn time, not at parent startup.
    env: { ...process.env },
    detached: true,
  });
  if (liveGroups.size === 0) trackSignals();
  liveGroups.add(proc.pid);

  const stdout = drain(proc.stdout, onStdout);
  const stderrChunks: Uint8Array[] = [];
  const stderrDrain = drain(proc.stderr, (chunk) => stderrChunks.push(chunk));

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

  let drainTimer: Timer | undefined;
  await Promise.race([
    Promise.all([stdout.done, stderrDrain.done]),
    new Promise((resolve) => {
      drainTimer = setTimeout(resolve, DRAIN_AFTER_EXIT_MS);
    }),
  ]);
  clearTimeout(drainTimer);
  stdout.cancel();
  stderrDrain.cancel();

  const signal = interruptedBy.get(proc.pid);
  interruptedBy.delete(proc.pid);
  if (signal !== undefined) throw new Interrupted(signal);

  const stderrBytes = Buffer.concat(stderrChunks);
  return {
    killedByBudget,
    exitCode: proc.exitCode,
    signalCode: proc.signalCode,
    stderrTail: stderrBytes.subarray(-STDERR_TAIL_BYTES).toString('utf8'),
    oomMessage: OOM_STDERR.test(stderrBytes.toString('utf8')),
    maxRssBytes: (proc.resourceUsage()?.maxRSS ?? 0) * 1024,
    elapsedMs: performance.now() - started,
  };
}

// Whether any budgeted child is running right now. While one is, the runner
// owns SIGINT, SIGTERM and SIGHUP: it kills the child and rejects with
// `Interrupted`, so a CLI should let that happen instead of exiting itself.
export function childrenRunning(): boolean {
  return liveGroups.size > 0;
}

// Classifies a budgeted child's exit: our kill is `exceeded`; a clean exit
// that `succeeded` is `ok`; a SIGKILL we did not send (the kernel OOM killer)
// or an out-of-memory message is `oom`; any other failure is `error`.
export function classify(
  outcome: SpawnOutcome,
  succeeded: boolean
): CaseStatus {
  if (outcome.killedByBudget) return 'exceeded';
  if (outcome.exitCode === 0 && succeeded) return 'ok';
  if (outcome.signalCode === 'SIGKILL' || outcome.oomMessage) return 'oom';
  return 'error';
}

// Runs one case child (see `spawnBudgeted`) and reads its phase
// announcements and final report from stdout.
async function spawnChild(
  req: ChildRequest,
  budgetMs: number
): Promise<ChildOutcome> {
  let phase: 'setup' | 'run' = 'setup';
  let report: ChildReport | undefined;
  const lines = jsonLineParser((line) => {
    if (line.phase === 'setup' || line.phase === 'run') phase = line.phase;
    if (Array.isArray(line.samplesMs)) report = line as unknown as ChildReport;
  });
  const outcome = await spawnBudgeted(
    [process.execPath, CHILD, JSON.stringify(req)],
    budgetMs,
    lines.push
  );
  lines.end();
  return {
    status: classify(outcome, report !== undefined),
    phase,
    ...(report !== undefined && { report }),
    stderr: outcome.stderrTail,
    exitCode: outcome.exitCode,
    peakRssBytes: Math.max(report?.peakRssBytes ?? 0, outcome.maxRssBytes),
    elapsedMs: outcome.elapsedMs,
  };
}

// The note stored with a failed case: where the budget or memory ran out, or
// for an error the end of the child's stderr.
export function failureNote(
  failure: {
    status: CaseStatus;
    stderr: string;
    exitCode: number | null;
    reported: boolean;
  },
  budgetMs: number,
  n: number
): string {
  if (failure.status === 'exceeded')
    return `exceeded ${budgetMs} ms at n = ${n}`;
  if (failure.status === 'oom') return `oom at n = ${n}`;
  const tail = failure.stderr.trim();
  if (tail.length > 0) return tail;
  return failure.reported
    ? `child exited with code ${failure.exitCode}`
    : `child exited with code ${failure.exitCode} without a result`;
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

// The fields every result of `benchCase` on `fixture` carries, whatever its
// status: identity, method, and the durability and page-cache labels.
function resultFrame(
  benchCase: BenchCase,
  fixture: string,
  spec: FixtureSpec,
  opts: RunOptions
) {
  return {
    base: {
      id: benchCase.id,
      version: benchCase.version,
      suite: benchCase.suite,
      fixture,
      manifestHash: manifestHash(generateFixture(spec)),
      budgetMs: opts.budgetMs,
      repeats: opts.repeats,
      warmup: opts.warmup,
    },
    flags: {
      ...(benchCase.writes === true && { durability: FILEBACKEND_DURABILITY }),
      ...(benchCase.cold === true && { pageCache: opts.pageCache ?? 'warm' }),
    },
  };
}

// The result of a case that never got to run because something the parent
// does first failed: a fixture pre-build or a page-cache drop. It carries
// the same identity and labels as a `runCase` result, `phase: "setup"`, no
// samples, and `note`. Nothing is spawned.
export async function setupFailure(
  id: string,
  fixture: string,
  opts: RunOptions,
  failure: { status: Exclude<CaseStatus, 'ok'>; note: string }
): Promise<CaseResult> {
  const benchCase = await loadCase(resolve(opts.registry), id);
  const spec = resolveFixture(fixture);
  const { base, flags } = resultFrame(benchCase, fixture, spec, opts);
  return {
    ...base,
    status: failure.status,
    phase: 'setup',
    ...(failure.status !== 'error' && { failedAtN: spec.ops }),
    samplesMs: [],
    ...summarize([]),
    peakRssBytes: 0,
    ...flags,
    note: failure.note,
  };
}

// Runs one case on one fixture in fresh Bun subprocesses and returns its
// result. A timeout, OOM or crash is a result, not an exception. It throws
// on an unknown case id or fixture name, and rejects with `Interrupted` when
// the parent gets SIGINT, SIGTERM or SIGHUP mid-case.
export async function runCase(
  id: string,
  fixture: string,
  opts: RunOptions
): Promise<CaseResult> {
  const registry = resolve(opts.registry);
  const benchCase = await loadCase(registry, id);
  const spec = resolveFixture(fixture);
  const pageCache = opts.pageCache ?? 'warm';
  const { base, flags } = resultFrame(benchCase, fixture, spec, opts);

  const samplesMs: number[] = [];
  const extra: RunExtra = {};
  let peakRssBytes = 0;
  // Max over children: per-sample children each measure their own copy.
  let diskBytes: number | undefined;
  let spentMs = 0;
  const perSample = benchCase.isolation === 'per-sample';
  for (const child of childPlan(benchCase, opts)) {
    if (perSample) await opts.beforeSample?.();
    await mkdir(WORK_ROOT, { recursive: true });
    const workDir = await mkdtemp(join(WORK_ROOT, 'case-'));
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
    const measured = outcome.report?.diskBytes;
    if (measured !== undefined) diskBytes = Math.max(diskBytes ?? 0, measured);
    if (outcome.status !== 'ok') {
      return {
        ...base,
        status: outcome.status,
        phase: outcome.phase,
        ...(outcome.status !== 'error' && { failedAtN: spec.ops }),
        samplesMs: [],
        ...summarize([]),
        peakRssBytes,
        ...(diskBytes !== undefined && { diskBytes }),
        ...flags,
        note: failureNote(
          { ...outcome, reported: outcome.report !== undefined },
          opts.budgetMs,
          spec.ops
        ),
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
    ...(diskBytes !== undefined && { diskBytes }),
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
