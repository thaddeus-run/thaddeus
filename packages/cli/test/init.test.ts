import { ready } from '@thaddeus.run/identity';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

describe('thaddeus init', () => {
  test('creates an identity seed and prints a DID; re-init is idempotent', async () => {
    const home = mkdtempSync(join(tmp, 'home-'));
    const { lines, env: e } = env(home);
    expect(await run(['init'], e)).toBe(0);
    const first = lines.join('\n');
    expect(first).toContain('did:key:');
    const path = join(home, '.config', 'thaddeus', 'identity.json');
    const did1 = (JSON.parse(readFileSync(path, 'utf8')) as { did: string })
      .did;

    const { lines: l2, env: e2 } = env(home);
    expect(await run(['init'], e2)).toBe(0);
    const did2 = (JSON.parse(readFileSync(path, 'utf8')) as { did: string })
      .did;
    expect(did2).toBe(did1); // not rotated
    expect(l2.join('\n')).toContain(did1);
  });
});
