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

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-veto-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// init an identity in `home` against a shared server fetch.
async function clientHome(
  fetchImpl: (req: Request) => Promise<Response>,
  label: string
): Promise<string> {
  const home = mkdtempSync(join(tmp, `${label}-`));
  await run(['init'], { cwd: home, home, fetchImpl, out: () => {} });
  return home;
}

describe('thaddeus veto', () => {
  test('a pushed veto blocks a land; log marks it ⛔; vetoes lists it', async () => {
    const srv = createServer({ backend: new MemoryBackend() });
    const fetchImpl = srv.fetch.bind(srv);
    const home = await clientHome(fetchImpl, 'home');
    const out: string[] = [];
    const e = (cwd: string) => ({
      cwd,
      home,
      fetchImpl,
      out: (l: string) => out.push(l),
    });

    await run(['create', 'http://t', 'proj'], e(home));
    const a = mkdtempSync(join(tmp, 'a-'));
    await run(['clone', 'http://t', 'proj', a], e(a));
    writeFileSync(join(a, 'auth.rs'), 'fn refresh() {}');

    // Upload without landing so there's a landable op to veto.
    expect(await run(['push', '--no-land'], e(a))).toBe(0);

    // Read the op id from `log` (the 10-char prefix it prints).
    out.length = 0;
    await run(['log'], e(a));
    const opId = out
      .join('\n')
      .split('\n')
      .find((l) => /^[0-9a-f]{10}/.test(l))
      ?.slice(0, 10);
    expect(opId).toBeDefined();

    // Lodge a veto on that op.
    out.length = 0;
    expect(await run(['veto', opId!, '-m', 'ships a secret'], e(a))).toBe(0);
    expect(out.join('\n')).toContain('vetoed');

    // The verified veto blocks the land.
    out.length = 0;
    expect(await run(['land'], e(a))).toBe(1);
    expect(out.join('\n').toLowerCase()).toContain('not landed');
    expect(out.join('\n').toLowerCase()).toContain('veto');

    // `log` marks the op ⛔; `vetoes <op>` lists the verified reason.
    out.length = 0;
    await run(['log'], e(a));
    expect(out.join('\n')).toContain('⛔');

    out.length = 0;
    expect(await run(['vetoes', opId!], e(a))).toBe(0);
    expect(out.join('\n')).toContain('ships a secret');
    expect(out.join('\n')).toContain('[verified]');
  });
});
