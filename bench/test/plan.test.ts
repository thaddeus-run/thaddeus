import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { expect, test } from 'bun:test';

import { contentFor } from '../src/fixtures/content';
import { generateFixture, manifestHash } from '../src/fixtures/plan';
import {
  FIXTURES,
  resolveFixture,
  serialSpec,
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
  expect(resolveFixture('small-serial')).toEqual(serialSpec(FIXTURES.small));
  expect(resolveFixture('sweep-4000-serial')).toEqual(
    serialSpec(sweepSpec(4_000))
  );
});

test('resolveFixture rejects names it does not know', () => {
  for (const name of [
    'huge',
    'sweep-',
    'sweep-0',
    'sweep-01',
    'sweep-1.5',
    'toString',
    'huge-serial',
    'small-serial-serial',
  ]) {
    expect(() => resolveFixture(name)).toThrow(name);
  }
});

// The base plans' hashes, pinned: adding the serial variant must not change
// a single base plan (it would orphan every cache and stored result). They
// cover GENERATOR_VERSION, so a deliberate bump updates them (4: lands
// re-point main directly instead of going through Repo.land).
test('base plans keep their manifest hashes', () => {
  const hashes = Object.fromEntries(
    ['tiny', 'small', 'medium', 'stress'].map((name) => [
      name,
      manifestHash(generateFixture(resolveFixture(name))),
    ])
  );
  expect(hashes).toEqual({
    tiny: '53577af06d832477da1a875612d9203b6cb72134cf8ef7182d9b6f4b785f2b49',
    small: '67bcc7fe2bdd924383ca279e23314ed366e7ccfb2557006c6766a8cf8c0b26b3',
    medium: '270e91b04da8af705f90139c69b74154056ff8b2f973381d22c316441b289b29',
    stress: '40ef49bc1a7ecc08a57d3a6339c14937dcbce396d850807dbacc43cf7e9b5d2e',
  });
});

test('a serial variant is named apart and hashes apart from its base', () => {
  for (const base of [tinySpec(), FIXTURES.small, FIXTURES.medium]) {
    const serial = serialSpec(base);
    expect(serial.name).toBe(`${base.name}-serial`);
    expect(manifestHash(generateFixture(serial))).not.toBe(
      manifestHash(generateFixture(base))
    );
  }
});

// Replays a plan's step list, tracking each view's paths and which views
// are open (forked and not yet landed), and checks the serial shape: same
// op count and authors as the spec, at most `views` views, no write to main
// while another view is open, every remove on a path its view holds, and
// main ending with exactly the paths of the last landed view.
function checkSerial(name: string): void {
  const plan = generateFixture(resolveFixture(`${name}-serial`));
  const spec = plan.spec;
  const files = new Map<string, Set<string>>([['main', new Set()]]);
  let open: string | undefined;
  let ops = 0;
  for (const step of plan.steps) {
    if (step.kind === 'fork') {
      expect(open).toBeUndefined();
      open = step.view;
      files.set(step.view, new Set(files.get('main')));
    } else if (step.kind === 'land') {
      expect(step.from).toBe(open!);
      files.set('main', new Set(files.get(step.from)));
      open = undefined;
    } else {
      ops += 1;
      expect(step.view).toBe(open ?? 'main');
      const viewFiles = files.get(step.view)!;
      if (step.kind === 'remove') {
        expect(viewFiles.has(step.path)).toBe(true);
        viewFiles.delete(step.path);
      } else viewFiles.add(step.path);
    }
  }
  expect(open).toBeUndefined();
  expect(ops).toBe(spec.ops);
  expect(plan.authorSeeds).toHaveLength(spec.authors);
  expect(files.size).toBeLessThanOrEqual(spec.views);
  if (spec.views > 1)
    expect(files.size).toBe(
      Math.min(spec.views, 1 + Math.ceil(spec.ops / spec.landEvery))
    );
}

test('serial plans fork from main, land before the next fork, and keep the counts', () => {
  for (const name of ['tiny', 'small', 'medium', 'stress', 'sweep-1000']) {
    checkSerial(name);
  }
});
