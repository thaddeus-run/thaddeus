import { Client } from '@thaddeus.run/client';
import { ready } from '@thaddeus.run/identity';
import { FileBackend, MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadIdentity } from '../src/identity';
import { prepareIgnore } from '../src/ignore';
import { beginInitState } from '../src/init-state';
import { inspectInit } from '../src/repo-init';
import { run } from '../src/run';
import { saveConfig } from '../src/workcopy';

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-repo-init-'));
beforeAll(ready);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function fixture(identity = true) {
  const home = mkdtempSync(join(tmp, 'home-'));
  const cwd = mkdtempSync(join(tmp, 'work-'));
  const server = createServer({ backend: new MemoryBackend() });
  const lines: string[] = [];
  const requests: Request[] = [];
  const env = {
    home,
    cwd,
    out: (line: string) => lines.push(line),
    fetchImpl: (request: Request) => {
      requests.push(request);
      return server.fetch(request);
    },
  };
  if (identity) expect(await run(['identity', 'init'], env)).toBe(0);
  return { home, cwd, server, lines, requests, env };
}

test('adopts existing files with explicit ignores and no upload until push', async () => {
  const f = await fixture();
  const identityPath = join(f.home, '.config', 'thaddeus', 'identity.json');
  const identity = readFileSync(identityPath);
  writeFileSync(join(f.cwd, '.gitignore'), '.env\ndist/\n');
  writeFileSync(join(f.cwd, '.env'), 'secret');
  writeFileSync(join(f.cwd, '.git'), 'gitdir: elsewhere');
  writeFileSync(join(f.cwd, 'a.txt'), 'original', { mode: 0o755 });
  symlinkSync('a.txt', join(f.cwd, 'link'));
  const mode = statSync(join(f.cwd, 'a.txt')).mode;
  expect(await run(['init', 'acme/web', '--server', 'http://t'], f.env)).toBe(
    0
  );
  expect(readFileSync(identityPath)).toEqual(identity);
  expect(readFileSync(join(f.cwd, 'a.txt'), 'utf8')).toBe('original');
  expect(statSync(join(f.cwd, 'a.txt')).mode).toBe(mode);
  expect(existsSync(join(f.cwd, 'web'))).toBe(false);
  expect(f.lines.join('\n')).toContain('No file contents were uploaded');
  f.lines.length = 0;
  expect(await run(['status', '--json'], f.env)).toBe(0);
  expect(JSON.parse(f.lines[0])).toMatchObject({
    branch: 'main',
    clean: false,
    added: ['.gitignore', '.thaddeusignore', 'a.txt'],
    ahead: 0,
  });
  const client = new Client('http://t', loadIdentity(f.home), f.env.fetchImpl);
  const remote = await client.clone('acme/web', new MemoryBackend());
  expect(remote.heads).toEqual([]);
  expect(remote.repo.log.ops()).toHaveLength(0);
  expect(await run(['push', '-m', 'initial import'], f.env)).toBe(0);
  const clone = join(tmp, 'clone-' + crypto.randomUUID());
  expect(
    await run(['clone', 'acme/web', clone, '--server', 'http://t'], f.env)
  ).toBe(0);
  expect(readFileSync(join(clone, 'a.txt'), 'utf8')).toBe('original');
  expect(existsSync(join(clone, '.env'))).toBe(false);
});

test('missing identity and invalid usage have no side effects', async () => {
  const f = await fixture(false);
  for (const args of [
    ['init'],
    ['init', 'r', '--force'],
    ['init', 'r', 'extra'],
    ['init', 'r'],
    ['init', 'r', '--server', 'bad'],
    ['init', 'r', '--server', 'http://t'],
  ]) {
    expect(await run(args, f.env)).toBe(2);
  }
  expect(f.lines.join(' ')).toContain('identity init');
  expect(existsSync(join(f.home, '.config'))).toBe(false);
  expect(readdirSync(f.cwd)).toEqual([]);
  expect(f.requests).toHaveLength(0);
});

test('empty root, saved server, repeat init and a second repo share one identity', async () => {
  const f = await fixture();
  expect(await run(['use', 'http://t'], f.env)).toBe(0);
  expect(await run(['init', 'empty'], f.env)).toBe(0);
  f.lines.length = 0;
  expect(await run(['status', '--json'], f.env)).toBe(0);
  expect(JSON.parse(f.lines[0]).clean).toBe(true);
  const requests = f.requests.length;
  expect(await run(['init', 'empty'], f.env)).toBe(0);
  expect(f.requests).toHaveLength(requests);
  expect(await run(['init', 'different'], f.env)).toBe(2);
  const second = mkdtempSync(join(tmp, 'second-'));
  expect(await run(['init', 'second'], { ...f.env, cwd: second })).toBe(0);
});

