import { Workspace } from '@thaddeus.run/fs';
import { ready } from '@thaddeus.run/identity';
import { FileBackend, MemoryBackend } from '@thaddeus.run/persist';
import { Platform } from '@thaddeus.run/platform';
import { createServer } from '@thaddeus.run/server';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadIdentity } from '../src/identity';
import { run } from '../src/run';
import { loadConfig, storePath } from '../src/workcopy';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-releases-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('thaddeus release and releases', () => {
  test('creates from server history, hashes artifacts, and renders list/detail', async () => {
    const server = createServer({ backend: new MemoryBackend() });
    const fetchImpl = server.fetch.bind(server);
    const home = mkdtempSync(join(tmp, 'home-'));
    const wc = mkdtempSync(join(tmp, 'wc-'));
    const out: string[] = [];
    const env = (cwd: string) => ({
      cwd,
      home,
      fetchImpl,
      out: (line: string) => out.push(line),
    });

    expect(await run(['init'], env(home))).toBe(0);
    expect(await run(['create', 'http://t', 'r'], env(home))).toBe(0);
    expect(await run(['clone', 'http://t', 'r', wc], env(wc))).toBe(0);
    writeFileSync(join(wc, 'README.md'), 'server version');
    expect(await run(['push'], env(wc))).toBe(0);

    // Add a committed but unpushed local op, then leave the disk dirty too.
    const cfg = loadConfig(wc);
    const identity = loadIdentity(home);
    const local = await new Platform().openDurable(
      cfg.repo,
      new FileBackend(storePath(wc, cfg))
    );
    const work = Workspace.open(local.log, local.store, {
      source: 'main',
      reader: identity,
      name: 'local-only',
    });
    work.write('local.txt', new TextEncoder().encode('not pushed'));
    const localOps = await work.commit(identity);
    await local.log.repoint('main', local.log.heads('local-only'));
    writeFileSync(join(wc, 'README.md'), 'dirty disk version');
    writeFileSync(join(wc, 'artifact.bin'), 'hello');

    out.length = 0;
    expect(
      await run(
        [
          'release',
          'v1',
          '--notes',
          'First release',
          '--artifact',
          'artifact.bin',
          '--artifact-uri',
          'remote=https://cdn.example/app,sha256=2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
          '--json',
        ],
        env(wc)
      )
    ).toBe(0);
    const created = JSON.parse(out.join('\n')) as {
      tag: string;
      commits: string[];
      sig: string;
      artifacts: {
        name: string;
        uri: string;
        sha256: string;
        size: number | null;
        mediaType: string | null;
      }[];
    };
    expect(created.tag).toBe('v1');
    expect(created.commits).not.toContain(localOps[0].id);
    expect(created.sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(created.artifacts).toEqual([
      {
        name: 'artifact.bin',
        uri: 'urn:sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        sha256:
          '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        size: 5,
        mediaType: null,
      },
      {
        name: 'remote',
        uri: 'https://cdn.example/app',
        sha256:
          '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        size: null,
        mediaType: null,
      },
    ]);

    out.length = 0;
    expect(await run(['releases', '--json'], env(wc))).toBe(0);
    const list = JSON.parse(out.join('\n')) as { tag: string; sig: string }[];
    expect(list.map((release) => release.tag)).toEqual(['v1']);
    expect(typeof list[0].sig).toBe('string');

    out.length = 0;
    expect(await run(['releases', 'v1'], env(wc))).toBe(0);
    expect(out.join('\n')).toContain('tag: v1');
    expect(out.join('\n')).toContain('First release');
    expect(out.join('\n')).toContain('artifact.bin');

    out.length = 0;
    expect(await run(['release', 'v1'], env(wc))).toBe(1);
    expect(out.join('\n')).toContain('release tag v1 already exists');

    out.length = 0;
    expect(await run(['release', 'missing', '--view', 'ghost'], env(wc))).toBe(
      1
    );
    expect(out.join('\n')).toContain('no branch ghost');
  });
});
