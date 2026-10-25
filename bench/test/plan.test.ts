import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
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

// Pins the exact bytes contentFor produces. The manifest hash covers the recipe
// (path, seed, size) but not the algorithm, so if this fails after a deliberate
// change, bump GENERATOR_VERSION in plan.ts and update these hashes together.
test('contentFor output is pinned by golden hashes', () => {
  const golden: [string, number, number, string][] = [
    [
      'src/f0.ts',
      12345,
      200,
      '0df86e2943a699cc9c36a54817539c1fecd6524d5ffd216ccd044ef5e5756e5c',
    ],
    [
      'src/f7.ts',
      987654,
      3000,
      '4cc0a1b9417fd8fad68398ec470bb49cc0c0683fa7776775699f90425929c3dd',
    ],
    [
      'src/f1999.ts',
      2000000000,
      8000,
      '5d185e95b5c7417fd3786c90bf9ed8a71d1dc1e6f6efa96ba1ea0631d6bf3af2',
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
