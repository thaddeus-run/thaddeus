import { ready } from '@thaddeus.run/identity';
import { FileBackend } from '@thaddeus.run/persist';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import { cliCommand, timeCli, writeCliHome } from '../src/e2e/home';
import { seededRoot } from '../src/e2e/seed';
import { startServe } from '../src/e2e/serve';
import { applyEdit, editPaths, mainTree } from '../src/everyday/tree';
import { thadWorkingCopy, UNUSED_SERVER } from '../src/everyday/workcopy';
import { COMPLETE, linkCopy, WORK_ROOT } from '../src/fixtures/cache';
import { generateFixture } from '../src/fixtures/plan';
import { resolveFixture } from '../src/fixtures/spec';

const BIN = join(
  import.meta.dir,
  '..',
  '..',
  'packages',
  'cli',
  'src',
  'bin.ts'
);

// The CLI from source, so the test needs no `cli:compile`.
process.env.BENCH_CLI = `${process.execPath} ${BIN}`;
const cli = cliCommand();

const plan = generateFixture(resolveFixture('small-serial'));

let tmp: string;
let home: string;
let copy: string;
beforeAll(async () => {
  await ready();
  mkdirSync(WORK_ROOT, { recursive: true });
  tmp = mkdtempSync(join(WORK_ROOT, 'everyday-workcopy-test-'));
  home = join(tmp, 'owner');
  writeCliHome(home, plan.authorSeeds[0]);
  copy = join(tmp, 'wc');
  await thadWorkingCopy(plan, copy);
}, 300_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Relative POSIX paths of every file under `dir`, sorted, leaving out the
// `.thaddeus` metadata directory.
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.thaddeus') walk(full);
      } else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

// Runs the CLI as the owner inside the working copy and returns its exit code
// and stdout, because `timeCli` reports only a time.
async function run(
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([...cli, ...args], {
    cwd: copy,
    env: { ...process.env, HOME: home },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test('the working copy holds main byte for byte and status reads it clean', async () => {
  const tree = mainTree(plan);
  expect(listFiles(copy)).toEqual([...tree.keys()].sort());
  for (const [path, bytes] of tree) {
    const onDisk = readFileSync(join(copy, path));
    expect(Buffer.from(bytes).equals(onDisk)).toBe(true);
  }

  const config = JSON.parse(
    readFileSync(join(copy, '.thaddeus', 'config.json'), 'utf8')
  );
  expect(config.server).toBe(UNUSED_SERVER);

  const status = await run(['status', '--json']);
  expect(status.code).toBe(0);
  const parsed = JSON.parse(status.stdout);
  expect(parsed).toMatchObject({
    branch: 'main',
    clean: true,
    added: [],
    modified: [],
    deleted: [],
    ahead: 0,
    skipped: [],
  });
}, 300_000);

test('after the edit, status lists exactly the edited paths and diff mentions each', async () => {
  const paths = editPaths(plan);
  applyEdit(copy, paths);

  const status = await run(['status', '--json']);
  expect(status.code).toBe(0);
  const parsed = JSON.parse(status.stdout);
  expect(parsed.clean).toBe(false);
  expect(parsed.modified).toHaveLength(paths.length);
  expect(new Set(parsed.modified)).toEqual(new Set(paths));
  expect(parsed.added).toEqual([]);
  expect(parsed.deleted).toEqual([]);
  expect(parsed.ahead).toBe(0);

  const diff = await run(['diff']);
  expect(diff.code).toBe(0);
  for (const path of paths) expect(diff.stdout).toContain(path);
}, 300_000);

// Every key in a store, from its backend root.
async function keysOf(store: string): Promise<readonly string[]> {
  return new FileBackend(store).list('');
}

// The record kinds a store holds (`op`, `obj`, `cap`, `view`, `head`, ...):
// the segment after `repo/<name>/` in each key, de-duplicated and sorted.
function kindsOf(keys: readonly string[]): string[] {
  return [...new Set(keys.map((key) => key.split('/')[2]))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
}

test('the built copy matches a real clone of the seeded server', async () => {
  const root = join(tmp, 'server');
  await linkCopy(await seededRoot(plan), root);
  rmSync(join(root, COMPLETE), { force: true });
  const serve = await startServe({ cli, root, flags: [] });
  const cloned = join(tmp, 'clone');
  try {
    await timeCli(cli, ['clone', 'bench', cloned, '--server', serve.url], {
      home,
      cwd: tmp,
    });
  } finally {
    await serve.stop();
  }

  // A fresh copy, since the edit test above dirtied `copy`.
  const fresh = join(tmp, 'fresh');
  await thadWorkingCopy(plan, fresh);
  const statusIn = async (cwd: string) => {
    const proc = Bun.spawn([...cli, 'status', '--json'], {
      cwd,
      env: { ...process.env, HOME: home },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    return JSON.parse(stdout) as { clean: boolean };
  };
  const [fromClone, fromCopy] = [await statusIn(cloned), await statusIn(fresh)];
  expect(fromCopy).toEqual(fromClone);
  expect(fromCopy.clean).toBe(true);

  const cloneKeys = await keysOf(join(cloned, '.thaddeus', 'store'));
  const copyKeys = await keysOf(join(fresh, '.thaddeus', 'store'));
  expect(kindsOf(copyKeys)).toEqual(kindsOf(cloneKeys));
  expect(kindsOf(copyKeys)).toContain('head');
  const heads = (keys: readonly string[]) =>
    keys.filter((key) => /^repo\/bench\/(head|view)\//.test(key)).sort();
  expect(heads(copyKeys)).toEqual(heads(cloneKeys));

  // Signing is deterministic, so the owner's head chain is byte-identical.
  const cloneBackend = new FileBackend(join(cloned, '.thaddeus', 'store'));
  const copyBackend = new FileBackend(join(fresh, '.thaddeus', 'store'));
  for (const key of heads(copyKeys).filter((k) => k.includes('/head/'))) {
    const [a, b] = [await cloneBackend.get(key), await copyBackend.get(key)];
    expect(a).toBeDefined();
    expect(Buffer.from(b ?? []).equals(Buffer.from(a ?? []))).toBe(true);
  }
}, 300_000);
