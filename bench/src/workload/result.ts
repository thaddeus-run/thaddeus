import Ajv2020 from 'ajv/dist/2020';

import schema from '../../schema/bench-workload.schema.json';
import type { Machine } from '../result';
import type { Schedule } from './schedule';

// The file one workload run writes, `bench/schema/bench-workload.schema.json`.
// Bump WORKLOAD_VERSION when the actions, checks or the meaning of a number
// change, so results from different versions are never compared.

export const WORKLOAD_VERSION = 1;

// The kinds of CLI action a run times.
export const ACTION_KINDS = [
  'clone',
  'pull',
  'save',
  'land',
  'query',
  'probe-scope',
  'probe-tenant',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

// How one attempt of an action ended. `ok` is the expected answer, including
// an expected refusal from a probe. `fault` is a failure while an injected
// fault was active; `error` is any other failure.
export type AttemptOutcome = 'ok' | 'fault' | 'error';

export interface ActionSummary {
  kind: ActionKind;
  attempts: number;
  ok: number;
  fault: number;
  error: number;
  /** Over the ok attempts; null when there were none. */
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

export interface Percentiles {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface Check {
  /** How many things the check looked at. */
  checked: number;
  violations: string[];
}

// Whether the workload drives each action THA-118 names, and how.
export interface Coverage {
  action: string;
  status: 'covered' | 'not shipped' | 'not covered';
  how: string;
}

export interface WorkloadResult {
  schemaVersion: 1;
  workloadVersion: number;
  commit: string;
  dirty: boolean;
  recordedAt: string;
  machine: Machine;
  /** The CLI command the run drove, as BENCH_CLI or the release binary. */
  cli: string;
  durability: string;
  schedule: Schedule;
  coverage: Coverage[];
  durationMs: number;
  actions: ActionSummary[];
  throughput: {
    actionsPerSecond: number;
    /** Lands, and publishing saves in the many shape, that returned ok. */
    acknowledgedWritesPerSecond: number;
  };
  /** From an agent asking for integration to an integrator starting it. */
  queueWait: Percentiles;
  recovery: {
    kills: { restartMs: number; recoveryMs: number | null }[];
    storage: {
      shards: number;
      heldMs: number;
      faultedAttempts: number;
      skipped?: string;
    }[];
  };
  network: {
    requests: number;
    requestBytes: number;
    responseBytes: number;
    delayed: number;
    duplicated: number;
    /** Replayed writes by the status the server gave the copy. */
    duplicateStatuses: Record<string, number>;
    unreachable: number;
  };
  server: {
    peakRssBytes: number | null;
    meanRssBytes: number | null;
    diskBytes: number;
    restarts: number;
  };
  checks: {
    durability: Check;
    authority: Check;
    revisionBound: Check;
    tenantIsolation: Check;
  };
  /** The first failed attempts outside the probes, with their output. */
  errors: { kind: ActionKind; agent: number; output: string }[];
  /**
   * Every failed attempt, fault or error, counted by action kind, outcome
   * and the last line of its output, most frequent first.
   */
  failures: {
    kind: ActionKind;
    outcome: 'fault' | 'error';
    message: string;
    count: number;
  }[];
  /** True when every check passed. */
  ok: boolean;
}

const validate = new Ajv2020({ allErrors: true }).compile(schema);

// Checks an unknown value against the workload JSON Schema and returns one
// human-readable string per violation; an empty array means it is valid.
export function validateWorkloadResult(result: unknown): string[] {
  if (validate(result)) return [];
  return (validate.errors ?? []).map(
    (e) =>
      `${e.instancePath === '' ? '(root)' : e.instancePath} ${e.message ?? 'is invalid'}`
  );
}
