import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { expect, test } from 'bun:test';

import { contentFor } from '../src/fixtures/content';
import { generateFixture, manifestHash } from '../src/fixtures/plan';
import {
  FIXTURES,
  resolveFixture,
  sweepSpec,
  tinySpec,
} from '../src/fixtures/spec';

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
    manifestHash({ ...generateFixture(FIXTURES.small), generatorVersion: 99 })
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

test('contentFor is deterministic source of the requested size', () => {
  const w = generateFixture(FIXTURES.small).steps.find(
    (s) => s.kind === 'write'
  )!;
  expect(contentFor(w)).toEqual(contentFor(w));
  expect(Math.abs(contentFor(w).length - w.bytes)).toBeLessThan(64);
  expect(new TextDecoder().decode(contentFor(w))).toContain('fn f_');
});

// Pins the exact bytes contentFor produces. The manifest hash covers the recipe
// (path, seed, size) but not the algorithm, so if this fails after a deliberate
// change, bump GENERATOR_VERSION in plan.ts and update these hashes together.
test('contentFor output is pinned by golden hashes', () => {
  const golden: [string, number, number, string][] = [
    [
      'src/f0.ts',
      12345,
      200,
      'e046dd679956ecf9d3b6b7dbf1d9ecb8c879d19d35ea39cd3f72514a7c0e9ccb',
    ],
    [
      'src/f7.ts',
      987654,
      3000,
      '17d0369e89951a68e264394d8b90d9ff336c64c06c7d9034432638d6d592354f',
    ],
    [
      'src/f1999.ts',
      2000000000,
      8000,
      'd3524f1e5af248992db2007a0a2760e7c296cc4a70bd4fcacfac34ff3fd8d26d',
    ],
  ];
  for (const [path, contentSeed, bytes, hash] of golden) {
    const step = {
      kind: 'write' as const,
      view: 'main',
      path,
      author: 0,
      contentSeed,
      bytes,
      at: '2026-01-01T00:00:00Z',
    };
    expect(bytesToHex(blake3(contentFor(step)))).toBe(hash);
  }
});

test('resolveFixture maps every fixture name to its spec', () => {
  expect(resolveFixture('small')).toEqual(FIXTURES.small);
  expect(resolveFixture('medium')).toEqual(FIXTURES.medium);
  expect(resolveFixture('stress')).toEqual(FIXTURES.stress);
  expect(resolveFixture('tiny')).toEqual(tinySpec());
  expect(resolveFixture('sweep-4000')).toEqual(sweepSpec(4_000));
});

test('resolveFixture rejects names it does not know', () => {
  for (const name of [
    'huge',
    'sweep-',
    'sweep-0',
    'sweep-01',
    'sweep-1.5',
    'toString',
  ]) {
    expect(() => resolveFixture(name)).toThrow(name);
  }
});
