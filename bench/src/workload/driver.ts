import { blake3 } from '@noble/hashes/blake3';
import { Identity, ready } from '@thaddeus.run/identity';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { type CliOutcome, runCli, writeCliHome } from '../e2e/home';
import { type RunningServe, startServe } from '../e2e/serve';
import { createPrng } from '../prng';
import { percentile } from '../stats';
import { Ledger } from './ledger';
import { type FaultProxy, startProxy } from './proxy';
import {
  ACTION_KINDS,
  type ActionKind,
  type ActionSummary,
  type AttemptOutcome,
  type Check,
  type Coverage,
  type Percentiles,
  type WorkloadResult,
} from './result';
import {
  agentDir,
  fileContent,
  type FileEdit,
  probePath,
  type Schedule,
  type Step,
} from './schedule';

// Runs one workload schedule: the real `thaddeus` CLI as many agents against
// a real `thaddeus serve`, through the fault proxy, with the scheduled faults.
// Every agent is a sequence of CLI commands in its own working copy; agents
// run at once. In the hot shape an owner lands each agent's saves through an
// integration queue. After the last agent finishes, the server is killed and
// restarted once more, and fresh clones are checked against what the server
// acknowledged.

// Attempts per action before the agent gives up on it.
const MAX_ATTEMPTS = 5;
// Back-off before attempt n + 1 is n times this.
const RETRY_BACKOFF_MS = 250;
// A CLI command still running after this is killed and counts as failed.
const COMMAND_TIMEOUT_MS = 60_000;
// How long a killed server stays down before it restarts.
const DOWN_MS = 300;
// How long a storage fault keeps the chosen shards read-only.
const STORAGE_HOLD_MS = 1_500;
// The share of existing record shards a storage fault makes read-only.
const STORAGE_SHARD_SHARE = 0.25;
// After a fault ends, failures within this window still count as faults:
// a command that started against the old server can fail after the restart.
const FAULT_GRACE_MS = 1_000;
// How often the server's resident memory is sampled.
const RSS_SAMPLE_MS = 250;
// How many failed attempts the result keeps the output of.
const MAX_ERRORS = 20;
const ERROR_OUTPUT_CHARS = 600;
// How much of a failure's last output line the failure counts keep.
const FAILURE_MESSAGE_CHARS = 160;

// The queries every agent runs: everything touched since the fixture epoch.
const QUERY_SINCE = '2026-01-01';

// What the workload drives for each action THA-118 names. Checkpoints and
// build requests are not in the shipped CLI; structured edits (`rename`)
// are, but this version does not drive them.
export const COVERAGE: Coverage[] = [
  {
    action: 'saves',
    status: 'covered',
    how: '`push` from the agent working copy; in the hot shape it uploads and the owner publishes by landing',
  },
  {
    action: 'checkpoints',
    status: 'not shipped',
    how: 'the CLI has no named checkpoint yet',
  },
  {
    action: 'file edits',
    status: 'covered',
    how: 'each save adds or rewrites one to three files in the agent directory',
  },
  {
    action: 'structured edits',
    status: 'not covered',
    how: '`thaddeus rename` exists but the workload does not drive it yet',
  },
  {
    action: 'queries',
    status: 'covered',
    how: '`query touched-since` in the agent working copy',
  },
  {
    action: 'synchronization',
    status: 'covered',
    how: '`pull` at the start of a round, `clone` for new and recovered working copies',
  },
  {
    action: 'build requests',
    status: 'not shipped',
    how: 'the CLI has no build request yet',
  },
  {
    action: 'integration',
    status: 'covered',
    how: 'the owner runs `land` from the agent working copy (hot shape)',
  },
];

// One timed CLI attempt.
interface Attempt {
  kind: ActionKind;
  agent: number;
  start: number;
  end: number;
  ms: number;
  outcome: AttemptOutcome;
  measured: boolean;
  output: string;
}

// How an attempt's answer is judged: `ok`, `retry` (worth trying again) or
// `refused` (a definite answer that a retry will not change).
type Verdict = 'ok' | 'retry' | 'refused';