test('preflight rejects parent, ignored descendant, metadata symlinks and identity home', async () => {
  const f = await fixture();
  const parent = join(f.cwd, 'parent');
  const child = join(parent, 'child');
  mkdirSync(child, { recursive: true });
  saveConfig(parent, { server: 'http://t', repo: 'r', base: [] });
  expect(() => inspectInit(child, f.home)).toThrow('inside');
  writeFileSync(join(f.cwd, '.thaddeusignore'), 'parent/\n');
  expect(() => inspectInit(f.cwd, f.home)).toThrow('nested');
  rmSync(parent, { recursive: true });
  symlinkSync(parent, join(f.cwd, '.thaddeus'));
  expect(() => inspectInit(f.cwd, f.home)).toThrow('directory');
  expect(() => inspectInit(f.home, f.home)).toThrow('identity');
});

test('lost create response rolls back locally and retries without a second remote', async () => {
  const f = await fixture();
  writeFileSync(join(f.cwd, 'a.txt'), 'keep');
  let lose = true;
  const env = {
    ...f.env,
    fetchImpl: async (request: Request) => {
      const response = await f.env.fetchImpl(request);
      if (
        lose &&
        response.ok &&
        request.method === 'POST' &&
        new URL(request.url).pathname === '/repos'
      ) {
        lose = false;
        throw new Error('lost create response');
      }
      return response;
    },
  };
  expect(await run(['init', 'recover', '--server', 'http://t'], env)).toBe(1);
  expect(existsSync(join(f.cwd, '.thaddeus', 'config.json'))).toBe(false);
  expect(readFileSync(join(f.cwd, 'a.txt'), 'utf8')).toBe('keep');
  expect(f.lines.join(' ')).toContain('retry');
  expect(await run(['init', 'recover', '--server', 'http://t'], env)).toBe(0);
  expect(
    f.requests.filter(
      (r) => r.method === 'POST' && new URL(r.url).pathname === '/repos'
    )
  ).toHaveLength(1);
  expect(f.requests.some((r) => r.method === 'DELETE')).toBe(false);
});

test('fresh remote collisions fail for both same and different owners', async () => {
  const f = await fixture();
  expect(
    await run(['create', 'collision', '--server', 'http://t'], f.env)
  ).toBe(0);
  expect(await run(['init', 'collision', '--server', 'http://t'], f.env)).toBe(
    1
  );
  const otherHome = mkdtempSync(join(tmp, 'other-'));
  expect(await run(['identity', 'init'], { ...f.env, home: otherHome })).toBe(
    0
  );
  expect(
    await run(['init', 'collision', '--server', 'http://t'], {
      ...f.env,
      home: otherHome,
    })
  ).toBe(1);
  expect(readdirSync(f.cwd)).toEqual([]);
  expect(f.requests.some((r) => r.method === 'DELETE')).toBe(false);
});

test('rules changed during create abort adoption and a later retry uses the new rules', async () => {
  const f = await fixture();
  writeFileSync(join(f.cwd, '.gitignore'), '.env\n');
  writeFileSync(join(f.cwd, '.env'), 'secret');
  let change = true;
  const env = {
    ...f.env,
    fetchImpl: async (request: Request) => {
      const response = await f.env.fetchImpl(request);
      if (change && response.ok && request.method === 'POST') {
        change = false;
        writeFileSync(join(f.cwd, '.gitignore'), '.env\nextra\n');
      }
      return response;
    },
  };
  expect(await run(['init', 'rules', '--server', 'http://t'], env)).toBe(1);
  expect(existsSync(join(f.cwd, '.thaddeusignore'))).toBe(false);
  expect(existsSync(join(f.cwd, '.thaddeus', 'config.json'))).toBe(false);
  expect(await run(['init', 'rules', '--server', 'http://t'], env)).toBe(0);
  expect(readFileSync(join(f.cwd, '.thaddeusignore'), 'utf8')).toContain(
    'extra'
  );
});

test('recovery refuses a remote populated after a lost response', async () => {
  const f = await fixture();
  writeFileSync(join(f.cwd, 'keep.txt'), 'local');
  let lose = true;
  const env = {
    ...f.env,
    fetchImpl: async (request: Request) => {
      const response = await f.env.fetchImpl(request);
      if (lose && response.ok && request.method === 'POST') {
        lose = false;
        throw new Error('lost response');
      }
      return response;
    },
  };
  expect(await run(['init', 'populated', '--server', 'http://t'], env)).toBe(1);
  const otherCopy = join(tmp, crypto.randomUUID());
  expect(
    await run(['clone', 'populated', otherCopy, '--server', 'http://t'], f.env)
  ).toBe(0);
  writeFileSync(join(otherCopy, 'keep.txt'), 'remote');
  expect(await run(['push'], { ...f.env, cwd: otherCopy })).toBe(0);
  expect(await run(['init', 'populated', '--server', 'http://t'], env)).toBe(1);
  expect(readFileSync(join(f.cwd, 'keep.txt'), 'utf8')).toBe('local');
  expect(existsSync(join(f.cwd, '.thaddeus', 'config.json'))).toBe(false);
  expect(f.lines.join(' ')).toContain('repository changed');
});

test('a refused connection can be retried when the remote is definitively absent', async () => {
  const f = await fixture();
  expect(
    await run(['init', 'absent', '--server', 'http://t'], {
      ...f.env,
      fetchImpl: () => {
        throw new Error('connection refused');
      },
    })
  ).toBe(1);
  expect(await run(['init', 'absent', '--server', 'http://t'], f.env)).toBe(0);
  expect(
    f.requests.filter(
      (r) => r.method === 'POST' && new URL(r.url).pathname === '/repos'
    )
  ).toHaveLength(1);
});

