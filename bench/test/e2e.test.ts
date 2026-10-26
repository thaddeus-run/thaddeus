import { Identity, ready } from '@thaddeus.run/identity';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import e2eCases from '../src/e2e/cases';
import { cliCommand, timeCli, writeCliHome } from '../src/e2e/home';
import { seededRoot } from '../src/e2e/seed';
import { startServe } from '../src/e2e/serve';
import { fixtureDir, WORK_ROOT } from '../src/fixtures/cache';
import { generateFixture } from '../src/fixtures/plan';
import { tinySpec } from '../src/fixtures/spec';
import { registryFor } from '../src/record';
import { FILEBACKEND_DURABILITY } from '../src/result';
import { runCase } from '../src/runner';

const E2E = join(import.meta.dir, '..', 'src', 'e2e', 'cases.ts');
const BIN = join(
  import.meta.dir,
  '..',
  '..',
  'packages',
  'cli',
  'src',
  'bin.ts'
);

// The CLI from source, so the tests need no `cli:compile`. Case children
// inherit it through the environment.
process.env.BENCH_CLI = `${process.execPath} ${BIN}`;
const cli = cliCommand();

// Every e2e step starts real processes; the first test also seeds the tiny
// server root. On small, `land` alone takes about 20 s today.
const SLOW = 120_000;
const SMALL = 300_000;

const tinyPlan = generateFixture(tinySpec());