interface Actor {
  label: string;
  home: string;
  did: string;
}

interface AgentState {
  index: number;
  actor: Actor;
  repo: string;
  dir: string;
  /** Saved (uploaded) but not yet landed edits, hot shape. */
  unlanded: FileEdit[];
  /**
   * Set when a land from this copy said to re-clone: main moved while it
   * landed, and the CLI cannot pull this copy forward.
   */
  needsReclone: boolean;
}

export interface DriveOptions {
  schedule: Schedule;
  cli: string[];
  /** An empty directory the run owns. */
  workDir: string;
  log: (line: string) => void;
}

// The parts of a result the driver measures; the caller adds the commit,
// machine and timestamp.
export type DriveOutput = Omit<
  WorkloadResult,
  | 'schemaVersion'
  | 'workloadVersion'
  | 'commit'
  | 'dirty'
  | 'recordedAt'
  | 'machine'
  | 'cli'
  | 'durability'
>;

// A deterministic identity seed per actor label, so a replayed schedule
// signs as the same identities.
function actorSeed(seed: number, label: string): Uint8Array {
  return blake3(
    new TextEncoder().encode(`thaddeus-bench/workload/${seed}/${label}`)
  );
}

// Every file of a working copy except its metadata, as path -> content.
function readTree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.thaddeus') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        files.set(relative(root, path), readFileSync(path, 'utf8'));
      }
    }
  };
  walk(root);
  return files;
}

// Total bytes of the regular files under `root`. A directory it cannot read
// counts as empty rather than failing the run after its checks.
function diskBytes(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) total += statSync(path).size;
    }
  };
  if (existsSync(root)) walk(root);
  return total;
}

// The resident memory of a process from /proc, or null off Linux or once
// the process is gone.
function rssBytes(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match === null ? null : Number(match[1]) * 1024;
  } catch {
    return null;
  }
}

function writeEdit(dir: string, edit: { path: string; token: number }) {
  const path = join(dir, edit.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, fileContent(edit.path, edit.token));
}

// How many items share each key.
function countBy<T>(items: readonly T[], key: (item: T) => string) {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

function percentiles(samples: number[]): Percentiles {
  if (samples.length === 0) {
    return { samples: 0, p50Ms: null, p95Ms: null, maxMs: null };
  }
  return {
    samples: samples.length,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    maxMs: Math.max(...samples),
  };
}

// A first-in, first-out semaphore: the integration queue.
class Queue {
  #free: number;
  readonly #waiting: (() => void)[] = [];

  constructor(slots: number) {
    this.#free = slots;
  }

  async acquire(): Promise<void> {
    if (this.#free > 0) {
      this.#free--;
      return;
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }

  release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) this.#free++;
    else next();
  }
}

