import { expect, test } from 'bun:test';

import { contentFor } from '../src/fixtures/content';
import { generateFixture, manifestHash } from '../src/fixtures/plan';
import { FIXTURES } from '../src/fixtures/spec';

test('same spec gives the same manifest hash', () => {
  expect(manifestHash(generateFixture(FIXTURES.small))).toBe(
    manifestHash(generateFixture(FIXTURES.small))
  );
});

test('seed and generator version both change the hash', () => {
  const base = manifestHash(generateFixture(FIXTURES.small));
  expect(
    manifestHash(
      generateFixture({ ...FIXTURES.small, seed: FIXTURES.small.seed + 1 })
    )
  ).not.toBe(base);
  expect(
    manifestHash({ ...generateFixture(FIXTURES.small), generatorVersion: 2 })
  ).not.toBe(base);
});

test('plan matches the spec table', () => {
  const p = generateFixture(FIXTURES.medium);
  const ops = p.steps.filter((s) => s.kind === 'write' || s.kind === 'remove');
  expect(ops).toHaveLength(20_000);
  expect(new Set(ops.map((s) => s.path)).size).toBeLessThanOrEqual(2_000);
  expect(p.authorSeeds).toHaveLength(10);
  expect(
    new Set(p.steps.filter((s) => s.kind === 'fork').map((s) => s.view)).size
  ).toBe(49);
  expect(p.steps.some((s) => s.kind === 'land')).toBe(true);
});

test('contentFor is deterministic TypeScript of the requested size', () => {
  const w = generateFixture(FIXTURES.small).steps.find(
    (s) => s.kind === 'write'
  )!;
  expect(contentFor(w)).toEqual(contentFor(w));
  expect(Math.abs(contentFor(w).length - w.bytes)).toBeLessThan(64);
  expect(new TextDecoder().decode(contentFor(w))).toContain('export function ');
});
