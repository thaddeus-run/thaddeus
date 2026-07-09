import { ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/run';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-policy-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('thaddeus policy', () => {
  test('sets and clears a repo land policy', async () => {
    const srv = createServer({ backend: new MemoryBackend() });
    const fetchImpl = srv.fetch.bind(srv);
    const home = mkdtempSync(join(tmp, 'home-'));
    const wc = mkdtempSync(join(tmp, 'wc-'));
    const out: string[] = [];
    const e = (cwd: string) => ({
      cwd,
      home,
      fetchImpl,
      out: (l: string) => out.push(l),
    });

    expect(await run(['init'], e(home))).toBe(0);
    expect(await run(['create', 'http://t', 'proj'], e(home))).toBe(0);
    expect(await run(['clone', 'http://t', 'proj', wc], e(wc))).toBe(0);
    writeFileSync(join(wc, 'a.txt'), 'a\n');
    expect(await run(['push', '-m', 'seed'], e(wc))).toBe(0);

    out.length = 0;
    expect(await run(['policy'], e(wc))).toBe(0);
    expect(out.join('\n')).toContain('policy: default');

    out.length = 0;
    expect(await run(['policy', 'set', '--forbid-deletes'], e(wc))).toBe(0);
    expect(out.join('\n')).toContain('forbid deletes');

    rmSync(join(wc, 'a.txt'));
    out.length = 0;
    expect(await run(['push'], e(wc))).toBe(1);
    expect(out.join('\n')).toContain('not landed');
    expect(out.join('\n')).toContain('forbid deletes');

    out.length = 0;
    expect(await run(['policy', 'set', '--require-provenance'], e(wc))).toBe(0);
    expect(out.join('\n')).toContain('replacing existing policy');
    expect(out.join('\n')).toContain('old standing query: forbid deletes');
    expect(out.join('\n')).toContain('new require verified provenance');

    out.length = 0;
    expect(await run(['policy', 'clear'], e(wc))).toBe(0);
    expect(out.join('\n')).toContain('policy cleared');

    out.length = 0;
    expect(await run(['policy', 'set', '--forbid-paths', '*.env'], e(wc))).toBe(
      1
    );
    expect(out.join('\n')).toContain('supports only exact paths');

    out.length = 0;
    expect(await run(['land'], e(wc))).toBe(0);
    expect(out.join('\n')).toContain('landed to main');
  });
});
