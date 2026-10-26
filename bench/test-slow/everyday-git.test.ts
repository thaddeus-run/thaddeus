import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fastImportChunks,
  gitEnv,
  gitFixture,
  timeGit,
} from '../src/everyday/git';
import { mainTree } from '../src/everyday/tree';
import { generateFixture } from '../src/fixtures/plan';
import { resolveFixture } from '../src/fixtures/spec';

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bench-everyday-git-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Runs `git <args>` in `repo` and returns stdout as bytes.
async function git(repo: string, args: string[]): Promise<Uint8Array> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: repo,
    env: gitEnv(tmp),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [buffer, err, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${err}`);
  return new Uint8Array(buffer);
}

// The message of the error `run` rejects with, or fails if it resolves.
async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to reject');
}

for (const name of ['tiny-serial', 'small-serial']) {
  test(`${name}: the git replay holds main's tree, bytes and one commit per op`, async () => {
    const plan = generateFixture(resolveFixture(name));
    const repo = await gitFixture(plan, { cacheRoot: tmp });
    const tree = mainTree(plan);

    const listed = new TextDecoder()
      .decode(await git(repo, ['ls-tree', '-r', '--name-only', 'main']))
      .split('\n')
      .filter((line) => line !== '');
    expect(listed.sort()).toEqual([...tree.keys()].sort());

    for (const [path, bytes] of tree) {
      const blob = await git(repo, ['cat-file', 'blob', `main:${path}`]);
      expect(Buffer.from(blob).equals(Buffer.from(bytes))).toBe(true);
    }

    const ops = plan.steps.filter(
      (step) => step.kind === 'write' || step.kind === 'remove'
    ).length;
    const count = new TextDecoder().decode(
      await git(repo, ['rev-list', '--count', 'main'])
    );
    expect(Number(count.trim())).toBe(ops);
  }, 120_000);
}

test('a second gitFixture call reuses the cached repository', async () => {
  const plan = generateFixture(resolveFixture('tiny-serial'));
  const first = await gitFixture(plan, { cacheRoot: tmp });
  expect(await gitFixture(plan, { cacheRoot: tmp })).toBe(first);
  expect(first).toMatch(/-git-v1\/bench\.git$/);
});

test('a base plan is refused', async () => {
  const plan = generateFixture(resolveFixture('tiny'));
  expect(() => fastImportChunks(plan).next()).toThrow(/serial/);
  expect(await failureOf(() => gitFixture(plan, { cacheRoot: tmp }))).toMatch(
    /serial/
  );
});

test('timeGit times a command and throws with the output on failure', async () => {
  const ms = await timeGit(['--version'], { home: tmp, cwd: tmp });
  expect(ms).toBeGreaterThan(0);
  const message = await failureOf(() =>
    timeGit(['rev-parse', '--verify', 'nope'], { home: tmp, cwd: tmp })
  );
  expect(message).toMatch(/exited with code/);
});