test('adopts through a symlinked cwd and preserves installer metadata', async () => {
  const f = await fixture();
  mkdirSync(join(f.cwd, '.thaddeus', 'bin'), { recursive: true });
  writeFileSync(
    join(f.cwd, '.thaddeus', 'bin', 'thaddeus'),
    'installed binary'
  );
  const alias = join(tmp, crypto.randomUUID());
  symlinkSync(f.cwd, alias);
  expect(
    await run(['init', 'alias', '--server', 'http://t'], {
      ...f.env,
      cwd: alias,
    })
  ).toBe(0);
  expect(await run(['init', 'alias', '--server', 'http://t/'], f.env)).toBe(0);
  expect(
    readFileSync(join(f.cwd, '.thaddeus', 'bin', 'thaddeus'), 'utf8')
  ).toBe('installed binary');
});

test('unknown stores and changed identities are refused before any request', async () => {
  const f = await fixture();
  mkdirSync(join(f.cwd, '.thaddeus', 'store'), { recursive: true });
  writeFileSync(join(f.cwd, '.thaddeus', 'store', 'keep'), 'unknown data');
  expect(await run(['init', 'r', '--server', 'http://t'], f.env)).toBe(2);
  expect(f.requests).toHaveLength(0);
  expect(readFileSync(join(f.cwd, '.thaddeus', 'store', 'keep'), 'utf8')).toBe(
    'unknown data'
  );
  rmSync(join(f.cwd, '.thaddeus', 'store'), { recursive: true });
  expect(await run(['init', 'r', '--server', 'http://t'], f.env)).toBe(0);
  const count = f.requests.length;
  expect(await run(['identity', 'init', '--force'], f.env)).toBe(0);
  expect(await run(['init', 'r', '--server', 'http://t'], f.env)).toBe(2);
  expect(f.requests).toHaveLength(count);
});

test('recovery pins the original owner when a remote is replaced', async () => {
  const f = await fixture();
  const env = {
    ...f.env,
    fetchImpl: async (request: Request) => {
      const response = await f.env.fetchImpl(request);
      if (request.method === 'POST' && response.ok)
        throw new Error('lost response');
      return response;
    },
  };
  expect(await run(['init', 'replaced', '--server', 'http://t'], env)).toBe(1);
  // Simulate an external owner deleting and replacing the empty remote.
  await new Client(
    'http://t',
    loadIdentity(f.home),
    f.env.fetchImpl
  ).deleteRepo('replaced');
  const otherHome = mkdtempSync(join(tmp, 'replacement-owner-'));
  expect(await run(['identity', 'init'], { ...f.env, home: otherHome })).toBe(
    0
  );
  await new Client(
    'http://t',
    loadIdentity(otherHome),
    f.env.fetchImpl
  ).createRepo('replaced');
  const count = f.requests.length;
  expect(await run(['init', 'replaced', '--server', 'http://t'], f.env)).toBe(
    1
  );
  expect(f.lines.join(' ')).toContain('wrong_owner');
  expect(existsSync(join(f.cwd, '.thaddeus', 'config.json'))).toBe(false);
  expect(
    f.requests.slice(count).some((request) => request.method === 'DELETE')
  ).toBe(false);
});

test('first retry recovers an ignore seed installed before interruption', async () => {
  const f = await fixture();
  writeFileSync(join(f.cwd, '.gitignore'), '.env\n');
  writeFileSync(join(f.cwd, '.env'), 'secret');
  writeFileSync(join(f.cwd, 'keep.txt'), 'source');
  const owner = loadIdentity(f.home);
  const prepared = prepareIgnore(f.cwd);
  const state = beginInitState({
    root: f.cwd,
    home: f.home,
    repo: 'seeded-recovery',
    server: 'http://t',
    owner: owner.did,
  });
  const client = new Client('http://t', owner, f.env.fetchImpl);
  await client.createRepo('seeded-recovery');
  state.mark('remote-created');
  await client.clone(
    'seeded-recovery',
    new FileBackend(join(state.stage, 'store')),
    'main',
    { expectedOwner: owner.did }
  );
  const config = join(f.cwd, '.thaddeus', 'config.json');
  mkdirSync(config);
  expect(() =>
    state.publish(
      { server: 'http://t', repo: 'seeded-recovery', base: [] },
      prepared
    )
  ).toThrow();
  expect(existsSync(join(f.cwd, '.thaddeusignore'))).toBe(true);
  rmSync(config, { recursive: true });
  state.release();
  // Leave the same artifacts a crash before config publication would leave.
  expect(
    await run(['init', 'seeded-recovery', '--server', 'http://t'], f.env)
  ).toBe(0);
  expect(readFileSync(join(f.cwd, 'keep.txt'), 'utf8')).toBe('source');
  f.lines.length = 0;
  expect(await run(['status', '--json'], f.env)).toBe(0);
  expect(JSON.parse(f.lines[0]).added).not.toContain('.env');
});
