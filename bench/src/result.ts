import Ajv2020 from 'ajv/dist/2020';

import schema from '../schema/bench-run.schema.json';

// Every write, push and land result carries this string: FileBackend renames
// atomically but never calls fsync, so readers must not mistake the numbers
// for durable-commit latency.
export const FILEBACKEND_DURABILITY =
  'none (FileBackend renames atomically, no fsync)';

export type CaseStatus = 'ok' | 'exceeded' | 'oom' | 'error';

export interface Machine {
  id: string;
  description: string;
  cpu: string;
  vcpus: number;
  memoryBytes: number;
  virtualization: string;
  os: string;
  bun: string;
  loadAvg1: number;
  memAvailableBytes: number;
}

export interface CaseResult {
  id: string;
  version: number;
  suite: 'library' | 'e2e';
  fixture: string;
  manifestHash: string;
  status: CaseStatus;
  phase?: 'setup' | 'run';
  budgetMs: number;
  failedAtN?: number;
  repeats: number;
  warmup: number;
  samplesMs: number[];
  p50Ms: number | null;
  p95Ms: number | null;
  cv: number | null;
  throughput?: { value: number; unit: 'ops/s' | 'MB/s' | 'repos/min' };
  peakRssBytes: number;
  diskBytes?: number;
  durability?: string;
  pageCache?: 'warm' | 'dropped';
  serveFlags?: string[];
  note?: string;
}

export interface SweepResult {
  id: string;
  version: number;
  points: { n: number; p50Ms: number }[];
  exponent: number | null;
  r2: number | null;
  status: CaseStatus;
  failedAtN?: number;
}

export interface BenchRun {
  schemaVersion: 1;
  commit: string;
  dirty: boolean;
  suiteVersion: string;
  recordedAt: string;
  machine: Machine;
  method: {
    repeats: number;
    warmup: number;
    budgetMs: number;
    isolation: 'subprocess';
  };
  cases: CaseResult[];
  sweeps: SweepResult[];
}

// Compiled once at import: the schema never changes at runtime and ajv
// compilation is the expensive part. `allErrors` reports every violation
// instead of stopping at the first, which makes a bad results file easier to fix.
const validate = new Ajv2020({ allErrors: true }).compile(schema);

// Checks an unknown value against the BenchRun JSON Schema and returns one
// human-readable string per violation; an empty array means the run is valid.
export function validateRun(run: unknown): string[] {
  if (validate(run)) return [];
  return (validate.errors ?? []).map(
    (e) =>
      `${e.instancePath === '' ? '(root)' : e.instancePath} ${e.message ?? 'is invalid'}`
  );
}
