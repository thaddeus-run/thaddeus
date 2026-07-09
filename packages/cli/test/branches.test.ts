import { ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/run';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-branch-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const srv = createServer({ backend: new MemoryBackend() });
const fetchImpl = srv.fetch.bind(srv);

const env = (home: string, cwd: string, out: (l: string) => void) => ({
  cwd,
  home,
  fetchImpl,
  out,
});
const quiet = (home: string, cwd: string) => env(home, cwd, () => {});

describe('branches as workspaces (copy-on-write, shared store)', () => {
  test('branch → workspace → push on branch → land into main', async () => {
    const home = mkdtempSync(join(tmp, 'home-'));
    const dir = join(tmp, 'work');
    await run(['init'], quiet(home, tmp));
    await run(['create', 'proj', '--server', 'http://t'], quiet(home, tmp));
    await run(['clone', 'proj', dir, '--server', 'http://t'], quiet(home, tmp));

    // Land a file on main.
    writeFileSync(join(dir, 'a.txt'), 'base');
    expect(await run(['push', '-m', 'a'], quiet(home, dir))).toBe(0);

    // Create a branch at main's heads — no ops, just a name over a head-set.
    const made: string[] = [];
    expect(
      await run(
        ['branch', 'feature'],
        env(home, dir, (l) => made.push(l))
      )
    ).toBe(0);
    expect(made.join('\n')).toContain('created branch feature');

    // It shows up in the listing; land's internal views never leak.
    const listed: string[] = [];
    await run(
      ['branch', '--json'],
      env(home, dir, (l) => listed.push(l))
    );
    const info = JSON.parse(listed[0]) as {
      current: string;
      branches: string[];
    };
    expect(info.current).toBe('main');
    expect(info.branches.sort()).toEqual(['feature', 'main']);
    expect(info.branches.some((b) => b.startsWith('land/'))).toBe(false);

    // Open the branch as a WORKSPACE (default sibling dir): a second working
    // copy over the SAME store — no store copy, origin untouched.
    const wsDir = join(tmp, 'work-feature');
    const opened: string[] = [];
    expect(
      await run(
        ['workspace', 'feature'],
        env(home, dir, (l) => opened.push(l))
      )
    ).toBe(0);
    expect(opened.join('\n')).toContain('copy-on-write');
    expect(readFileSync(join(wsDir, 'a.txt'), 'utf8')).toBe('base');
    // Copy-on-write means NO second object store on disk…
    expect(existsSync(join(wsDir, '.thaddeus', 'store'))).toBe(false);
    // …just a config pointing at the origin's store.
    const wsCfg = JSON.parse(
      readFileSync(join(wsDir, '.thaddeus', 'config.json'), 'utf8')
    ) as { view: string; store?: string };
    expect(wsCfg.view).toBe('feature');
    expect(wsCfg.store).toBe(join(dir, '.thaddeus', 'store'));

    const st: string[] = [];
    await run(
      ['status'],
      env(home, wsDir, (l) => st.push(l))
    );
    expect(st.join('\n')).toContain('on branch feature');

    // Work in the workspace: it lands on `feature`; the origin (main) tree and
    // dirty-state are never touched — no hijack, no clean-tree gate.
    writeFileSync(join(dir, 'wip.txt'), 'uncommitted on main'); // origin dirty!
    writeFileSync(join(wsDir, 'b.txt'), 'work');
    expect(await run(['push', '-m', 'b'], quiet(home, wsDir))).toBe(0);
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);

    // The SAME branch can be open in a second workspace at once — the thing
    // git worktrees forbid.
    const ws2 = join(tmp, 'work-feature-2');
    expect(await run(['workspace', 'feature', ws2], quiet(home, dir))).toBe(0);
    expect(readFileSync(join(ws2, 'b.txt'), 'utf8')).toBe('work');

    // Land the branch into main from the origin (clean it first — landing
    // re-points the origin's tree, so it uses the clean/not-ahead gate).
    rmSync(join(dir, 'wip.txt'));
    const landed: string[] = [];
    expect(
      await run(
        ['land', 'feature'],
        env(home, dir, (l) => landed.push(l))
      )
    ).toBe(0);
    expect(landed.join('\n')).toContain('landed feature into main');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('work');
  });

  test('guards: duplicate, reserved, self-land, nested workspace, stubs', async () => {
    const home = mkdtempSync(join(tmp, 'guard-'));
    const dir = join(tmp, 'guard-work');
    await run(['init'], quiet(home, tmp));
    await run(['create', 'g', '--server', 'http://t'], quiet(home, tmp));
    await run(['clone', 'g', dir, '--server', 'http://t'], quiet(home, tmp));
    writeFileSync(join(dir, 'x.txt'), 'x');
    await run(['push', '-m', 'x'], quiet(home, dir));

    expect(await run(['branch', 'dup'], quiet(home, dir))).toBe(0);
    // Creating it again is a conflict (re-pointing must go through `land`).
    const dup: string[] = [];
    expect(
      await run(
        ['branch', 'dup'],
        env(home, dir, (l) => dup.push(l))
      )
    ).toBe(1);
    expect(dup.join('\n')).toContain('already exists');

    // `land/` is reserved for land's internal dry-run views.
    const reserved: string[] = [];
    expect(
      await run(
        ['branch', 'land/sneaky'],
        env(home, dir, (l) => reserved.push(l))
      )
    ).toBe(1);
    expect(reserved.join('\n')).toContain('reserved');

    // Landing the current branch into itself is meaningless.
    const self: string[] = [];
    expect(
      await run(
        ['land', 'main'],
        env(home, dir, (l) => self.push(l))
      )
    ).toBe(2);
    expect(self.join('\n')).toContain('itself');

    // A workspace inside a working copy would be tracked as working files.
    const nested: string[] = [];
    expect(
      await run(
        ['workspace', 'dup', join(dir, 'inner')],
        env(home, dir, (l) => nested.push(l))
      )
    ).toBe(2);
    expect(nested.join('\n')).toContain('sibling');

    // A branch that doesn't exist points you at `branch`.
    const missing: string[] = [];
    expect(
      await run(
        ['workspace', 'ghost', join(tmp, 'ghost-ws')],
        env(home, dir, (l) => missing.push(l))
      )
    ).toBe(1);
    expect(missing.join('\n')).toContain('thaddeus branch ghost');

    // The git-shaped verbs teach the model instead of performing it.
    const co: string[] = [];
    expect(
      await run(
        ['checkout', 'dup'],
        env(home, dir, (l) => co.push(l))
      )
    ).toBe(2);
    expect(co.join('\n')).toContain('workspace');
    const mg: string[] = [];
    expect(
      await run(
        ['merge', 'dup'],
        env(home, dir, (l) => mg.push(l))
      )
    ).toBe(2);
    expect(mg.join('\n')).toContain('land');
  });
});
