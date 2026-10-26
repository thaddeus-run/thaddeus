import { afterAll, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CaseContext } from '../src/case';
import everydayCases from '../src/everyday/cases';
import { gitFixture, timeGit } from '../src/everyday/git';
import { WORK_ROOT } from '../src/fixtures/cache';
import { generateFixture } from '../src/fixtures/plan';
import { resolveFixture } from '../src/fixtures/spec';
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
        'git.commit',
        'git.worktree',
        'git.pull',
        'git.clone',
      ].map((id) => [id, 'everyday', 'tiny-serial', 'ok'])
    );
    for (const c of run.cases) expect(c.p50Ms).toBeGreaterThan(0);
    const byId = (id: string) => run.cases.find((c) => c.id === id);
    // No everyday result carries the FileBackend label, and only git.clone is
    // cold.
    for (const c of run.cases) expect(c.durability).toBeUndefined();
    expect(byId('git.clone')?.pageCache).toBe('warm');
    expect(byId('git.worktree')?.pageCache).toBeUndefined();
    for (const id of ['git.commit', 'git.worktree', 'git.pull', 'git.clone']) {
      expect(byId(id)?.samplesMs).toHaveLength(1);
    }
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

// Runs one case's setup and timed run by hand in a fresh work directory, as
// its per-sample child does, and returns the directory.
async function runByHand(id: string): Promise<string> {
  const found = everydayCases.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  mkdirSync(WORK_ROOT, { recursive: true });
  const workDir = mkdtempSync(join(WORK_ROOT, 'everyday-case-test-'));
  scratchDirs.push(workDir);
  const ctx: CaseContext = {
    plan: generateFixture(resolveFixture('tiny-serial')),
    fixture: 'tiny-serial',
    workDir,
    pageCache: 'warm',
  };
  await found.run(await found.setup(ctx), ctx);
  return workDir;
}

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

// Runs `git <args>` in `cwd` and returns its trimmed stdout.
async function gitOut(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${err}`);
  return out.trim();
}

const tinyPlan = () => generateFixture(resolveFixture('tiny-serial'));

test(
  'git.commit pushes a 10-file commit on a new branch to its own copy of the remote',
  async () => {
    const cached = await gitFixture(tinyPlan());
    const before = await gitOut(cached, ['for-each-ref']);
    const workDir = await runByHand('git.commit');
    const remote = join(workDir, 'remote.git');
    expect(
      await gitOut(remote, ['log', '-1', '--format=%s', 'bench-push'])
    ).toBe('bench');
    const changed = await gitOut(remote, [
      'ls-tree',
      '--name-only',
      'bench-push',
      'bench-change/',
    ]);
    expect(changed.split('\n')).toHaveLength(10);
    // The push reached the work directory's copy, not the cached repository.
    expect(await gitOut(cached, ['for-each-ref'])).toBe(before);
    expect(before).not.toContain('bench-push');
  },
  SLOW
);

test(
  'git.worktree opens the branch in a new directory with the fixture files',
  async () => {
    const workDir = await runByHand('git.worktree');
    const ws = join(workDir, 'ws');
    expect(await gitOut(ws, ['branch', '--show-current'])).toBe('bench-ws');
    expect(readdirSync(join(ws, 'src')).length).toBeGreaterThan(0);
  },
  SLOW
);

test(
  'git.pull fast-forwards the reader onto the 10-file commit',
  async () => {
    const workDir = await runByHand('git.pull');
    const reader = join(workDir, 'reader-clone');
    expect(readdirSync(join(reader, 'bench-change'))).toHaveLength(10);
    expect(await gitOut(reader, ['rev-parse', 'HEAD'])).toBe(
      await gitOut(join(workDir, 'remote.git'), ['rev-parse', 'main'])
    );
  },
  SLOW
);

test(
  'git.clone makes a depth-1 checkout',
  async () => {
    const workDir = await runByHand('git.clone');
    const checkout = join(workDir, 'checkout');
    expect(await gitOut(checkout, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(existsSync(join(checkout, '.git', 'shallow'))).toBe(true);
  },
  SLOW
);

test('a failed timed git command is an error, never a sample', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-everyday-fail-'));
  scratchDirs.push(dir);
  // Caught and then asserted, so the assertion always runs.
  let message = 'timeGit resolved';
  try {
    await timeGit(['pull', '-q', '--ff-only'], { home: dir, cwd: dir });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(/exited with code/);
});