export async function drive(opts: DriveOptions): Promise<DriveOutput> {
  const { schedule, cli, workDir, log } = opts;
  const { config } = schedule;
  await ready();

  const root = join(workDir, 'server');
  const serveFlags = [
    '--repository-creation-limit',
    '1000000',
    '--max-repositories',
    '1000000',
  ];
  let serve: RunningServe = await startServe({ cli, root, flags: serveFlags });
  let restarts = 0;
  const proxy: FaultProxy = startProxy(
    (config.seed ^ 0x9e3779b9) >>> 0,
    schedule.requests
  );
  proxy.setUpstream(serve.url);

  const rss: number[] = [];
  const sampler = setInterval(() => {
    const bytes = rssBytes(serve.pid);
    if (bytes !== null) rss.push(bytes);
  }, RSS_SAMPLE_MS);

  // Fault events run one at a time on this chain (see actionFinished).
  let faultChain: Promise<void> = Promise.resolve();
  // Whatever happens below, the sampler, the server and the proxy stop, so
  // a run that throws never leaves a `thaddeus serve` behind.
  try {
    const attempts: Attempt[] = [];
    const queueWaits: number[] = [];
    // Fault windows, [from, to]; `to` is Infinity while the fault lasts.
    const windows: { from: number; to: number }[] = [];
    const kills: { t0: number; ready: number; restartMs: number }[] = [];
    const storage: {
      from: number;
      to: number;
      shards: number;
      skipped?: string;
    }[] = [];
    const ledger = new Ledger();
    const checks = {
      authority: { checked: 0, violations: [] as string[] },
      tenantIsolation: { checked: 0, violations: [] as string[] },
    };

    const homes = join(workDir, 'homes');
    const actor = (label: string): Actor => {
      const seed = actorSeed(config.seed, label);
      const home = join(homes, label);
      writeCliHome(home, seed);
      return { label, home, did: Identity.fromSeed(seed).did };
    };

    const faultDuring = (start: number, end: number): boolean =>
      windows.some((w) => start <= w.to + FAULT_GRACE_MS && end >= w.from);

    // Fault events fire in order as measured actions finish. They run one at a
    // time on this chain, never blocking the agent that crossed the threshold.
    let measuredDone = 0;
    let nextEvent = 0;
    const faultPrng = createPrng((config.seed ^ 0x51ab1e) >>> 0);

    const killServer = async (): Promise<void> => {
      const t0 = performance.now();
      const window = { from: t0, to: Number.POSITIVE_INFINITY };
      windows.push(window);
      proxy.setUpstream(null);
      await serve.kill();
      await Bun.sleep(DOWN_MS);
      serve = await startServe({
        cli,
        root,
        flags: serveFlags,
        port: serve.port,
      });
      restarts++;
      proxy.setUpstream(serve.url);
      const readyAt = performance.now();
      window.to = readyAt;
      kills.push({ t0, ready: readyAt, restartMs: readyAt - t0 });
      log(
        `workload: killed and restarted the server in ${Math.round(readyAt - t0)} ms`
      );
    };

    const storageFault = async (): Promise<void> => {
      const from = performance.now();
      if (process.getuid?.() === 0) {
        storage.push({
          from,
          to: from,
          shards: 0,
          skipped: 'running as root, so directory permissions do not bind',
        });
        return;
      }
      const shardsDir = join(root, '.records-v1');
      const all = existsSync(shardsDir)
        ? readdirSync(shardsDir)
            .filter((name) => /^[0-9a-f]{2}$/.test(name))
            .sort()
        : [];
      const want = Math.max(1, Math.floor(all.length * STORAGE_SHARD_SHARE));
      const chosen = new Set<string>();
      while (chosen.size < Math.min(want, all.length)) {
        chosen.add(all[faultPrng.int(all.length)]);
      }
      const modes = new Map<string, number>();
      const window = { from, to: Number.POSITIVE_INFINITY };
      windows.push(window);
      for (const name of chosen) {
        const path = join(shardsDir, name);
        modes.set(path, statSync(path).mode & 0o7777);
        chmodSync(path, 0o555);
      }
      await Bun.sleep(STORAGE_HOLD_MS);
      for (const [path, mode] of modes) chmodSync(path, mode);
      window.to = performance.now();
      storage.push({ from, to: window.to, shards: chosen.size });
      log(
        `workload: made ${chosen.size} of ${all.length} record shards read-only for ${STORAGE_HOLD_MS} ms`
      );
    };

    const actionFinished = (measured: boolean): void => {
      if (!measured) return;
      measuredDone++;
      while (
        nextEvent < schedule.events.length &&
        schedule.events[nextEvent].afterActions <= measuredDone
      ) {
        const event = schedule.events[nextEvent++];
        faultChain = faultChain.then(
          event.kind === 'kill' ? killServer : storageFault
        );
      }
    };

    // Runs one action with retries and records every attempt. `judge` decides
    // each answer; `beforeRetry` can repair state between attempts.
    const act = async (
      kind: ActionKind,
      agent: number,
      measured: boolean,
      run: () => Promise<CliOutcome>,
      judge: (o: CliOutcome) => Verdict
    ): Promise<{ ok: boolean; last: CliOutcome }> => {
      let last: CliOutcome = { code: -1, output: '', ms: 0 };
      let ok = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const start = performance.now();
        last = await run();
        const end = performance.now();
        const verdict = judge(last);
        ok = verdict === 'ok';
        const outcome: AttemptOutcome = ok
          ? 'ok'
          : faultDuring(start, end)
            ? 'fault'
            : 'error';
        attempts.push({
          kind,
          agent,
          start,
          end,
          ms: last.ms,
          outcome,
          measured,
          output: last.output,
        });
        if (ok || verdict === 'refused') break;
        await Bun.sleep(RETRY_BACKOFF_MS * attempt);
      }
      actionFinished(measured);
      return { ok, last };
    };

    const cliAs = (a: Actor, cwd: string, args: string[]) =>
      runCli(cli, args, { home: a.home, cwd, timeoutMs: COMMAND_TIMEOUT_MS });

    // A fresh working copy of `repo` for `a` in a new directory.
    let cloneSeq = 0;
    const cloneAs = async (
      a: Actor,
      agent: number,
      repo: string,
      measured: boolean,
      server = proxy.url
    ): Promise<string | null> => {
      const dir = join(workDir, 'copies', `${a.label}-${cloneSeq++}`);
      mkdirSync(dirname(dir), { recursive: true });
      let target = dir;
      let n = 0;
      const { ok } = await act(
        'clone',
        agent,
        measured,
        () => {
          // A failed clone can leave a partial directory; retry into a new one.
          target = n++ === 0 ? dir : `${dir}-r${n}`;
          return cliAs(a, dirname(dir), [
            'clone',
            repo,
            target,
            '--server',
            server,
          ]);
        },
        (o) => (o.code === 0 ? 'ok' : 'retry')
      );
      return ok ? target : null;
    };

    // --- Setup, untimed: identities, repositories, grants, first clones.
    const hot = config.shape === 'hot';
    const owner = hot ? actor('owner') : null;
    const outsider = hot ? actor('outsider') : null;
    const repoOf = (agent: number): string =>
      hot ? 'bench/hot' : `bench/t${agent}`;
    const agents: AgentState[] = [];

    const initRepo = async (a: Actor, repo: string): Promise<string> => {
      const dir = join(workDir, 'copies', `${a.label}-init`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'README.md'), `# ${repo}\n`);
      const steps: string[][] = [
        ['init', repo, '--server', proxy.url],
        ['push', '-m', 'initial import'],
      ];
      for (const args of steps) {
        const o = await cliAs(a, dir, args);
        if (o.code !== 0) {
          throw new Error(
            `workload setup: thaddeus ${args.join(' ')} exited ${o.code}: ${o.output.trim()}`
          );
        }
      }
      return dir;
    };

    let ownerDir = '';
    if (hot && owner !== null) {
      ownerDir = await initRepo(owner, 'bench/hot');
    }
    for (let i = 0; i < config.agents; i++) {
      const a = actor(`a${i}`);
      if (hot && owner !== null) {
        const o = await cliAs(owner, ownerDir, [
          'grant',
          a.did,
          '--paths',
          `${agentDir(i)}/**`,
        ]);
        if (o.code !== 0) {
          throw new Error(
            `workload setup: grant to a${i} exited ${o.code}: ${o.output.trim()}`
          );
        }
        agents.push({
          index: i,
          actor: a,
          repo: 'bench/hot',
          dir: '',
          unlanded: [],
          needsReclone: false,
        });
      } else {
        const dir = await initRepo(a, repoOf(i));
        agents.push({
          index: i,
          actor: a,
          repo: repoOf(i),
          dir,
          unlanded: [],
          needsReclone: false,
        });
      }
    }
    if (hot) {
      for (const state of agents) {
        const dir = await cloneAs(state.actor, state.index, state.repo, false);
        if (dir === null)
          throw new Error(`workload setup: a${state.index} could not clone`);
        state.dir = dir;
      }
    }
    log(
      `workload: set up ${config.agents} agent(s), ${config.shape} shape; running ${config.rounds} round(s)`
    );

    // --- The run.
    const queue = new Queue(config.integrators);

    // Gives an agent a fresh working copy after its own went bad. Edits it had
    // not landed stay attempted but unacknowledged.
    const recover = async (state: AgentState, measured: boolean) => {
      const dir = await cloneAs(state.actor, state.index, state.repo, measured);
      if (dir !== null) {
        state.dir = dir;
        state.unlanded = [];
        state.needsReclone = false;
      }
    };

    const landJudge = (o: CliOutcome): Verdict => {
      if (o.code === 0 && /\b(landed|published)\b/.test(o.output)) return 'ok';
      if (/not landed:/.test(o.output)) return 'refused';
      return 'retry';
    };

    const integrate = async (state: AgentState, measured: boolean) => {
      // Nothing to land when the round's save failed and the agent re-cloned.
      if (owner === null || state.unlanded.length === 0) return;
      const enqueued = performance.now();
      await queue.acquire();
      if (measured) queueWaits.push(performance.now() - enqueued);
      try {
        const pending = [...state.unlanded];
        const { ok, last } = await act(
          'land',
          state.index,
          measured,
          () => cliAs(owner, state.dir, ['land']),
          landJudge
        );
        if (ok) {
          ledger.ack(state.repo, pending);
          state.unlanded = state.unlanded.slice(pending.length);
          if (/re-clone/.test(last.output)) state.needsReclone = true;
        }
      } finally {
        queue.release();
      }
    };

    const runStep = async (
      state: AgentState,
      step: Step,
      round: number,
      measured: boolean
    ): Promise<void> => {
      const a = state.actor;
      const i = state.index;
      switch (step.kind) {
        case 'sync': {
          // Following the CLI's own instruction after a land that raced.
          if (state.needsReclone) {
            await recover(state, measured);
            return;
          }
          const { ok } = await act(
            'pull',
            i,
            measured,
            () => cliAs(a, state.dir, ['pull']),
            (o) =>
              o.code === 0
                ? 'ok'
                : /uncommitted|unpublished|not published|re-clone|diverge/i.test(
                      o.output
                    )
                  ? 'refused'
                  : 'retry'
          );
          if (!ok) await recover(state, measured);
          return;
        }
        case 'save': {
          for (const edit of step.edits) writeEdit(state.dir, edit);
          ledger.attempt(state.repo, step.edits);
          const { ok } = await act(
            'save',
            i,
            measured,
            () => cliAs(a, state.dir, ['push', '-m', `a${i} round ${round}`]),
            hot
              ? (o) =>
                  o.code === 1 &&
                  /owner signature required/.test(o.output) &&
                  /uploaded \d+ op/.test(o.output)
                    ? 'ok'
                    : 'retry'
              : (o) =>
                  o.code === 0 && /published/.test(o.output) ? 'ok' : 'retry'
          );
          if (ok && hot) state.unlanded.push(...step.edits);
          else if (ok) ledger.ack(state.repo, step.edits);
          else await recover(state, measured);
          return;
        }
        case 'integrate':
          await integrate(state, measured);
          return;
        case 'query':
          await act(
            'query',
            i,
            measured,
            () => cliAs(a, state.dir, ['query', 'touched-since', QUERY_SINCE]),
            (o) => (o.code === 0 ? 'ok' : 'retry')
          );
          return;
        case 'probe-scope': {
          if (owner === null) return;
          const dir = await cloneAs(a, i, state.repo, measured);
          if (dir === null) return;
          const path = probePath(i, step.token);
          writeEdit(dir, { path, token: step.token });
          ledger.forbid(state.repo, path);
          const pushed = await act(
            'probe-scope',
            i,
            measured,
            () => cliAs(a, dir, ['push', '-m', `a${i} out of scope`]),
            (o) => (/uploaded \d+ op/.test(o.output) ? 'ok' : 'retry')
          );
          if (!pushed.ok) return;
          const landed = await act(
            'probe-scope',
            i,
            measured,
            () => cliAs(owner, dir, ['land']),
            (o) =>
              o.code !== 0 && /delegated scope/.test(o.output)
                ? 'ok'
                : o.code === 0
                  ? 'refused'
                  : 'retry'
          );
          // Only a definite answer counts; a land that kept failing for
          // another reason checked nothing.
          if (landed.ok || landed.last.code === 0) checks.authority.checked++;
          if (landed.last.code === 0) {
            checks.authority.violations.push(
              `land of ${path}, outside a${i}'s delegated scope, was accepted`
            );
          }
          return;
        }
        case 'probe-tenant': {
          const intruder = step.target === -1 ? outsider : a;
          const target = step.target === -1 ? 'bench/hot' : repoOf(step.target);
          if (intruder === null) return;
          const dir = await cloneAs(intruder, i, target, measured);
          if (dir === null) return;
          checks.tenantIsolation.checked++;
          const visible = [...readTree(dir).keys()];
          if (visible.length > 0) {
            checks.tenantIsolation.violations.push(
              `${intruder.label} can read ${visible.length} file(s) of ${target} without a grant, e.g. ${visible[0]}`
            );
          }
          const owned = step.target === -1 ? i : step.target;
          const path = `${agentDir(owned)}/intruder-${intruder.label}-${round}.ts`;
          writeEdit(dir, { path, token: round });
          ledger.forbid(target, path);
          const pushed = await act(
            'probe-tenant',
            i,
            measured,
            () => cliAs(intruder, dir, ['push', '-m', 'intruder']),
            (o) =>
              o.code !== 0 && /not authorized/.test(o.output)
                ? 'ok'
                : o.code === 0 || /published/.test(o.output)
                  ? 'refused'
                  : 'retry'
          );
          const accepted =
            pushed.last.code === 0 || /published/.test(pushed.last.output);
          // The clone's read check above always counts; the push counts only
          // with a definite answer.
          if (pushed.ok || accepted) checks.tenantIsolation.checked++;
          if (accepted) {
            checks.tenantIsolation.violations.push(
              `${intruder.label}'s push to ${target} without a grant was accepted`
            );
          }
          return;
        }
      }
    };

    const runAgent = async (state: AgentState): Promise<void> => {
      const plan = schedule.agents[state.index];
      for (let round = 0; round < plan.rounds.length; round++) {
        const measured = round >= schedule.warmupRounds;
        for (const step of plan.rounds[round]) {
          await runStep(state, step, round, measured);
        }
      }
    };

    const runStart = performance.now();
    await Promise.all(agents.map(runAgent));
    await faultChain;
    await proxy.settle();
    const runEnd = performance.now();

    // --- Verification: one more crash, then fresh clones straight from the
    // server, without the proxy's request faults.
    await serve.kill();
    serve = await startServe({
      cli,
      root,
      flags: serveFlags,
      port: serve.port,
    });
    restarts++;
    proxy.setUpstream(serve.url);

    const durability: Check = { checked: 0, violations: [] };
    const checkRepo = async (a: Actor, agent: number, repo: string) => {
      const dir = await cloneAs(a, agent, repo, false, serve.url);
      if (dir === null) {
        durability.violations.push(
          `${repo}: the owner could not clone main after the restart`
        );
        return;
      }
      const result = ledger.check(repo, readTree(dir));
      durability.checked += result.checked;
      durability.violations.push(...result.violations);
    };
    if (hot && owner !== null) await checkRepo(owner, 0, 'bench/hot');
    else
      for (const state of agents)
        await checkRepo(state.actor, state.index, state.repo);

    const duplicates = proxy.stats().duplicates;
    const answered = duplicates.filter((d) => d.status !== null);
    const revisionBound: Check = {
      checked: answered.length,
      violations: answered
        .filter((d) => d.status !== null && d.status >= 200 && d.status < 300)
        .map(
          (d) => `replayed ${d.method} ${d.path} was accepted (${d.status})`
        ),
    };

    const disk = diskBytes(root);
    const net = proxy.stats();

    // --- Summaries over the measured attempts.
    const measured = attempts.filter((t) => t.measured);
    const actions: ActionSummary[] = [];
    for (const kind of ACTION_KINDS) {
      const of = measured.filter((t) => t.kind === kind);
      if (of.length === 0) continue;
      const okMs = of.filter((t) => t.outcome === 'ok').map((t) => t.ms);
      const at = (p: number) =>
        okMs.length === 0 ? null : percentile(okMs, p);
      actions.push({
        kind,
        attempts: of.length,
        ok: okMs.length,
        fault: of.filter((t) => t.outcome === 'fault').length,
        error: of.filter((t) => t.outcome === 'error').length,
        p50Ms: at(50),
        p95Ms: at(95),
        p99Ms: at(99),
        maxMs: okMs.length === 0 ? null : Math.max(...okMs),
      });
    }
    const from =
      measured.length === 0
        ? runStart
        : Math.min(...measured.map((t) => t.start));
    const to =
      measured.length === 0 ? runEnd : Math.max(...measured.map((t) => t.end));
    const seconds = Math.max(1e-9, (to - from) / 1000);
    const ackWrites = measured.filter(
      (t) => t.outcome === 'ok' && (hot ? t.kind === 'land' : t.kind === 'save')
    ).length;

    const errors = attempts
      .filter((t) => t.outcome === 'error')
      .slice(0, MAX_ERRORS)
      .map((t) => ({
        kind: t.kind,
        agent: t.agent,
        output: t.output.trim().slice(-ERROR_OUTPUT_CHARS),
      }));

    const failures = new Map<
      string,
      {
        kind: ActionKind;
        outcome: 'fault' | 'error';
        message: string;
        count: number;
      }
    >();
    for (const t of attempts) {
      if (t.outcome === 'ok') continue;
      const message = (t.output.trim().split('\n').at(-1) ?? '').slice(
        0,
        FAILURE_MESSAGE_CHARS
      );
      const key = `${t.kind}\0${t.outcome}\0${message}`;
      const entry = failures.get(key) ?? {
        kind: t.kind,
        outcome: t.outcome,
        message,
        count: 0,
      };
      entry.count++;
      failures.set(key, entry);
    }

    const allChecks = {
      durability,
      authority: checks.authority,
      revisionBound,
      tenantIsolation: checks.tenantIsolation,
    };

    return {
      schedule,
      coverage: COVERAGE,
      durationMs: to - from,
      actions,
      throughput: {
        actionsPerSecond:
          measured.filter((t) => t.outcome === 'ok').length / seconds,
        acknowledgedWritesPerSecond: ackWrites / seconds,
      },
      queueWait: percentiles(queueWaits),
      recovery: {
        kills: kills.map((k) => {
          const first = attempts.find(
            (t) => t.outcome === 'ok' && t.start >= k.ready
          );
          return {
            restartMs: k.restartMs,
            recoveryMs: first === undefined ? null : first.end - k.t0,
          };
        }),
        storage: storage.map((s) => ({
          shards: s.shards,
          heldMs: s.to - s.from,
          faultedAttempts: attempts.filter(
            (t) => t.outcome === 'fault' && t.start <= s.to && t.end >= s.from
          ).length,
          ...(s.skipped === undefined ? {} : { skipped: s.skipped }),
        })),
      },
      network: {
        requests: net.requests,
        requestBytes: net.requestBytes,
        responseBytes: net.responseBytes,
        delayed: net.delayed,
        duplicated: net.duplicates.length,
        duplicateStatuses: countBy(net.duplicates, (d) =>
          String(d.status ?? 'unreachable')
        ),
        unreachable: net.unreachable,
      },
      server: {
        peakRssBytes: rss.length === 0 ? null : Math.max(...rss),
        meanRssBytes:
          rss.length === 0 ? null : rss.reduce((s, x) => s + x, 0) / rss.length,
        diskBytes: disk,
        restarts,
      },
      checks: allChecks,
      errors,
      failures: [...failures.values()].sort((a, b) => b.count - a.count),
      ok: Object.values(allChecks).every((c) => c.violations.length === 0),
    };
  } finally {
    clearInterval(sampler);
    await faultChain.catch(() => {});
    await serve.stop();
    await proxy.stop();
  }
}
