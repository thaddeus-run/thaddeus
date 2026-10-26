import { Identity, ready } from '@thaddeus.run/identity';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import { cliCommand, timeCli, writeCliHome } from '../src/e2e/home';
import { seededRoot } from '../src/e2e/seed';
import { startServe } from '../src/e2e/serve';
import { fixtureDir, WORK_ROOT } from '../src/fixtures/cache';
import { generateFixture, manifestHash } from '../src/fixtures/plan';
import { serialSpec, tinySpec } from '../src/fixtures/spec';
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
// server root.
const SLOW = 120_000;

const tinyPlan = generateFixture(serialSpec(tinySpec()));

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
    expect(readFileSync(join(root, '.complete'), 'utf8')).toBe(
      manifestHash(tinyPlan)
    );
    expect(root).toBe(join(cacheRoot, `${manifestHash(tinyPlan)}-server-v1`));
    // The seed's expired nonces are gone, so no timed command loads them.
    expect(existsSync(join(root, '.replay-nonces-v1'))).toBe(false);
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

// Every case but repos per minute, on the serial variant of tiny. Its main
// holds no conflict, so pull and land get their change set landed under the
// shipped `blockOnConflict` policy.
for (const id of [
  'e2e.checkout.cold',
  'e2e.push.10',
  'e2e.pull',
  'e2e.land',
  'e2e.workspace',
  'e2e.repo.create',
]) {
  test(
    `${id} runs`,
    async () => {
      const seeded = snapshotTree(await seededRoot(tinyPlan));
      const r = await runCase(id, 'tiny-serial', {
        repeats: 2,
        warmup: 0,
        budgetMs: 120_000,
        registry: E2E,
      });
      expect(r.status).toBe('ok');
      expect(r.fixture).toBe('tiny-serial');
      expect(r.manifestHash).toBe(manifestHash(tinyPlan));
      expect(r.samplesMs).toHaveLength(2);
      expect(r.serveFlags).toEqual([]);
      if (
        id === 'e2e.checkout.cold' ||
        id === 'e2e.pull' ||
        id === 'e2e.workspace'
      ) {
        expect(r.durability).toBeUndefined();
      } else {
        expect(r.durability).toBe(FILEBACKEND_DURABILITY);
      }
      if (id === 'e2e.checkout.cold') {
        expect(r.pageCache).toBe('warm');
        expect(r.note).toContain("server's cold open of the repository");
      } else {
        expect(r.note).toBeUndefined();
      }
      // Only the checkout is cold: workspace's setup re-warms what it reads.
      if (id === 'e2e.workspace') expect(r.pageCache).toBeUndefined();
      // The case's server wrote into a hard-link copy, never the cache.
      expect(snapshotTree(await seededRoot(tinyPlan))).toEqual(seeded);
    },
    SLOW
  );
}

// The base tiny plan lands a conflict into main on purpose. The seed lands
// main under the shipped policy, so it refuses to build a root that a real
// server could never hold.
test(
  'seeding a plan whose main holds a conflict throws',
  async () => {
    const cacheRoot = join(tmp, 'conflicted-cache');
    const conflicted = generateFixture(tinySpec());
    expect(seededRoot(conflicted, { cacheRoot })).rejects.toThrow(
      /seeding land of main failed: 1 conflict\(s\)/
    );
    await seededRoot(conflicted, { cacheRoot }).catch(() => {});
    expect(existsSync(cacheRoot) ? readdirSync(cacheRoot) : []).toEqual([]);
  },
  SLOW
);

test(
  'repos-per-minute records its raised limits',
  async () => {
    const r = await runCase('e2e.repos-per-minute', 'tiny-serial', {
      repeats: 1,
      warmup: 2,
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
    // Its warm-ups are capped at 0, whatever the run asks for.
    expect(r.warmup).toBe(0);
  },
  SLOW
);
