import { expect, test } from 'bun:test';

import type { BenchRun } from '../src/result';
import { FILEBACKEND_DURABILITY, validateRun } from '../src/result';

const validRun: BenchRun = {
  schemaVersion: 1,
  commit: '92a8e7b',
  dirty: false,
  suiteVersion: '1',
  recordedAt: '2026-10-25T12:00:00.000Z',
  machine: {
    id: 'kvm-epyc-rome-4vcpu',
    description: 'shared, virtualized guest',
    cpu: 'AMD EPYC Rome',
    vcpus: 4,
    memoryBytes: 7 * 1024 ** 3,
    virtualization: 'KVM',
    os: 'linux',
    bun: '1.3.0',
    loadAvg1: 0.1,
    memAvailableBytes: 6 * 1024 ** 3,
  },
  method: { repeats: 5, warmup: 1, budgetMs: 60_000, isolation: 'subprocess' },
  cases: [
    {
      id: 'store.write',
      version: 1,
      suite: 'library',
      fixture: 'small',
      manifestHash: 'abc123',
      status: 'ok',
      budgetMs: 60_000,
      repeats: 5,
      warmup: 1,
      samplesMs: [1, 2, 3, 4, 5],
      p50Ms: 3,
      p95Ms: 4.8,
      cv: 0.5,
      peakRssBytes: 1024,
    },
  ],
  sweeps: [
    {
      id: 'sweep.history',
      version: 1,
      points: [
        { n: 1000, p50Ms: 1 },
        { n: 2000, p50Ms: 2 },
      ],
      exponent: null,
      r2: null,
      status: 'ok',
    },
  ],
};

test('a minimal valid run passes', () => {
  expect(validateRun(validRun)).toEqual([]);
});

test('a dirty run is still valid (record refuses it, not the schema)', () => {
  expect(validateRun({ ...validRun, dirty: true })).toEqual([]);
});

test('a case with every optional field passes, including null statistics', () => {
  const full = {
    ...validRun.cases[0],
    status: 'exceeded',
    phase: 'run',
    failedAtN: 4000,
    samplesMs: [],
    p50Ms: null,
    p95Ms: null,
    cv: null,
    throughput: { value: 12.5, unit: 'MB/s' },
    diskBytes: 4096,
    durability: FILEBACKEND_DURABILITY,
    pageCache: 'dropped',
    serveFlags: ['--max-objects', '1000000'],
    note: 'killed at budget',
  };
  expect(validateRun({ ...validRun, cases: [full] })).toEqual([]);
});

test('a missing machine yields an error', () => {
  expect(
    validateRun({ ...validRun, machine: undefined }).length
  ).toBeGreaterThan(0);
});

test('an unknown status yields an error', () => {
  const bad = {
    ...validRun,
    cases: [{ ...validRun.cases[0], status: 'slow' }],
  };
  expect(validateRun(bad).length).toBeGreaterThan(0);
});

test('unknown properties on the run, a case or the machine are rejected', () => {
  expect(validateRun({ ...validRun, extra: 1 }).length).toBeGreaterThan(0);
  expect(
    validateRun({ ...validRun, cases: [{ ...validRun.cases[0], extra: 1 }] })
      .length
  ).toBeGreaterThan(0);
  expect(
    validateRun({ ...validRun, machine: { ...validRun.machine, extra: 1 } })
      .length
  ).toBeGreaterThan(0);
});

test('non-objects are rejected', () => {
  expect(validateRun(null).length).toBeGreaterThan(0);
});
