import { Client } from '@thaddeus.run/client';
import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { signContribution } from '@thaddeus.run/reputation';
import { createServer } from '@thaddeus.run/server';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

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
  test('an owner push does not mint merge reputation in its own repository', async () => {
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
    // Publish ships a claim, but the host rejects owner-controlled self-credit.
    expect(await run(['push', '-m', 'add auth'], e(a))).toBe(0);

    out.length = 0;
    expect(await run(['reputation', owner!], e(a))).toBe(0);
    const repOut = out.join('\n');
    expect(repOut).toContain('attested: 0');
    expect(repOut).toContain('by kind: (none)');
  });

  test('without an attester, no reputation proof is issued', async () => {
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
    await new Client('http://source', identity, fetchImpl).importReputation({
      format: 'thaddeus.reputation.v1',
      subject: identity.did,
      contributions: [
        signContribution(
          {
            repo: 'independent/project',
            ref: 'merge-proof',
            kind: 'merge',
            at: '2026-07-14T00:00:00.000Z',
          },
          identity,
          host
        ),
      ],
    });
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

    // The reusable run() entrypoint must not depend on Bun globals when its
    // caller leaves stdin uninjected. The compiled Bun binary injects its own
    // reader, while Node consumers fall back to process.stdin.
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    const bunStdin = Bun.stdin as { text: () => Promise<string> };
    const bunText = bunStdin.text;
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      enumerable: true,
      value: Readable.from([archive]),
      writable: true,
    });
    bunStdin.text = () =>
      Promise.reject(new Error('Bun-specific stdin fallback used'));
    try {
      out.length = 0;
      expect(
        await run(
          ['reputation', 'import', '-', '--server', 'http://destination'],
          env(home)
        )
      ).toBe(0);
      expect(out.join('\n')).toContain('already present');
    } finally {
      bunStdin.text = bunText;
      if (stdinDescriptor !== undefined) {
        Object.defineProperty(process, 'stdin', stdinDescriptor);
      }
    }

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
