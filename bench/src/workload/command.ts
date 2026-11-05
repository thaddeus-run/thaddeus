import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { cliCommand } from '../e2e/home';
import { WORK_ROOT } from '../fixtures/cache';
import { detectMachine, readMachineFile } from '../machine';
import { type Host, UsageError } from '../record';
import { FILEBACKEND_DURABILITY } from '../result';
import { drive } from './driver';
import {
  validateWorkloadResult,
  WORKLOAD_VERSION,
  type WorkloadResult,
} from './result';
import {
  FAULT_KINDS,
  type FaultKind,
  generateSchedule,
  type Schedule,
  type WorkloadConfig,
} from './schedule';

// `bench workload`: generates (or replays) a schedule, drives it and writes
// the result. Exits 1 when a check found a violation, so a script or a test
// can gate on it.

export const WORKLOAD_USAGE = `  bun src/cli.ts workload [--seed N] [--agents N] [--rounds N] [--shape hot|many]
                     [--start cold|warm] [--faults kill,storage,duplicate,delay,stale|none]
                     [--integrators N] [--replay result.json] [--out file]
                     drive the seeded agent workload; exit 1 if a check fails`;

const DEFAULTS: WorkloadConfig = {
  seed: 1,
  agents: 4,
  rounds: 3,
  shape: 'hot',
  start: 'cold',
  faults: [...FAULT_KINDS],
  integrators: 1,
};

function integer(name: string, value: string, min: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new UsageError(`--${name} must be an integer of at least ${min}`);
  }
  return n;
}

function faultsOf(value: string): FaultKind[] {
  if (value === 'none') return [];
  const faults = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  for (const fault of faults) {
    if (!(FAULT_KINDS as readonly string[]).includes(fault)) {
      throw new UsageError(`unknown fault ${fault}`);
    }
  }
  return [...new Set(faults)] as FaultKind[];
}

// The schedule a replay runs: the one stored in an earlier result file.
function replayed(path: string): Schedule {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const errors = validateWorkloadResult(parsed);
  if (errors.length > 0) {
    throw new UsageError(
      `${path} is not a workload result:\n${errors.join('\n')}`
    );
  }
  return (parsed as WorkloadResult).schedule;
}

// Writes a result after validating it; an invalid result is a bug in the
// workload, so nothing is written.
export function writeWorkloadResult(path: string, result: WorkloadResult) {
  const errors = validateWorkloadResult(result);
  if (errors.length > 0) {
    throw new Error(
      `workload result does not match the schema:\n${errors.join('\n')}`
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
}

export async function workloadCommand(
  argv: readonly string[],
  host: Host,
  run: typeof drive = drive
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      seed: { type: 'string', default: String(DEFAULTS.seed) },
      agents: { type: 'string', default: String(DEFAULTS.agents) },
      rounds: { type: 'string', default: String(DEFAULTS.rounds) },
      shape: { type: 'string', default: DEFAULTS.shape },
      start: { type: 'string', default: DEFAULTS.start },
      faults: { type: 'string', default: DEFAULTS.faults.join(',') },
      integrators: { type: 'string', default: String(DEFAULTS.integrators) },
      replay: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });

  let schedule: Schedule;
  if (values.replay !== undefined) {
    schedule = replayed(resolve(values.replay));
  } else {
    const { shape, start } = values;
    if (shape !== 'hot' && shape !== 'many') {
      throw new UsageError(`unknown shape ${shape}`);
    }
    if (start !== 'cold' && start !== 'warm') {
      throw new UsageError(`unknown start ${start}`);
    }
    schedule = generateSchedule({
      seed: integer('seed', values.seed, 0),
      agents: integer('agents', values.agents, 1),
      rounds: integer('rounds', values.rounds, 1),
      shape,
      start,
      faults: faultsOf(values.faults),
      integrators: integer('integrators', values.integrators, 1),
    });
  }

  const id = host.machineId ?? 'local';
  if (
    host.machineId !== undefined &&
    readMachineFile(id, host.machinesDir) === undefined
  ) {
    host.log(`bench: BENCH_MACHINE=${id} has no file in bench/machines`);
    return 1;
  }
  const { sha, short } = host.commit();
  const machine = detectMachine(id, {
    probe: host.probe,
    machinesDir: host.machinesDir,
  });
  const cli = cliCommand();
  mkdirSync(WORK_ROOT, { recursive: true });
  const workDir = mkdtempSync(join(WORK_ROOT, 'workload-'));
  const recordedAt = new Date().toISOString();

  const measured = await run({ schedule, cli, workDir, log: host.log });
  const result: WorkloadResult = {
    schemaVersion: 1,
    workloadVersion: WORKLOAD_VERSION,
    commit: sha,
    dirty: host.dirtyPaths().length > 0,
    recordedAt,
    machine,
    cli: cli.join(' '),
    durability: FILEBACKEND_DURABILITY,
    ...measured,
  };
  const { config } = schedule;
  const out =
    values.out === undefined
      ? join(
          host.outDir,
          `workload-${recordedAt.slice(0, 10)}-${short}-${config.shape}-${config.start}-s${config.seed}.json`
        )
      : resolve(values.out);
  writeWorkloadResult(out, result);
  for (const [name, check] of Object.entries(result.checks)) {
    host.log(
      `workload: ${name}: ${check.checked} checked, ${check.violations.length} violation(s)`
    );
    for (const violation of check.violations) host.log(`  ${violation}`);
  }
  // A failed run keeps its server data and working copies for debugging.
  if (result.ok) rmSync(workDir, { recursive: true, force: true });
  else host.log(`workload: kept the work directory ${workDir}`);
  host.log(`wrote ${out}`);
  return result.ok ? 0 : 1;
}
