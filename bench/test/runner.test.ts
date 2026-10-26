import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateFixture, manifestHash } from '../src/fixtures/plan';
import { FIXTURES } from '../src/fixtures/spec';
import {
  type BenchRun,
  FILEBACKEND_DURABILITY,
  validateRun,
} from '../src/result';
import { runCase, runSweep, SWEEP_SIZES } from '../src/runner';

const FAKES = join(import.meta.dir, 'fixtures', 'fake-cases.ts');
const o = { repeats: 5, warmup: 1, budgetMs: 1_000, registry: FAKES };

// Each test spawns real Bun children; a budget kill alone takes a second.
const SLOW = 20_000;

const probeDir = mkdtempSync(join(tmpdir(), 'bench-runner-test-'));
afterAll(() => rmSync(probeDir, { recursive: true, force: true }));

// Points FAKE_PROBE_FILE at a fresh file and returns its path. Children
// inherit the parent's environment, so the fake case writes there.
function probe(name: string): string {
  const file = join(probeDir, name);
  process.env.FAKE_PROBE_FILE = file;
  return file;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Waits up to `ms` for `pid` to disappear. A killed orphan stays visible as a
// zombie until init reaps it, which can lag on a loaded machine.
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (alive(pid)) {
    if (performance.now() > deadline) return false;
    await Bun.sleep(20);
  }
  return true;
}

test('SWEEP_SIZES doubles from 1k to 256k ops', () => {
  expect(SWEEP_SIZES).toEqual([
    1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000,
  ]);
});

test(
  'an ok case records every timed sample and its summary',
  async () => {
    const ok = await runCase('fake.ok', 'small', o);
    expect(ok.status).toBe('ok');
    expect(ok.samplesMs).toHaveLength(5);
    expect(ok.p50Ms).not.toBeNull();
    expect(ok.p95Ms).not.toBeNull();
    expect(ok.cv).not.toBeNull();
    expect(ok.peakRssBytes).toBeGreaterThan(0);
    expect(ok.fixture).toBe('small');
    expect(ok.manifestHash).toBe(manifestHash(generateFixture(FIXTURES.small)));
    expect(ok.version).toBe(1);
    expect(ok.suite).toBe('library');
    expect(ok.repeats).toBe(5);
    expect(ok.warmup).toBe(1);
    expect(ok.budgetMs).toBe(1_000);
    expect(ok.phase).toBeUndefined();
    expect(ok.note).toBeUndefined();
    expect(ok.throughput).toBeUndefined();
    expect(ok.durability).toBeUndefined();
    expect(ok.pageCache).toBeUndefined();
  },
  SLOW
);

test(
  'a run past the budget is killed and recorded as exceeded in run',
  async () => {
    const started = performance.now();
    const slow = await runCase('fake.sleep', 'small', o);
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(slow.status).toBe('exceeded');
    expect(slow.phase).toBe('run');
    expect(slow.note).toContain('exceeded 1000 ms');
    expect(slow.note).toBe('exceeded 1000 ms at n = 1000');
    expect(slow.failedAtN).toBe(1_000);
    expect(slow.samplesMs).toEqual([]);
    expect(slow.p50Ms).toBeNull();
  },
  SLOW
);

test(
  'a setup past the budget is recorded with phase setup',
  async () => {
    const r = await runCase('fake.setup-sleep', 'small', o);
    expect(r.status).toBe('exceeded');
    expect(r.phase).toBe('setup');
  },
  SLOW
);

test(
  'peak RSS covers memory the case holds',
  async () => {
    const r = await runCase('fake.alloc', 'small', o);
    expect(r.status).toBe('ok');
    expect(r.peakRssBytes).toBeGreaterThan(64 * 1024 * 1024);
  },
  SLOW
);

test(
  'a throwing case is an error whose note is the stderr tail',
  async () => {
    const bad = await runCase('fake.throw', 'small', o);
    expect(bad.status).toBe('error');
    expect(bad.note).toContain('boom');
    expect(bad.phase).toBe('run');
    expect(Buffer.byteLength(bad.note ?? '')).toBeLessThanOrEqual(2_048);
  },
  SLOW
);

test(
  'a SIGKILL the runner did not send is recorded as oom',
  async () => {
    const r = await runCase('fake.sigkill', 'small', o);
    expect(r.status).toBe('oom');
    expect(r.note).toBe('oom at n = 1000');
    expect(r.failedAtN).toBe(1_000);
  },
  SLOW
);