let tmp: string;
let ownerHome: string;
beforeAll(async () => {
  await ready();
  mkdirSync(WORK_ROOT, { recursive: true });
  tmp = mkdtempSync(join(WORK_ROOT, 'e2e-test-'));
  ownerHome = join(tmp, 'owner');
  writeCliHome(ownerHome, tinyPlan.authorSeeds[0]);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Every file under `dir` as a sorted [path, size, sha256] list, so a test can
// prove that nothing in the tree was created, removed or changed.
function snapshotTree(dir: string): [string, number, string][] {
  const out: [string, number, string][] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      out.push([
        relative(dir, path),
        statSync(path).size,
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      ]);
    }
  };
  walk(dir);
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

test(
  'seeded root serves a cloneable repo',
  async () => {
    const srv = await startServe({
      cli,
      root: await seededRoot(tinyPlan),
      flags: [],
    });
    try {
      const dir = join(tmp, 'clone');
      await timeCli(cli, ['clone', 'bench', dir, '--server', srv.url], {
        home: ownerHome,
        cwd: tmp,
      });
      const files = readdirSync(join(dir, 'src'));
      expect(files.filter((f) => f.endsWith('.ts')).length).toBeGreaterThan(0);
    } finally {
      await srv.stop();
    }
  },
  SLOW
);

test(
  'seeding reads the fixture cache without changing it',
  async () => {
    const cached = await fixtureDir(tinyPlan);
    const before = snapshotTree(cached);
    const cacheRoot = join(tmp, 'seed-cache');
    const root = await seededRoot(tinyPlan, { cacheRoot });
    expect(readFileSync(join(root, '.complete'), 'utf8')).not.toBe('');
    expect(snapshotTree(cached)).toEqual(before);
  },
  SLOW
);

test('writeCliHome writes an identity the CLI reads', async () => {
  const home = join(tmp, 'whoami');
  const seed = new Uint8Array(32).fill(9);
  writeCliHome(home, seed);
  const proc = Bun.spawn([...cli, 'whoami'], {
    env: { ...process.env, HOME: home },
    stdout: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out).toContain(Identity.fromSeed(seed).did);
});

test('timeCli throws with the output on a non-zero exit', async () => {
  const promise = timeCli(cli, ['pull'], { home: ownerHome, cwd: tmp });
  expect(promise).rejects.toThrow(/thaddeus pull exited with code 2/);
  await promise.catch(() => {});
});

for (const id of ['e2e.checkout.cold', 'e2e.push.10', 'e2e.repo.create']) {
  test(
    `${id} runs`,
    async () => {
      const seeded = snapshotTree(await seededRoot(tinyPlan));
      const r = await runCase(id, 'tiny', {
        repeats: 2,
        warmup: 0,
        budgetMs: 120_000,
        registry: E2E,
      });
      expect(r.status).toBe('ok');
      expect(r.samplesMs).toHaveLength(2);
      expect(r.serveFlags).toEqual([]);
      if (id !== 'e2e.checkout.cold') {
        expect(r.durability).toBe(FILEBACKEND_DURABILITY);
      } else {
        expect(r.durability).toBeUndefined();
        expect(r.pageCache).toBe('warm');
      }
      // The case's server wrote into a hard-link copy, never the cache.
      expect(snapshotTree(await seededRoot(tinyPlan))).toEqual(seeded);
    },
    SLOW
  );
}

// tiny's main holds one conflict the generator landed on purpose. The shipped
// serve refuses every land into a view with a conflict (`blockOnConflict`),
// and there is no serve flag for another policy, so pull and land cannot get
// their change landed there. That is a result, reported in setup.
for (const id of ['e2e.pull', 'e2e.land']) {
  test(
    `${id} on tiny reports the land the default policy refuses`,
    async () => {
      const r = await runCase(id, 'tiny', {
        repeats: 1,
        warmup: 0,
        budgetMs: 120_000,
        registry: E2E,
      });
      expect(r.status).toBe('error');
      expect(r.phase).toBe('setup');
      expect(r.note).toContain('not landed: 1 conflict(s)');
    },
    SLOW
  );
}

// small's main is one view with no conflicts, so the change set lands.
for (const id of ['e2e.pull', 'e2e.land']) {
  test(
    `${id} runs on small`,
    async () => {
      const r = await runCase(id, 'small', {
        repeats: 1,
        warmup: 0,
        budgetMs: SMALL,
        registry: E2E,
      });
      expect(r.status).toBe('ok');
      expect(r.samplesMs).toHaveLength(1);
      expect(r.serveFlags).toEqual([]);
      if (id === 'e2e.land') expect(r.durability).toBe(FILEBACKEND_DURABILITY);
      else expect(r.durability).toBeUndefined();
    },
    SMALL
  );
}

test(
  'repos-per-minute records its raised limits',
  async () => {
    const r = await runCase('e2e.repos-per-minute', 'tiny', {
      repeats: 1,
      warmup: 0,
      budgetMs: 120_000,
      registry: E2E,
      durationMs: 3_000,
    });
    expect(r.status).toBe('ok');
    expect(r.throughput?.unit).toBe('repos/min');
    expect(r.throughput?.value).toBeGreaterThan(0);
    expect(r.serveFlags).toContain('--repository-creation-limit');
    expect(r.serveFlags).toContain('--max-repositories');
    expect(r.durability).toBe(FILEBACKEND_DURABILITY);
  },
  SLOW
);

test('repo.create caps its timed repeats under the hourly creation limit', () => {
  const create = e2eCases.find((c) => c.id === 'e2e.repo.create');
  expect(create?.maxRepeats).toBe(15);
});

test('stress and medium raise only the limits their pushes hit', () => {
  const flags = (id: string, fixture: string) =>
    e2eCases.find((c) => c.id === id)?.serveFlags?.(fixture);
  expect(flags('e2e.push.10', 'small')).toEqual([]);
  expect(flags('e2e.push.10', 'medium')).toEqual([
    '--max-request-body-bytes',
    '1073741824',
  ]);
  expect(flags('e2e.push.10', 'stress')).toEqual([
    '--max-objects',
    '10000000',
    '--max-request-body-bytes',
    '1073741824',
  ]);
  expect(flags('e2e.checkout.cold', 'medium')).toEqual([]);
  expect(flags('e2e.checkout.cold', 'stress')).toEqual([
    '--max-objects',
    '10000000',
  ]);
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
  }
});
