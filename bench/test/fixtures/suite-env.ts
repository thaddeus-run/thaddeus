import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { detectMachine, type MachineProbe } from '../../src/machine';
import {
  defaultHost,
  type Host,
  type SuiteEnv,
  type SuiteOptions,
} from '../../src/record';
import type { BenchRun } from '../../src/result';

// Test doubles shared by the record and suite tests: a fixed machine probe,
// a suite environment over the fake suite registry, and a host whose
// `runSuite` only records what it was asked.

export const SUITE_FAKES = join(import.meta.dir, 'suite-cases.ts');

export const fakeProbe: MachineProbe = {
  cpuinfo: () => 'processor\t: 0\nmodel name\t: Test CPU\n',
  meminfo: () => 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\n',
  loadAvg1: () => 0.1,
  virtualization: () => 'kvm',
  os: () => 'Test OS',
  bun: () => Bun.version,
};

// A suite environment on the fake machine with the fake library registry, no
// e2e suite and two sweep sizes, with `overrides` on top.
export function suiteEnv(overrides: Partial<SuiteEnv> = {}): SuiteEnv {
  return {
    machine: detectMachine('local', { probe: fakeProbe }),
    commit: 'c'.repeat(40),
    dirty: false,
    registryFor: (suite) => (suite === 'library' ? SUITE_FAKES : null),
    sweepSizes: [1_000, 2_000],
    log: () => {},
    ...overrides,
  };
}

// A host that answers from fixed values and records what `record` asked the
// suite to run, without running it. Results go under a new directory in
// `scratch`.
export function fakeHost(
  scratch: string,
  overrides: Partial<Host> = {}
): {
  host: Host;
  calls: { opts: SuiteOptions; env: SuiteEnv }[];
  lines: string[];
} {
  const calls: { opts: SuiteOptions; env: SuiteEnv }[] = [];
  const lines: string[] = [];
  const host: Host = {
    ...defaultHost(),
    machineId: 'kvm-epyc-rome-4vcpu',
    probe: fakeProbe,
    dirtyPaths: () => [],
    sudoOk: () => true,
    commit: () => ({ sha: 'a'.repeat(40), short: 'aaaaaaa' }),
    dropPageCache: () => Promise.resolve(),
    resultsDir: mkdtempSync(join(scratch, 'results-')),
    runSuite: (opts, env): Promise<BenchRun> => {
      calls.push({ opts, env });
      return Promise.resolve({
        schemaVersion: 1,
        commit: env.commit,
        dirty: env.dirty,
        suiteVersion: 'v',
        recordedAt: '2026-10-25T12:00:00.000Z',
        machine: env.machine,
        method: {
          repeats: opts.repeats,
          warmup: opts.warmup,
          budgetMs: opts.budgetMs,
          isolation: 'subprocess',
        },
        cases: [],
        sweeps: [],
      });
    },
    log: (line) => lines.push(line),
    ...overrides,
  };
  return { host, calls, lines };
}
