import { createPrng } from '../prng';

// The seeded schedule of the agent workload: who does what in which round,
// and which faults fire when. It is pure data generated from a seed, so a run
// can be replayed exactly from the schedule its result file carries. Only
// the interleaving of concurrent agents depends on the machine.

export const SCHEDULE_VERSION = 1;

// `hot`: every agent works on one repository owned by one owner, who lands
// each agent's work. `many`: every agent owns its own repository and
// publishes directly, so the repositories are independent tenants.
export type Shape = 'hot' | 'many';

// `cold`: measure from the first action on a fresh server and data root.
// `warm`: run one untimed round per agent first and measure the rest.
export type Start = 'cold' | 'warm';

// The faults a run can inject. `kill` and `storage` fire after a number of
// measured actions; `duplicate` and `delay` act on requests in the proxy;
// `stale` makes agents skip the pull that starts a round.
export const FAULT_KINDS = [
  'kill',
  'storage',
  'duplicate',
  'delay',
  'stale',
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export interface WorkloadConfig {
  seed: number;
  agents: number;
  rounds: number;
  shape: Shape;
  start: Start;
  faults: FaultKind[];
  /** How many integrators land queued work at once (hot shape). */
  integrators: number;
}

// One file write in a save: the path and a token the content is derived
// from (`fileContent`), so the schedule stays small.
export interface FileEdit {
  path: string;
  token: number;
}

// The steps of one agent round, in order.
export type Step =
  | { kind: 'sync' }
  | { kind: 'save'; edits: FileEdit[] }
  | { kind: 'integrate' }
  | { kind: 'query' }
  // A save outside the agent's delegated paths, from a throwaway clone; the
  // owner's land of it must be refused (hot shape).
  | { kind: 'probe-scope'; token: number }
  // A write attempt on a repository the actor has no grant for: `target` is
  // the tenant index (many) or -1 for the outsider on the hot repo.
  | { kind: 'probe-tenant'; target: number };

export interface AgentPlan {
  agent: number;
  rounds: Step[][];
}

// A fault that fires once `afterActions` measured actions have finished.
export interface FaultEvent {
  kind: 'kill' | 'storage';
  afterActions: number;
}

// Per-request faults applied in the proxy, in request-arrival order.
export interface RequestFaults {
  duplicateRate: number;
  delayRate: number;
  maxDelayMs: number;
}

export interface Schedule {
  version: typeof SCHEDULE_VERSION;
  config: WorkloadConfig;
  /** Rounds at the start of each agent's plan that are warm-up, not measured. */
  warmupRounds: number;
  agents: AgentPlan[];
  events: FaultEvent[];
  requests: RequestFaults;
}

// Each agent edits files from a small pool, so later saves rewrite files an
// earlier save created instead of only adding new ones.
const FILES_PER_AGENT = 4;
const MAX_EDITS_PER_SAVE = 3;

// Chances per round of the optional steps and of a stale round.
const QUERY_RATE = 0.5;
const PROBE_SCOPE_RATE = 0.15;
const PROBE_TENANT_RATE = 0.15;
const STALE_RATE = 0.3;

// Request fault rates when `duplicate` or `delay` is on.
const DUPLICATE_RATE = 0.1;
const DELAY_RATE = 0.1;
const MAX_DELAY_MS = 300;

// About one process kill per this many measured actions, at least one.
const ACTIONS_PER_KILL = 40;

// The agent's directory in the repository, the only paths its grant allows.
export function agentDir(agent: number): string {
  return `agents/a${agent}`;
}

// The content of a scheduled file write: a small TypeScript module that
// names its path and token, so two writes of one path differ.
export function fileContent(path: string, token: number): string {
  return `// ${path}\nexport const token = ${token};\n`;
}

// The path a scope probe writes: outside every agent's directory.
export function probePath(agent: number, token: number): string {
  return `probe/a${agent}-${token}.ts`;
}

// How many actions a step runs, for placing fault events. A save is one
// push, an integrate one land, a sync one pull, a scope probe a clone, a push
// and a land, a tenant probe a clone and a push.
function actionCount(step: Step): number {
  if (step.kind === 'probe-scope') return 3;
  if (step.kind === 'probe-tenant') return 2;
  return 1;
}

// Generates the schedule for `config`. The same config always gives the
// same schedule.
export function generateSchedule(config: WorkloadConfig): Schedule {
  const prng = createPrng(config.seed);
  const faults = new Set(config.faults);
  const warmupRounds = config.start === 'warm' ? 1 : 0;
  const totalRounds = config.rounds + warmupRounds;
  let token = 0;
  let measuredActions = 0;

  const agents: AgentPlan[] = [];
  for (let agent = 0; agent < config.agents; agent++) {
    const rounds: Step[][] = [];
    for (let round = 0; round < totalRounds; round++) {
      const steps: Step[] = [];
      const stale = faults.has('stale') && prng.next() < STALE_RATE;
      // Round 0 starts from a fresh clone, so it has nothing to pull.
      if (round > 0 && !stale) steps.push({ kind: 'sync' });
      const edits: FileEdit[] = [];
      const picked = new Set<number>();
      const count = 1 + prng.int(MAX_EDITS_PER_SAVE);
      while (picked.size < count) picked.add(prng.int(FILES_PER_AGENT));
      for (const file of [...picked].sort((a, b) => a - b)) {
        edits.push({ path: `${agentDir(agent)}/f${file}.ts`, token: token++ });
      }
      steps.push({ kind: 'save', edits });
      if (config.shape === 'hot') steps.push({ kind: 'integrate' });
      if (prng.next() < QUERY_RATE) steps.push({ kind: 'query' });
      if (config.shape === 'hot' && prng.next() < PROBE_SCOPE_RATE) {
        steps.push({ kind: 'probe-scope', token: token++ });
      }
      if (prng.next() < PROBE_TENANT_RATE) {
        if (config.shape === 'hot') {
          steps.push({ kind: 'probe-tenant', target: -1 });
        } else if (config.agents > 1) {
          // Any tenant but this agent's own.
          const other =
            (agent + 1 + prng.int(config.agents - 1)) % config.agents;
          steps.push({ kind: 'probe-tenant', target: other });
        }
      }
      if (round >= warmupRounds) {
        measuredActions += steps.reduce((n, s) => n + actionCount(s), 0);
      }
      rounds.push(steps);
    }
    agents.push({ agent, rounds });
  }

  // Every run checks authority and tenant isolation at least once: when the
  // draw scheduled no probe of a kind, agent 0's last round gets one. A
  // check that ran zero times could never fail.
  const last = agents[0].rounds[agents[0].rounds.length - 1];
  const has = (kind: Step['kind']) =>
    agents.some((a) => a.rounds.some((r) => r.some((s) => s.kind === kind)));
  const ensure = (step: Step) => {
    last.push(step);
    measuredActions += actionCount(step);
  };
  if (config.shape === 'hot' && !has('probe-scope')) {
    ensure({ kind: 'probe-scope', token: token++ });
  }
  if (!has('probe-tenant') && (config.shape === 'hot' || config.agents > 1)) {
    ensure({ kind: 'probe-tenant', target: config.shape === 'hot' ? -1 : 1 });
  }

  // Fault events land between 10 % and 80 % of the measured actions, so the
  // run has traffic before the first fault and time to recover after the
  // last. Sorted, so the driver can fire them in order.
  const events: FaultEvent[] = [];
  const at = (): number =>
    Math.max(1, Math.floor(measuredActions * (0.1 + 0.7 * prng.next())));
  if (faults.has('kill')) {
    const kills = Math.max(1, Math.floor(measuredActions / ACTIONS_PER_KILL));
    for (let i = 0; i < kills; i++) {
      events.push({ kind: 'kill', afterActions: at() });
    }
  }
  if (faults.has('storage')) {
    events.push({ kind: 'storage', afterActions: at() });
  }
  events.sort((a, b) => a.afterActions - b.afterActions);

  return {
    version: SCHEDULE_VERSION,
    config: { ...config, faults: [...config.faults] },
    warmupRounds,
    agents,
    events,
    requests: {
      duplicateRate: faults.has('duplicate') ? DUPLICATE_RATE : 0,
      delayRate: faults.has('delay') ? DELAY_RATE : 0,
      maxDelayMs: faults.has('delay') ? MAX_DELAY_MS : 0,
    },
  };
}
