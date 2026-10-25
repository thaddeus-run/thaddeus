import { FileBackend } from '@thaddeus.run/persist';
import { Platform } from '@thaddeus.run/platform';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fixtureDir, linkCopy } from '../src/fixtures/cache';
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
