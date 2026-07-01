import { ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/run';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-pub-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// init an identity in `home` against a shared server fetch.
async function clientHome(
  fetchImpl: (req: Request) => Promise<Response>,
  label: string
) {
  const home = mkdtempSync(join(tmp, `${label}-`));
  await run(['init'], { cwd: home, home, fetchImpl, out: () => {} });
  return home;
}

describe('thaddeus push (publish)', () => {
  test('headline: edit → push → fresh clone sees it', async () => {
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
    writeFileSync(join(a, 'readme.md'), '# hello');
    out.length = 0;
    expect(await run(['push'], e(a))).toBe(0);
    expect(out.join('\n').toLowerCase()).toContain('published');

    // status is clean after publish.
    out.length = 0;
    await run(['status'], e(a));
    expect(out.join('\n')).toContain('clean');

    // A fresh clone (new dir) sees the file.
    const b = mkdtempSync(join(tmp, 'b-'));
    await run(['clone', 'http://t', 'proj', b], e(b));
    expect(readFileSync(join(b, 'readme.md'), 'utf8')).toBe('# hello');
  });

  test('push with no changes says nothing to publish', async () => {
    const srv = createServer({ backend: new MemoryBackend() });
    const fetchImpl = srv.fetch.bind(srv);
    const home = await clientHome(fetchImpl, 'home2');
    const out: string[] = [];
    const e = (cwd: string) => ({
      cwd,
      home,
      fetchImpl,
      out: (l: string) => out.push(l),
    });
    await run(['create', 'http://t', 'p2'], e(home));
    const a = mkdtempSync(join(tmp, 'a2-'));
    await run(['clone', 'http://t', 'p2', a], e(a));
    out.length = 0;
    const code = await run(['push'], e(a));
    expect(code).toBe(0);
    expect(out.join('\n').toLowerCase()).toContain('nothing to publish');
  });

  test('a non-owner push fails with a clear message', async () => {
    const srv = createServer({ backend: new MemoryBackend() });
    const fetchImpl = srv.fetch.bind(srv);
    const ownerHome = await clientHome(fetchImpl, 'owner');
    const out: string[] = [];
    const e = (cwd: string, home: string) => ({
      cwd,
      home,
      fetchImpl,
      out: (l: string) => out.push(l),
    });
    await run(['create', 'http://t', 'p3'], e(ownerHome, ownerHome));
    // A different identity clones (public read) then tries to push.
    const otherHome = await clientHome(fetchImpl, 'other');
    const a = mkdtempSync(join(tmp, 'a3-'));
    await run(['clone', 'http://t', 'p3', a], e(a, otherHome));
    writeFileSync(join(a, 'x.txt'), 'hi');
    out.length = 0;
    expect(await run(['push'], e(a, otherHome))).toBe(1);
    expect(out.join('\n').toLowerCase()).toContain('not authorized');
  });

  test('push --no-land uploads without landing; status shows ahead; land finishes', async () => {
    const srv = createServer({ backend: new MemoryBackend() });
    const fetchImpl = srv.fetch.bind(srv);
    const home = await clientHome(fetchImpl, 'home4');
    const out: string[] = [];
    const e = (cwd: string) => ({
      cwd,
      home,
      fetchImpl,
      out: (l: string) => out.push(l),
    });
    await run(['create', 'http://t', 'p4'], e(home));
    const a = mkdtempSync(join(tmp, 'a4-'));
    await run(['clone', 'http://t', 'p4', a], e(a));
    writeFileSync(join(a, 'f.txt'), 'one');

    // Upload without landing.
    out.length = 0;
    expect(await run(['push', '--no-land'], e(a))).toBe(0);
    expect(out.join('\n').toLowerCase()).toContain('not landed');

    // status reports the unpublished commit.
    out.length = 0;
    await run(['status'], e(a));
    expect(out.join('\n')).toContain('not published');

    // land finishes it; status is then clean.
    out.length = 0;
    expect(await run(['land'], e(a))).toBe(0);
    expect(out.join('\n').toLowerCase()).toContain('landed to main');
    out.length = 0;
    await run(['status'], e(a));
    expect(out.join('\n')).toContain('clean');
  });
});
