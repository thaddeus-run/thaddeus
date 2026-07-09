import { ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/run';
import { findRoot } from '../src/workcopy';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-findroot-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const srv = createServer({ backend: new MemoryBackend() });
const fetchImpl = srv.fetch.bind(srv);

describe('findRoot identifies a working copy by its config', () => {
  // install.sh installs the binaries into ~/.thaddeus/bin. If findRoot matched
  // the bare directory, every user's $HOME would look like a working copy.
  test("an installer's ~/.thaddeus/bin is not a working copy", () => {
    const home = mkdtempSync(join(tmp, 'home-'));
    mkdirSync(join(home, '.thaddeus', 'bin'), { recursive: true });
    writeFileSync(join(home, '.thaddeus', 'bin', 'thaddeus'), '#!/bin/sh\n');
    const nested = join(home, 'projects', 'notarepo');
    mkdirSync(nested, { recursive: true });

    expect(findRoot(home)).toBeUndefined();
    expect(findRoot(nested)).toBeUndefined();
  });

  test('a real working copy is found from a nested directory', () => {
    const root = mkdtempSync(join(tmp, 'copy-'));
    mkdirSync(join(root, '.thaddeus'), { recursive: true });
    writeFileSync(
      join(root, '.thaddeus', 'config.json'),
      JSON.stringify({ server: 'http://t', repo: 'r', base: [] })
    );
    const deep = join(root, 'src', 'nested');
    mkdirSync(deep, { recursive: true });
    expect(findRoot(deep)).toBe(root);
  });

  test('a repo command outside a working copy explains itself, not ENOENT', async () => {
    const home = mkdtempSync(join(tmp, 'h2-'));
    mkdirSync(join(home, '.thaddeus', 'bin'), { recursive: true });
    const out: string[] = [];
    const e = { cwd: home, home, fetchImpl, out: (l: string) => out.push(l) };
    await run(['init'], { ...e, out: () => {} });

    expect(await run(['status'], e)).toBe(2);
    expect(out.join('\n')).toContain('not a thaddeus working copy');
  });
});

describe('reputation is server-scoped, not repo-scoped', () => {
  test('works outside a working copy via the saved default server', async () => {
    const home = mkdtempSync(join(tmp, 'rep-'));
    // The installer directory must not make this look like a working copy.
    mkdirSync(join(home, '.thaddeus', 'bin'), { recursive: true });
    const out: string[] = [];
    const e = { cwd: home, home, fetchImpl, out: (l: string) => out.push(l) };
    await run(['init'], { ...e, out: () => {} });
    await run(['use', 'http://t'], { ...e, out: () => {} });

    out.length = 0;
    const did = 'did:key:z6MkjydYfM38y8PSRpkvxtyNvfyQj4GqEXrF79nvhUqRG7fC';
    expect(await run(['reputation', did], e)).toBe(0);
    expect(out.join('\n')).toContain('attested: 0');
  });

  test('an explicit --server overrides, and a bad url is rejected', async () => {
    const home = mkdtempSync(join(tmp, 'rep2-'));
    const out: string[] = [];
    const e = { cwd: home, home, fetchImpl, out: (l: string) => out.push(l) };
    await run(['init'], { ...e, out: () => {} });

    const did = 'did:key:z6MkjydYfM38y8PSRpkvxtyNvfyQj4GqEXrF79nvhUqRG7fC';
    expect(await run(['reputation', did, '--server', 'http://t'], e)).toBe(0);
    expect(out.join('\n')).toContain('attested: 0');

    out.length = 0;
    expect(await run(['reputation', did, '--server', 'not-a-url'], e)).toBe(2);
    expect(out.join('\n')).toContain('invalid --server');
  });

  test('with no server anywhere, it hints instead of crashing', async () => {
    const home = mkdtempSync(join(tmp, 'rep3-'));
    const out: string[] = [];
    const e = { cwd: home, home, fetchImpl, out: (l: string) => out.push(l) };
    await run(['init'], { ...e, out: () => {} });

    const did = 'did:key:z6MkjydYfM38y8PSRpkvxtyNvfyQj4GqEXrF79nvhUqRG7fC';
    expect(await run(['reputation', did], e)).toBe(2);
    expect(out.join('\n')).toContain('thaddeus use');
  });
});