test(
  'an out-of-memory message on stderr is recorded as oom',
  async () => {
    const r = await runCase('fake.heap', 'small', o);
    expect(r.status).toBe('oom');
    expect(r.note).toBe('oom at n = 1000');
  },
  SLOW
);

test(
  'a budget kill also kills processes the case started',
  async () => {
    const file = probe('orphan-pid');
    const r = await runCase('fake.orphan', 'small', o);
    expect(r.status).toBe('exceeded');
    const pid = Number(readFileSync(file, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(await goneWithin(pid, 2_000)).toBe(true);
  },
  SLOW
);

test(
  'per-sample cases spawn once per sample and run beforeSample first',
  async () => {
    let calls = 0;
    const r = await runCase('fake.cold-write', 'small', {
      ...o,
      repeats: 3,
      warmup: 1,
      budgetMs: 10_000,
      pageCache: 'dropped',
      beforeSample: () => {
        calls += 1;
        return Promise.resolve();
      },
    });
    expect(r.status).toBe('ok');
    expect(r.samplesMs).toHaveLength(3);
    expect(calls).toBe(4);
    expect(r.durability).toBe(FILEBACKEND_DURABILITY);
    expect(r.pageCache).toBe('dropped');
    const totalS = r.samplesMs.reduce((a, b) => a + b, 0) / 1_000;
    expect(r.throughput?.unit).toBe('MB/s');
    expect(r.throughput?.value).toBeCloseTo((3 * 2) / totalS, 6);
  },
  SLOW
);

test(
  'cold cases default to a warm page cache',
  async () => {
    const r = await runCase('fake.cold-write', 'small', {
      ...o,
      repeats: 1,
      warmup: 0,
      budgetMs: 10_000,
    });
    expect(r.pageCache).toBe('warm');
  },
  SLOW
);

test(
  'the case sees the fixture plan, page cache, durationMs and a workDir that is removed',
  async () => {
    const file = probe('workdir');
    const r = await runCase('fake.context', 'sweep-2000', {
      ...o,
      repeats: 1,
      warmup: 0,
      budgetMs: 10_000,
      pageCache: 'dropped',
      durationMs: 1_234,
    });
    expect(r.note).toBeUndefined();
    expect(r.status).toBe('ok');
    const workDir = readFileSync(file, 'utf8');
    expect(workDir.length).toBeGreaterThan(0);
    expect(existsSync(workDir)).toBe(false);
  },
  SLOW
);

// Waits until the fake has written its pid into `file`, then returns it.
async function pidFrom(file: string): Promise<number> {
  const deadline = performance.now() + 10_000;
  while (!existsSync(file) || readFileSync(file, 'utf8') === '') {
    if (performance.now() > deadline) throw new Error(`no pid in ${file}`);
    await Bun.sleep(20);
  }
  return Number(readFileSync(file, 'utf8'));
}

const DRIVER = join(import.meta.dir, 'fixtures', 'interrupt-driver.ts');

test(
  'a forwarded SIGINT rejects with Interrupted, not oom, and kills the group',
  async () => {
    const file = probe('interrupt-pid');
    const driver = Bun.spawn([process.execPath, DRIVER, 'signal'], {
      env: { ...process.env },
      stdout: 'pipe',
    });
    const orphan = await pidFrom(file);
    driver.kill('SIGINT');
    const out = await new Response(driver.stdout).text();
    await driver.exited;
    expect(JSON.parse(out)).toEqual({
      name: 'Interrupted',
      message: 'Interrupted: interrupted by SIGINT',
      sigints: 1,
    });
    expect(await goneWithin(orphan, 2_000)).toBe(true);
  },
  SLOW
);

test(
  'the parent exiting kills live child groups',
  async () => {
    const file = probe('exit-pid');
    const driver = Bun.spawn([process.execPath, DRIVER, 'exit'], {
      env: { ...process.env },
    });
    await driver.exited;
    expect(driver.exitCode).toBe(0);
    expect(await goneWithin(await pidFrom(file), 2_000)).toBe(true);
  },
  SLOW
);

test(
  'a grandchild holding the pipes open does not hang the runner',
  async () => {
    const file = probe('leaky-pid');
    const started = performance.now();
    const r = await runCase('fake.leaky', 'small', {
      ...o,
      repeats: 1,
      warmup: 0,
      budgetMs: 10_000,
    });
    const leak = await pidFrom(file);
    try {
      expect(r.status).toBe('ok');
      expect(r.samplesMs).toHaveLength(1);
      expect(performance.now() - started).toBeLessThan(6_000);
    } finally {
      process.kill(leak, 'SIGKILL');
    }
  },
  SLOW
);

test(
  'diskBytes from measure is the max over per-sample children',
  async () => {
    probe('disk-count');
    const r = await runCase('fake.disk', 'small', {
      ...o,
      repeats: 3,
      warmup: 0,
      budgetMs: 10_000,
    });
    expect(r.status).toBe('ok');
    expect(r.diskBytes).toBe(3_000);
    const none = await runCase('fake.ok', 'small', { ...o, repeats: 1 });
    expect(none.diskBytes).toBeUndefined();
  },
  SLOW
);

test(
  'serveFlags reach every result, maxRepeats and maxWarmup cap, note marks ok results',
  async () => {
    const ok = await runCase('fake.flags', 'small', o);
    expect(ok.status).toBe('ok');
    expect(ok.serveFlags).toEqual(['--fixture', 'small']);
    expect(ok.repeats).toBe(2);
    expect(ok.warmup).toBe(0);
    expect(ok.samplesMs).toHaveLength(2);
    expect(ok.note).toBe('a fixed remark');

    process.env.FAKE_FAIL_SETUP = '1';
    try {
      const failed = await runCase('fake.flags', 'small', o);
      expect(failed.status).toBe('error');
      expect(failed.phase).toBe('setup');
      expect(failed.serveFlags).toEqual(['--fixture', 'small']);
      expect(failed.note).toContain('setup failed');
    } finally {
      delete process.env.FAKE_FAIL_SETUP;
    }

    const ordinary = await runCase('fake.ok', 'small', o);
    expect(ordinary.serveFlags).toBeUndefined();
  },
  SLOW
);

test('an unknown case id or fixture name throws', async () => {
  const missing = await runCase('fake.missing', 'small', o).catch(String);
  expect(missing).toContain('no case fake.missing');
  const huge = await runCase('fake.ok', 'huge', o).catch(String);
  expect(huge).toContain('unknown fixture huge');
});

test(
  'a sweep fits a linear exponent and reports ops/s throughput per point',
  async () => {
    const sw = await runSweep('fake.linear', [1_000, 2_000, 4_000, 8_000], {
      ...o,
      repeats: 3,
    });
    expect(sw.status).toBe('ok');
    expect(sw.id).toBe('fake.linear');
    expect(sw.version).toBe(1);
    expect(sw.points.map((p) => p.n)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(sw.failedAtN).toBeUndefined();
    expect(sw.exponent!).toBeGreaterThan(0.7);
    expect(sw.exponent!).toBeLessThan(1.3);
    expect(sw.r2!).toBeGreaterThan(0.9);
  },
  SLOW
);

test(
  'a sweep stops at the first size that is not ok',
  async () => {
    const cut = await runSweep('fake.sleep', [1_000, 2_000], o);
    expect(cut.status).toBe('exceeded');
    expect(cut.failedAtN).toBe(1_000);
    expect(cut.points).toEqual([]);
    expect(cut.exponent).toBeNull();
    expect(cut.r2).toBeNull();
  },
  SLOW
);

test(
  'runner results validate against the result schema',
  async () => {
    const ok = await runCase('fake.cold-write', 'small', {
      ...o,
      repeats: 1,
      warmup: 0,
    });
    const bad = await runCase('fake.throw', 'small', o);
    const sweep = await runSweep('fake.ok', [1_000, 2_000, 4_000], {
      ...o,
      repeats: 1,
      warmup: 0,
    });
    const run: BenchRun = {
      schemaVersion: 1,
      commit: '0000000',
      dirty: false,
      suiteVersion: '1',
      recordedAt: '2026-10-25T00:00:00Z',
      machine: {
        id: 'test',
        description: 'test',
        cpu: 'test',
        vcpus: 1,
        memoryBytes: 1,
        virtualization: 'none',
        os: 'linux',
        bun: Bun.version,
        loadAvg1: 0,
        memAvailableBytes: 1,
      },
      method: {
        repeats: 1,
        warmup: 0,
        budgetMs: 1_000,
        isolation: 'subprocess',
      },
      cases: [ok, bad],
      sweeps: [sweep],
    };
    expect(validateRun(run)).toEqual([]);
  },
  SLOW
);
