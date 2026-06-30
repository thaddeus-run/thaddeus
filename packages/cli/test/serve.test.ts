import { ready } from '@thaddeus.run/identity';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/run';
import { startServer } from '../src/serve';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-serve-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('startServer', () => {
  test('serves over a real port and stops cleanly', async () => {
    const s = startServer({
      dataDir: mkdtempSync(join(tmp, 'data-')),
      port: 0,
    });
    expect(s.url).toContain('http://localhost:');
    const res = await fetch(`${s.url}/repos`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repos: [] });
    await s.stop();
  });

  test('a full CLI flow works against a live served port', async () => {
    const s = startServer({ dataDir: mkdtempSync(join(tmp, 'srv-')), port: 0 });
    try {
      const home = mkdtempSync(join(tmp, 'home-'));
      const e = (cwd: string) => ({ cwd, home, out: () => {} });
      expect(await run(['init'], e(home))).toBe(0);
      expect(await run(['create', s.url, 'proj'], e(home))).toBe(0);
      const a = mkdtempSync(join(tmp, 'a-'));
      expect(await run(['clone', s.url, 'proj', a], e(a))).toBe(0);
      writeFileSync(join(a, 'readme.md'), '# hi');
      expect(await run(['push'], e(a))).toBe(0);
      const b = mkdtempSync(join(tmp, 'b-'));
      expect(await run(['clone', s.url, 'proj', b], e(b))).toBe(0);
      expect(readFileSync(join(b, 'readme.md'), 'utf8')).toBe('# hi');
    } finally {
      await s.stop();
    }
  });
});
