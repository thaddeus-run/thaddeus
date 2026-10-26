import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type BenchRun, validateRun } from '../src/result';

// The everyday suite through the real `bench run` command on tiny: the
// working-copy cases run the thaddeus CLI and the git cases run git, in case
// children, after the suite pre-builds the caches they need.

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const BIN = join(
  import.meta.dir,
  '..',
  '..',
  'packages',
  'cli',
  'src',
  'bin.ts'
);

// The thaddeus CLI from source, so the test needs no `cli:compile`. Case
// children inherit it through the environment.
process.env.BENCH_CLI = `${process.execPath} ${BIN}`;

// Building the tiny caches and starting a few dozen processes.
const SLOW = 300_000;

const scratch = mkdtempSync(join(tmpdir(), 'bench-everyday-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Runs `bun src/cli.ts <args>` and returns its exit code and output.
async function bench(args: string[]) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

test(
  'run --suite everyday on tiny finishes every case ok',
  async () => {
    const out = join(scratch, 'everyday-tiny.json');
    const { code, stderr } = await bench([
      'run',
      '--suite',
      'everyday',
      '--fixtures',
      'tiny',
      '--repeats',
      '1',
      '--warmup',
      '0',
      '--out',
      out,
    ]);
    expect(stderr).toContain('tiny-serial git repository');
    expect(code).toBe(0);
    const run = JSON.parse(readFileSync(out, 'utf8')) as BenchRun;
    expect(validateRun(run)).toEqual([]);
    expect(run.cases.map((c) => [c.id, c.suite, c.fixture, c.status])).toEqual(
      [
        'wc.status',
        'wc.diff',
        'wc.status.agents8',
        'wc.diff.agents8',
        'git.status',
        'git.diff',
        'git.status.agents8',
        'git.diff.agents8',
      ].map((id) => [id, 'everyday', 'tiny-serial', 'ok'])
    );
    for (const c of run.cases) expect(c.p50Ms).toBeGreaterThan(0);
  },
  SLOW
);

test(
  'run --only builds and runs only the matching cases',
  async () => {
    const out = join(scratch, 'only-git.json');
    const { code, stderr } = await bench([
      'run',
      '--suite',
      'everyday',
      '--fixtures',
      'tiny',
      '--repeats',
      '1',
      '--warmup',
      '0',
      '--only',
      'git.status,git.diff',
      '--out',
      out,
    ]);
    expect(code).toBe(0);
    // The git cases need only the git cache, not the fixture root.
    expect(stderr).toContain('fixture tiny-serial git repository');
    expect(stderr).not.toContain('fixture tiny-serial\n');
    const run = JSON.parse(readFileSync(out, 'utf8')) as BenchRun;
    expect(run.cases.map((c) => [c.id, c.status])).toEqual([
      ['git.status', 'ok'],
      ['git.diff', 'ok'],
    ]);
  },
  SLOW
);

test(
  'fixture --git prints the bare repository and refuses --server',
  async () => {
    const built = await bench(['fixture', 'tiny-serial', '--git']);
    expect(built.code).toBe(0);
    const path = built.stdout.trim();
    expect(path.endsWith('bench.git')).toBe(true);
    expect(existsSync(join(path, 'HEAD'))).toBe(true);
    const refused = await bench([
      'fixture',
      'tiny-serial',
      '--git',
      '--server',
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--git takes no --repos or --server');
  },
  SLOW
);
