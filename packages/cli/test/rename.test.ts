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

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-rename-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function clientHome(
  fetchImpl: (req: Request) => Promise<Response>,
  label: string
): Promise<string> {
  const home = mkdtempSync(join(tmp, `${label}-`));
  await run(['init'], { cwd: home, home, fetchImpl, out: () => {} });
  return home;
}

const SRC = 'fn refresh() {}\nfn login() {\n  refresh();\n}\n';

describe('thaddeus rename', () => {
  test('renames a symbol, rewrites the code, and the SymbolOp travels to a fresh clone', async () => {
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
    writeFileSync(join(a, 'auth.rs'), SRC);
    expect(await run(['push', '-m', 'initial'], e(a))).toBe(0);

    // Rename the symbol; capture the printed symbol-id prefix.
    out.length = 0;
    expect(
      await run(['rename', 'refresh', 'refreshToken', '-m', 'clearer'], e(a))
    ).toBe(0);
    const renameOut = out.join('\n');
    expect(renameOut).toContain('renamed refresh → refreshToken');
    const sym = renameOut.match(/symbol ([0-9a-f]{10})/)?.[1];
    expect(sym).toBeDefined();

    // The working tree on disk now uses the new name at the def and the call.
    const onDisk = readFileSync(join(a, 'auth.rs'), 'utf8');
    expect(onDisk).toContain('fn refreshToken()');
    expect(onDisk).toContain('  refreshToken();');

    // `history <id>` shows the signed, verified rename.
    out.length = 0;
    expect(await run(['history', sym!], e(a))).toBe(0);
    const histOut = out.join('\n');
    expect(histOut).toContain('refresh → refreshToken');
    expect(histOut).toContain('[verified]');

    // The current live name resolves through the durable rename ledger too.
    out.length = 0;
    expect(await run(['history', 'refreshToken'], e(a))).toBe(0);
    expect(out.join('\n')).toContain('refresh → refreshToken');

    // A fresh clone carries the SymbolOp over the wire — history survives.
    const b = mkdtempSync(join(tmp, 'b-'));
    await run(['clone', 'http://t', 'proj', b], e(b));
    out.length = 0;
    expect(await run(['history', sym!], e(b))).toBe(0);
    expect(out.join('\n')).toContain('refresh → refreshToken');

    out.length = 0;
    expect(await run(['history', 'refreshToken'], e(b))).toBe(0);
    expect(out.join('\n')).toContain('refresh → refreshToken');
  });
});
