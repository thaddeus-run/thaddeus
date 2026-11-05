import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { run } from '../src/cli';
import { WORK_ROOT } from '../src/fixtures/cache';
import { defaultHost } from '../src/record';
import {
  validateWorkloadResult,
  type WorkloadResult,
} from '../src/workload/result';

// The real workload: the CLI from source as agents, a real `thaddeus serve`
// behind the fault proxy, every fault on. Small, so it fits a test, but it
// kills the server, makes storage read-only and replays requests.

const BIN = join(
  import.meta.dir,
  '..',
  '..',
  'packages',
  'cli',
  'src',
  'bin.ts'
);
process.env.BENCH_CLI = `${process.execPath} ${BIN}`;

const SLOW = 300_000;

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(WORK_ROOT, 'workload-test-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function workload(
  args: string[]
): Promise<{ code: number; result: WorkloadResult; log: string }> {
  const out = join(tmp, `${args.join('_').replaceAll('-', '')}.json`);
  const lines: string[] = [];
  const host = {
    ...defaultHost(),
    machineId: undefined,
    log: (l: string) => lines.push(l),
  };
  const code = await run(['workload', ...args, '--out', out], host);
  const result = JSON.parse(readFileSync(out, 'utf8')) as WorkloadResult;
  return { code, result, log: lines.join('\n') };
}

test(
  'hot shape with every fault: all checks run and pass',
  async () => {
    const { code, result, log } = await workload([
      '--agents',
      '2',
      '--rounds',
      '2',
      '--seed',
      '3',
    ]);
    expect(log).toContain('killed and restarted the server');
    expect(code).toBe(0);
    expect(validateWorkloadResult(result)).toEqual([]);
    const { checks } = result;
    expect(checks.durability.checked).toBeGreaterThan(0);
    expect(checks.authority.checked).toBeGreaterThan(0);
    expect(checks.tenantIsolation.checked).toBeGreaterThan(0);
    for (const check of Object.values(checks))
      expect(check.violations).toEqual([]);
    expect(result.recovery.kills.length).toBeGreaterThan(0);
    expect(result.recovery.kills[0].restartMs).toBeGreaterThan(0);
    expect(result.recovery.storage).toHaveLength(1);
    // The final crash before verification counts as a restart too.
    expect(result.server.restarts).toBe(result.recovery.kills.length + 1);
    const kinds: string[] = result.actions.map((a) => a.kind);
    for (const kind of ['save', 'land', 'probe-scope', 'probe-tenant']) {
      expect(kinds).toContain(kind);
    }
  },
  SLOW
);

test(
  'many shape without faults: every save publishes, nothing fails',
  async () => {
    const { code, result } = await workload([
      '--agents',
      '2',
      '--rounds',
      '2',
      '--shape',
      'many',
      '--faults',
      'none',
    ]);
    expect(code).toBe(0);
    expect(result.checks.tenantIsolation.checked).toBeGreaterThan(0);
    const save = result.actions.find((a) => a.kind === 'save');
    expect(save?.ok).toBe(4);
    expect(result.actions.some((a) => a.kind === 'land')).toBe(false);
    expect(result.recovery.kills).toEqual([]);
    expect(result.network.duplicated).toBe(0);
  },
  SLOW
);
