import { Client } from '@thaddeus.run/client';
import { Workspace } from '@thaddeus.run/fs';
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

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-clone-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A server pre-seeded with one landed file, plus the home that owns it.
async function seededServer(home: string) {
  const srv = createServer({ backend: new MemoryBackend() });
  const fetchImpl = srv.fetch.bind(srv);
  await run(['init'], { cwd: home, home, fetchImpl, out: () => {} });
  // Use the SDK directly to seed (the CLI publish path is Task 6).
  const { loadIdentity } = await import('../src/identity');
  const a = loadIdentity(home);
  const c = new Client('http://t', a, fetchImpl);
  await c.createRepo('r');
  const { repo } = await c.clone('r', new MemoryBackend());
  const ws = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: a,
    name: 'work',
  });
  ws.write('src/auth.rs', enc('fn refresh() {}'));
  await ws.commit(a);
  const heads = [...repo.log.heads('work')];
  await c.push('r', repo, heads);
  await c.land('r', heads, 'main');
  return fetchImpl;
}

describe('thaddeus clone + status', () => {
  test('clone materializes files + config; status reflects an edit', async () => {
    const home = mkdtempSync(join(tmp, 'home-'));
    const fetchImpl = await seededServer(home);
    const dir = mkdtempSync(join(tmp, 'work-'));

    const out: string[] = [];
    const e = { cwd: dir, home, fetchImpl, out: (l: string) => out.push(l) };
    expect(await run(['clone', 'http://t', 'r', dir], e)).toBe(0);
    // File materialized + config written.
    expect(readFileSync(join(dir, 'src', 'auth.rs'), 'utf8')).toBe(
      'fn refresh() {}'
    );
    expect(
      readFileSync(join(dir, '.thaddeus', 'config.json'), 'utf8')
    ).toContain('"repo": "r"');

    // Clean status.
    out.length = 0;
    await run(['status'], { ...e, cwd: dir });
    expect(out.join('\n')).toContain('clean');

    // Edit → status shows modified.
    writeFileSync(join(dir, 'src', 'auth.rs'), 'fn refresh2() {}');
    out.length = 0;
    await run(['status'], { ...e, cwd: dir });
    expect(out.join('\n')).toContain('modified: src/auth.rs');
  });
});
