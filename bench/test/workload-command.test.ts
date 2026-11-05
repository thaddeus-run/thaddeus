import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/cli';
import { defaultHost, type Host } from '../src/record';
import { workloadCommand } from '../src/workload/command';
import {
  COVERAGE,
  type DriveOptions,
  type DriveOutput,
} from '../src/workload/driver';
import {
  validateWorkloadResult,
  type WorkloadResult,
} from '../src/workload/result';

let tmp: string;
let lines: string[];
let host: Host;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'workload-command-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function freshHost(): Host {
  lines = [];
  host = {
    ...defaultHost(),
    machineId: undefined,
    log: (line) => lines.push(line),
  };
  return host;
}

const check = (violations: string[] = []) => ({ checked: 1, violations });

// A driver that runs nothing: it returns a plausible measurement for the
// schedule it was given, with the durability violations passed in.
function fakeDrive(violations: string[] = [], seen: DriveOptions[] = []) {
  return (opts: DriveOptions): Promise<DriveOutput> => {
    seen.push(opts);
    return Promise.resolve({
      schedule: opts.schedule,
      coverage: COVERAGE,
      durationMs: 1000,
      actions: [
        {
          kind: 'save',
          attempts: 2,
          ok: 1,
          fault: 1,
          error: 0,
          p50Ms: 10,
          p95Ms: 10,
          p99Ms: 10,
          maxMs: 10,
        },
      ],
      throughput: { actionsPerSecond: 1, acknowledgedWritesPerSecond: 1 },
      queueWait: { samples: 0, p50Ms: null, p95Ms: null, maxMs: null },
      recovery: {
        kills: [{ restartMs: 400, recoveryMs: null }],
        storage: [{ shards: 2, heldMs: 1500, faultedAttempts: 1 }],
      },
      network: {
        requests: 3,
        requestBytes: 10,
        responseBytes: 20,
        delayed: 1,
        duplicated: 1,
        duplicateStatuses: { '409': 1 },
        unreachable: 0,
      },
      server: {
        peakRssBytes: null,
        meanRssBytes: null,
        diskBytes: 100,
        restarts: 2,
      },
      checks: {
        durability: check(violations),
        authority: check(),
        revisionBound: check(),
        tenantIsolation: check(),
      },
      errors: [],
      ok: violations.length === 0,
    });
  };
}

function readResult(path: string): WorkloadResult {
  return JSON.parse(readFileSync(path, 'utf8')) as WorkloadResult;
}

test('a run whose checks pass exits 0 and writes a valid result', async () => {
  const out = join(tmp, 'ok.json');
  const code = await workloadCommand(
    ['--agents', '2', '--rounds', '1', '--seed', '5', '--out', out],
    freshHost(),
    fakeDrive()
  );
  expect(code).toBe(0);
  const result = readResult(out);
  expect(validateWorkloadResult(result)).toEqual([]);
  expect(result.schedule.config).toMatchObject({
    seed: 5,
    agents: 2,
    rounds: 1,
  });
  expect(result.workloadVersion).toBe(1);
});

test('a violation exits 1 and is logged', async () => {
  const out = join(tmp, 'bad.json');
  const code = await workloadCommand(
    ['--out', out],
    freshHost(),
    fakeDrive([
      'bench/hot: acknowledged agents/a0/f0.ts#1 is missing from main',
    ])
  );
  expect(code).toBe(1);
  expect(readResult(out).ok).toBe(false);
  expect(lines.join('\n')).toContain('missing from main');
  // A failed run keeps its work directory; this one holds nothing.
  const kept = /kept the work directory (\S+)/.exec(lines.join('\n'))?.[1];
  expect(kept).toBeDefined();
  rmSync(kept as string, { recursive: true, force: true });
});

test('--replay drives the exact schedule an earlier result carries', async () => {
  const first = join(tmp, 'first.json');
  await workloadCommand(
    [
      '--seed',
      '11',
      '--shape',
      'many',
      '--faults',
      'kill,delay',
      '--out',
      first,
    ],
    freshHost(),
    fakeDrive()
  );
  const seen: DriveOptions[] = [];
  const second = join(tmp, 'second.json');
  const code = await workloadCommand(
    ['--replay', first, '--out', second],
    freshHost(),
    fakeDrive([], seen)
  );
  expect(code).toBe(0);
  expect(seen[0].schedule).toEqual(readResult(first).schedule);
});

test('a result that breaks the schema is never written', async () => {
  const out = join(tmp, 'never.json');
  const broken = async (opts: DriveOptions) => {
    const output = await fakeDrive()(opts);
    return { ...output, durationMs: -1 };
  };
  const error = await workloadCommand(['--out', out], freshHost(), broken).then(
    () => null,
    (e: unknown) => e
  );
  expect(String(error)).toContain('does not match the schema');
  expect(existsSync(out)).toBe(false);
});

test('bad flags are usage errors (exit 2)', async () => {
  for (const argv of [
    ['--shape', 'warm'],
    ['--start', 'hot'],
    ['--faults', 'kill,meteor'],
    ['--agents', '0'],
  ]) {
    expect(await run(['workload', ...argv], freshHost())).toBe(2);
  }
  expect(lines.join('\n')).toContain('bun src/cli.ts workload');
});
