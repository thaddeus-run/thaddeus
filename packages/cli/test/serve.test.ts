import { ready } from '@thaddeus.run/identity';
import { type Bundle, decodeBundle } from '@thaddeus.run/server';
import { publicDid } from '@thaddeus.run/store';
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
    try {
      expect(s.url).toContain('http://localhost:');
      const res = await fetch(`${s.url}/repos`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ repos: [], owners: {} });
    } finally {
      await s.stop();
    }
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

  test('promotes scheduled reveals without a read or manual trigger', async () => {
    const s = startServer({
      dataDir: mkdtempSync(join(tmp, 'reveal-srv-')),
      port: 0,
      revealIntervalMs: 10,
    });
    try {
      const home = mkdtempSync(join(tmp, 'reveal-home-'));
      const work = mkdtempSync(join(tmp, 'reveal-work-'));
      const e = (cwd: string) => ({ cwd, home, out: () => {} });
      expect(await run(['init'], e(home))).toBe(0);
      expect(await run(['create', s.url, 'reveal'], e(home))).toBe(0);
      expect(await run(['clone', s.url, 'reveal', work], e(work))).toBe(0);
      writeFileSync(join(work, 'news.md'), 'public now');
      expect(await run(['push'], e(work))).toBe(0);
      const at = new Date(Date.now() + 50).toISOString();
      expect(
        await run(['schedule-reveal', 'news.md', '--at', at], e(work))
      ).toBe(0);

      let publicCapability = false;
      const deadline = Date.now() + 2_000;
      while (!publicCapability && Date.now() < deadline) {
        const response = await fetch(`${s.url}/repos/reveal/pull?view=main`);
        const bundle = decodeBundle((await response.json()) as Bundle);
        publicCapability = bundle.caps.some(
          (capability) => capability.grantee === publicDid()
        );
        if (!publicCapability) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(publicCapability).toBe(true);

      const outsiderHome = mkdtempSync(join(tmp, 'outsider-home-'));
      const outsider = mkdtempSync(join(tmp, 'outsider-work-'));
      const outsiderEnv = (cwd: string) => ({
        cwd,
        home: outsiderHome,
        out: () => {},
      });
      expect(await run(['init'], outsiderEnv(outsiderHome))).toBe(0);
      expect(
        await run(['clone', s.url, 'reveal', outsider], outsiderEnv(outsider))
      ).toBe(0);
      expect(readFileSync(join(outsider, 'news.md'), 'utf8')).toBe(
        'public now'
      );
    } finally {
      await s.stop();
    }
  });
});
