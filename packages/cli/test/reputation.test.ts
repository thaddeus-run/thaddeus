import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadIdentity } from '../src/identity';
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

  test('exports to stdout/file and imports from stdin or directly across instances', async () => {
    const host = Identity.create();
    const source = createServer({ backend: new MemoryBackend(), host });
    const destination = createServer({ backend: new MemoryBackend() });
    const directDestination = createServer({ backend: new MemoryBackend() });
    const fetchImpl = (req: Request): Promise<Response> => {
      const hostname = new URL(req.url).hostname;
      if (hostname === 'source') return source.fetch(req);
      if (hostname === 'destination') return destination.fetch(req);
      return directDestination.fetch(req);
    };
    const home = await clientHome(fetchImpl, 'portable');
    const identity = loadIdentity(home);
    const out: string[] = [];
    const env = (cwd: string, stdin?: () => Promise<string>) => ({
      cwd,
      home,
      fetchImpl,
      stdin,
      out: (line: string) => out.push(line),
    });

    expect(
      await run(['create', 'portable', '--server', 'http://source'], env(home))
    ).toBe(0);
    const wc = mkdtempSync(join(tmp, 'portable-wc-'));
    expect(
      await run(['clone', 'portable', wc, '--server', 'http://source'], env(wc))
    ).toBe(0);
    writeFileSync(join(wc, 'proof.rs'), 'fn proof() {}');
    expect(await run(['push', '-m', 'portable proof'], env(wc))).toBe(0);

    out.length = 0;
    expect(
      await run(
        ['reputation', 'export', identity.did, '--server', 'http://source'],
        env(home)
      )
    ).toBe(0);
    const archive = out.join('\n');
    expect(JSON.parse(archive).format).toBe('thaddeus.reputation.v1');

    const archivePath = join(home, 'reputation.json');
    out.length = 0;
    expect(
      await run(
        [
          'reputation',
          'export',
          identity.did,
          '--server',
          'http://source',
          '--output',
          archivePath,
        ],
        env(home)
      )
    ).toBe(0);
    expect(readFileSync(archivePath, 'utf8')).toBe(`${archive}\n`);

    out.length = 0;
    expect(
      await run(
        ['reputation', 'import', '-', '--server', 'http://destination'],
        env(home, () => Promise.resolve(archive))
      )
    ).toBe(0);
    expect(out.join('\n')).toContain('imported 1 contribution(s)');

    out.length = 0;
    expect(
      await run(
        [
          'reputation',
          'import',
          '--from',
          'http://source',
          '--server',
          'http://direct',
          '--json',
        ],
        env(home)
      )
    ).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ imported: 1, total: 1 });
  });
});
