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

describe('branches (copy-on-write views)', () => {
  test('branch, checkout, push on a branch, and merge back', async () => {
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

    // It shows up in the listing, with main marked current.
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
    // land's internal dry-run views must never leak into the branch list.
    expect(info.branches.some((b) => b.startsWith('land/'))).toBe(false);

    // Switch to it; the base file is still there.
    expect(await run(['checkout', 'feature'], quiet(home, dir))).toBe(0);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('base');
    const st: string[] = [];
    await run(
      ['status'],
      env(home, dir, (l) => st.push(l))
    );
    expect(st.join('\n')).toContain('on branch feature');

    // Work on the branch: it lands on `feature`, leaving main untouched.
    writeFileSync(join(dir, 'b.txt'), 'work');
    expect(await run(['push', '-m', 'b'], quiet(home, dir))).toBe(0);

    // Back on main, the branch's file is gone from the tree.
    expect(await run(['checkout', 'main'], quiet(home, dir))).toBe(0);
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('base');

    // Merge the branch into main, under policy.
    const merged: string[] = [];
    expect(
      await run(
        ['merge', 'feature'],
        env(home, dir, (l) => merged.push(l))
      )
    ).toBe(0);
    expect(merged.join('\n')).toContain('merged feature into main');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('work');
  });

  test('branch guards: duplicate, reserved name, and self-merge', async () => {
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

    const self: string[] = [];
    expect(
      await run(
        ['merge', 'main'],
        env(home, dir, (l) => self.push(l))
      )
    ).toBe(2);
    expect(self.join('\n')).toContain('itself');
  });
});
