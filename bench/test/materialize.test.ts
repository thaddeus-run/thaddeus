import { FileBackend, MemoryBackend } from '@thaddeus.run/persist';
import { Platform } from '@thaddeus.run/platform';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fixtureDir, linkCopy } from '../src/fixtures/cache';
import { materializeFixture } from '../src/fixtures/materialize';
import { generateFixture, manifestHash } from '../src/fixtures/plan';
import { tinySpec } from '../src/fixtures/spec';

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bench-materialize-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('materialized repo reopens with every op and a conflicting frontier', async () => {
  const plan = generateFixture({
    ...tinySpec(),
    ops: 200,
    files: 20,
    views: 4,
  });
  const root = await fixtureDir(plan, { cacheRoot: tmp });
  const repo = await new Platform().openDurable('bench', new FileBackend(root));
  expect(repo.log.ops()).toHaveLength(200);
  expect(repo.log.materialize('main').size).toBeGreaterThan(0);
  expect(repo.log.conflicts().length).toBeGreaterThan(0);
});

test('a second call reuses the cache', async () => {
  const plan = generateFixture(tinySpec());
  const a = await fixtureDir(plan, { cacheRoot: tmp });
  const before = statSync(join(a, '.complete')).mtimeMs;
  expect(await fixtureDir(plan, { cacheRoot: tmp })).toBe(a);
  expect(statSync(join(a, '.complete')).mtimeMs).toBe(before);
});

test('a directory without .complete is rebuilt', async () => {
  const plan = generateFixture(tinySpec());
  const dir = await fixtureDir(plan, { cacheRoot: tmp });
  rmSync(join(dir, '.complete'));
  await fixtureDir(plan, { cacheRoot: tmp });
  expect(readFileSync(join(dir, '.complete'), 'utf8')).toBe(manifestHash(plan));
});

test('repos option adds tiny filler repos beside bench', async () => {
  const dir = await fixtureDir(generateFixture(tinySpec()), {
    cacheRoot: tmp,
    repos: 3,
  });
  const repos = new Set(
    (await new FileBackend(dir).list('repo/')).map((k) => k.split('/')[1])
  );
  expect(repos.size).toBe(3);
});

test('no temporary directories are left behind', async () => {
  await fixtureDir(generateFixture(tinySpec()), { cacheRoot: tmp });
  expect(readdirSync(tmp).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
});

test('linkCopy makes an independent, openable copy', async () => {
  const plan = generateFixture(tinySpec());
  const src = await fixtureDir(plan, { cacheRoot: tmp });
  const dst = join(tmp, 'copy');
  await linkCopy(src, dst);
  const repo = await new Platform().openDurable('bench', new FileBackend(dst));
  expect(repo.log.ops()).toHaveLength(plan.spec.ops);
});

// Entries in a cache root that are leftovers of a build (temporary or stale).
function leftovers(root: string): string[] {
  return readdirSync(root).filter(
    (n) => n.startsWith('.tmp-') || n.includes('.stale-')
  );
}

test('a stale directory without a marker is replaced by a complete one', async () => {
  const root = mkdtempSync(join(tmp, 'stale-'));
  const plan = generateFixture(tinySpec());
  const final = join(root, manifestHash(plan));
  mkdirSync(final);
  writeFileSync(join(final, 'junk'), 'half written');
  expect(await fixtureDir(plan, { cacheRoot: root })).toBe(final);
  expect(readFileSync(join(final, '.complete'), 'utf8')).toBe(
    manifestHash(plan)
  );
  expect(existsSync(join(final, 'junk'))).toBe(false);
  expect(leftovers(root)).toEqual([]);
});

test('losing the publish race keeps the winner and discards the temp build', async () => {
  const root = mkdtempSync(join(tmp, 'race-'));
  const plan = generateFixture(tinySpec());
  const final = join(root, manifestHash(plan));
  const dir = await fixtureDir(plan, {
    cacheRoot: root,
    beforePublish: () => {
      // Another process publishes the same fixture while this one builds.
      mkdirSync(final);
      writeFileSync(join(final, 'winner'), 'x');
      writeFileSync(join(final, '.complete'), manifestHash(plan));
    },
  });
  expect(dir).toBe(final);
  expect(existsSync(join(final, 'winner'))).toBe(true);
  expect(leftovers(root)).toEqual([]);
});

test('a build that throws leaves no temp directory and no final', async () => {
  const root = mkdtempSync(join(tmp, 'fail-'));
  const good = generateFixture(tinySpec());
  // Author 99 does not exist, so the first write throws mid-build.
  const bad = {
    ...good,
    steps: good.steps.map((s) =>
      s.kind === 'write' ? { ...s, author: 99 } : s
    ),
  };
  let failed = false;
  try {
    await fixtureDir(bad, { cacheRoot: root });
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  expect(readdirSync(root)).toEqual([]);
});

test('landing an already-landed view is a no-op, not an error', async () => {
  const plan = generateFixture(tinySpec());
  const land = plan.steps.find((s) => s.kind === 'land')!;
  const again = { ...plan, steps: [...plan.steps, land, land] };
  const repo = await materializeFixture(again, new MemoryBackend());
  expect(repo.log.ops()).toHaveLength(plan.spec.ops);
});
