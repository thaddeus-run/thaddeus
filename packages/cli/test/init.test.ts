import { ready } from '@thaddeus.run/identity';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/run';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function env(home: string) {
  const lines: string[] = [];
  return { lines, env: { cwd: home, home, out: (l: string) => lines.push(l) } };
}

describe('thaddeus identity init', () => {
  test('creates an identity seed and prints a DID; re-init is idempotent', async () => {
    const home = mkdtempSync(join(tmp, 'home-'));
    const { lines, env: e } = env(home);
    expect(await run(['identity', 'init'], e)).toBe(0);
    const first = lines.join('\n');
    expect(first).toContain('did:key:');
    const path = join(home, '.config', 'thaddeus', 'identity.json');
    expect((statSync(path).mode & 0o777) === 0o600).toBe(true);
    const did1 = (JSON.parse(readFileSync(path, 'utf8')) as { did: string })
      .did;

    const { lines: l2, env: e2 } = env(home);
    expect(await run(['identity', 'init'], e2)).toBe(0);
    const did2 = (JSON.parse(readFileSync(path, 'utf8')) as { did: string })
      .did;
    expect(did2).toBe(did1); // not rotated
    expect(l2.join('\n')).toContain(did1);
  });
});

test('bare init and init --force never create an identity', async () => {
  const home = mkdtempSync(join(tmp, 'bare-'));
  const { lines, env: e } = env(home);
  expect(await run(['init'], e)).toBe(2);
  expect(await run(['init', '--force'], e)).toBe(2);
  expect(lines.join(' ')).toContain('identity init');
  expect(existsSync(join(home, '.config'))).toBe(false);
});

test('identity init is local; explicit force rotates; corrupt identities are refused', async () => {
  const home = mkdtempSync(join(tmp, 'rotate-'));
  const { env: e } = env(home);
  const local = {
    ...e,
    fetchImpl: () => {
      throw new Error('unexpected network');
    },
  };
  expect(await run(['identity', 'init'], local)).toBe(0);
  const path = join(home, '.config', 'thaddeus', 'identity.json');
  const first = readFileSync(path, 'utf8');
  expect(existsSync(join(home, '.thaddeus'))).toBe(false);
  expect(await run(['identity', 'init', '--force'], local)).toBe(0);
  expect(readFileSync(path, 'utf8')).not.toBe(first);
  for (const content of [
    '{',
    '{}',
    JSON.stringify({ seed: '???', did: 'bad' }),
    JSON.stringify({ seed: Buffer.alloc(32).toString('base64'), did: 'wrong' }),
  ]) {
    writeFileSync(path, content);
    expect(await run(['identity', 'init'], local)).toBe(1);
    expect(await run(['whoami'], local)).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(content);
  }
});

test('identity and repository usage errors do not write state', async () => {
  const home = mkdtempSync(join(tmp, 'usage-'));
  const { env: e } = env(home);
  for (const args of [
    ['identity'],
    ['identity', 'init', 'extra'],
    ['identity', 'init', '--server', 'http://t'],
    ['init', 'r', '--unknown'],
    ['init', 'r', '--server'],
  ]) {
    expect(await run(args, e)).toBe(2);
  }
  expect(existsSync(join(home, '.config'))).toBe(false);
});
