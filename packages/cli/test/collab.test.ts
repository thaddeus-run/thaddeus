import { ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadIdentity } from '../src/identity';
import { run } from '../src/run';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-collab-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// One shared server; the owner and the delegate each get their own identity home.
const srv = createServer({ backend: new MemoryBackend() });
const fetchImpl = srv.fetch.bind(srv);

const env = (home: string, cwd: string, out: (l: string) => void) => ({
  cwd,
  home,
  fetchImpl,
  out,
});
const quiet = (home: string, cwd: string) => env(home, cwd, () => {});

describe('owner ⇄ delegate collaboration', () => {
  test('grant shares read access; each side reads the other via pull', async () => {
    const ownerHome = mkdtempSync(join(tmp, 'owner-'));
    const delHome = mkdtempSync(join(tmp, 'delegate-'));
    const dirA = join(tmp, 'work-owner');
    const dirB = join(tmp, 'work-delegate');

    await run(['init'], quiet(ownerHome, tmp));
    await run(['init'], quiet(delHome, tmp));
    const delegateDid = loadIdentity(delHome).did;
    const ownerDid = loadIdentity(ownerHome).did;

    // Owner creates a repo and lands a file.
    await run(
      ['create', 'proj', '--server', 'http://t'],
      quiet(ownerHome, tmp)
    );
    await run(
      ['clone', 'proj', dirA, '--server', 'http://t'],
      quiet(ownerHome, tmp)
    );
    writeFileSync(join(dirA, 'a.txt'), 'hello');
    expect(await run(['push', '-m', 'add a'], quiet(ownerHome, dirA))).toBe(0);

    // Before the grant, the delegate cannot decrypt the repo.
    const denied: string[] = [];
    await run(
      ['clone', 'proj', dirB, '--server', 'http://t'],
      env(delHome, tmp, (l) => denied.push(l))
    );
    expect(() => readFileSync(join(dirB, 'a.txt'))).toThrow(); // no capability
    rmSync(dirB, { recursive: true, force: true });

    // Owner grants the delegate: write authority AND the decryption capability.
    const grantOut: string[] = [];
    expect(
      await run(
        ['grant', delegateDid],
        env(ownerHome, dirA, (l) => grantOut.push(l))
      )
    ).toBe(0);
    expect(grantOut.join('\n')).toContain('can now read this repo');

    // The delegate clones and CAN read the owner's file (the reported bug).
    expect(
      await run(
        ['clone', 'proj', dirB, '--server', 'http://t'],
        quiet(delHome, tmp)
      )
    ).toBe(0);
    expect(readFileSync(join(dirB, 'a.txt'), 'utf8')).toBe('hello');

    // The delegate lands a file of its own; push reshares the key to the owner.
    writeFileSync(join(dirB, 'b.txt'), 'world');
    expect(await run(['push', '-m', 'add b'], quiet(delHome, dirB))).toBe(0);

    // The owner pulls and CAN read the delegate's file (the other half of the bug).
    const pullOut: string[] = [];
    expect(
      await run(
        ['pull'],
        env(ownerHome, dirA, (l) => pullOut.push(l))
      )
    ).toBe(0);
    expect(pullOut.join('\n')).toContain('pulled proj');
    expect(readFileSync(join(dirA, 'b.txt'), 'utf8')).toBe('world');
    expect(readFileSync(join(dirA, 'a.txt'), 'utf8')).toBe('hello');

    // Sanity: both identities are members of the repo.
    const reposOut: string[] = [];
    await run(
      ['repos', '--json', '--server', 'http://t'],
      env(ownerHome, tmp, (l) => reposOut.push(l))
    );
    expect(reposOut.join('')).toContain(ownerDid);
  });

  test('pull refuses a dirty tree and unpublished commits', async () => {
    const home = mkdtempSync(join(tmp, 'gate-'));
    const dir = join(tmp, 'work-gate');
    await run(['init'], quiet(home, tmp));
    await run(['create', 'gated', '--server', 'http://t'], quiet(home, tmp));
    await run(
      ['clone', 'gated', dir, '--server', 'http://t'],
      quiet(home, tmp)
    );
    writeFileSync(join(dir, 'x.txt'), 'v1');
    await run(['push', '-m', 'x'], quiet(home, dir));

    // Dirty working tree → refused.
    writeFileSync(join(dir, 'x.txt'), 'v2');
    const dirty: string[] = [];
    expect(
      await run(
        ['pull'],
        env(home, dir, (l) => dirty.push(l))
      )
    ).toBe(2);
    expect(dirty.join('\n')).toContain('uncommitted changes');

    // Clean tree → pull succeeds.
    writeFileSync(join(dir, 'x.txt'), 'v1');
    expect(await run(['pull'], quiet(home, dir))).toBe(0);
  });
});
