import { Identity, ready } from '@thaddeus.run/identity';
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

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-rep-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function clientHome(
  fetchImpl: (req: Request) => Promise<Response>,
  label: string
): Promise<string> {
  const home = mkdtempSync(join(tmp, `${label}-`));
  await run(['init'], { cwd: home, home, fetchImpl, out: () => {} });
  return home;
}

describe('thaddeus reputation', () => {
  test('push mints an attested merge on an attesting server; reputation shows it', async () => {
    // An attesting server co-signs each landed op's merge claim with `host`.
    const host = Identity.create();
    const srv = createServer({ backend: new MemoryBackend(), host });
    const fetchImpl = srv.fetch.bind(srv);
    const home = await clientHome(fetchImpl, 'home');
    const out: string[] = [];
    const e = (cwd: string) => ({
      cwd,
      home,
      fetchImpl,
      out: (l: string) => out.push(l),
    });

    out.length = 0;
    await run(['create', 'http://t', 'proj'], e(home));
    const owner = out.join('\n').match(/owner (did:key:[a-zA-Z0-9]+)/)?.[1];
    expect(owner).toBeDefined();

    const a = mkdtempSync(join(tmp, 'a-'));
    await run(['clone', 'http://t', 'proj', a], e(a));
    writeFileSync(join(a, 'auth.rs'), 'fn refresh() {}');
    // Publish: the push auto-lands and ships a merge claim the host attests.
    expect(await run(['push', '-m', 'add auth'], e(a))).toBe(0);

    out.length = 0;
    expect(await run(['reputation', owner!], e(a))).toBe(0);
    const repOut = out.join('\n');
    expect(repOut).toContain('attested: 1');
    expect(repOut).toContain('merge=1');
  });

  test('without a host key, no reputation accrues (server holds no keys)', async () => {
    const srv = createServer({ backend: new MemoryBackend() }); // no host
    const fetchImpl = srv.fetch.bind(srv);
    const home = await clientHome(fetchImpl, 'nohost');
    const out: string[] = [];
    const e = (cwd: string) => ({
      cwd,
      home,
      fetchImpl,
      out: (l: string) => out.push(l),
    });

    out.length = 0;
    await run(['create', 'http://t', 'p2'], e(home));
    const owner = out.join('\n').match(/owner (did:key:[a-zA-Z0-9]+)/)?.[1];

    const a = mkdtempSync(join(tmp, 'nh-'));
    await run(['clone', 'http://t', 'p2', a], e(a));
    writeFileSync(join(a, 'x.rs'), 'fn x() {}');
    expect(await run(['push', '-m', 'x'], e(a))).toBe(0);

    out.length = 0;
    expect(await run(['reputation', owner!], e(a))).toBe(0);
    expect(out.join('\n')).toContain('attested: 0');
  });
});
