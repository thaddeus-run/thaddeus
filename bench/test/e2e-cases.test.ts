import { expect, test } from 'bun:test';
import { join } from 'node:path';

import e2eCases from '../src/e2e/cases';
import { registryFor } from '../src/record';

// The e2e registry's static shape: ids, versions, serve flags and caps. The
// tests that start real servers and CLIs are in test-slow/e2e.test.ts.

const E2E = join(import.meta.dir, '..', 'src', 'e2e', 'cases.ts');

const byId = (id: string) => {
  const found = e2eCases.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  return found;
};

test('repo.create caps its timed repeats under the hourly creation limit', () => {
  expect(byId('e2e.repo.create').maxRepeats).toBe(15);
});

// Pull and land take one server land per sample in setup, so ten repeats
// and two warm-ups would record a bare `exceeded` under `record`.
test('pull and land are capped at three samples and no warm-up', () => {
  for (const id of ['e2e.pull', 'e2e.land']) {
    expect([byId(id).maxRepeats, byId(id).maxWarmup]).toEqual([3, 0]);
  }
});

// Ten 30 s bursts would not fit the 120 s `run` budget.
test('repos-per-minute is capped at three bursts and no warm-up', () => {
  const rpm = byId('e2e.repos-per-minute');
  expect([rpm.maxRepeats, rpm.maxWarmup]).toEqual([3, 0]);
});

// Suite runs pass the serial names, so these use them: the limits depend
// on the fixture's size, not on the exact name.
test('stress and medium raise only the limits their pushes hit', () => {
  const flags = (id: string, fixture: string) => byId(id).serveFlags?.(fixture);
  expect(flags('e2e.push.10', 'small-serial')).toEqual([]);
  expect(flags('e2e.push.10', 'medium-serial')).toEqual([
    '--max-request-body-bytes',
    '1073741824',
  ]);
  expect(flags('e2e.push.10', 'stress-serial')).toEqual([
    '--max-objects',
    '10000000',
    '--max-request-body-bytes',
    '1073741824',
  ]);
  expect(flags('e2e.checkout.cold', 'medium-serial')).toEqual([]);
  expect(flags('e2e.checkout.cold', 'stress-serial')).toEqual([
    '--max-objects',
    '10000000',
  ]);
  // The base names resolve to the same sizes.
  expect(flags('e2e.push.10', 'medium')).toEqual(
    flags('e2e.push.10', 'medium-serial')
  );
  expect(flags('e2e.repos-per-minute', 'stress-serial')).toEqual([
    '--max-objects',
    '10000000',
    '--repository-creation-limit',
    '1000000',
    '--max-repositories',
    '1000000',
  ]);
});

test('the checkout note says the dropped mode re-warms dentries and inodes', () => {
  expect(byId('e2e.checkout.cold').note).toContain('cp -al');
  expect(byId('e2e.checkout.cold').note).toContain('inodes');
});

test('the e2e registry is the one suite runs use', () => {
  expect(registryFor('e2e')).toBe(E2E);
  expect(e2eCases.map((c) => c.id)).toEqual([
    'e2e.checkout.cold',
    'e2e.push.10',
    'e2e.push.100',
    'e2e.pull',
    'e2e.land',
    'e2e.repo.create',
    'e2e.repos-per-minute',
  ]);
  for (const c of e2eCases) {
    expect(c.suite).toBe('e2e');
    expect(c.version).toBe(1);
    expect(c.variant).toBe('serial');
  }
});
