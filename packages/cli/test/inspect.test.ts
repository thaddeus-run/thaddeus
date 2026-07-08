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

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-inspect-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function clientHome(
  fetchImpl: (req: Request) => Promise<Response>,
  label: string
): Promise<string> {
  const home = mkdtempSync(join(tmp, `${label}-`));
  await run(['init'], { cwd: home, home, fetchImpl, out: () => {} });
  return home;
}

describe('thaddeus — version, help, whoami', () => {
  test('--version prints a semver; help is per-command', async () => {
    const out: string[] = [];
    const e = { cwd: tmp, home: tmp, out: (l: string) => out.push(l) };

    expect(await run(['--version'], e)).toBe(0);
    expect(out.join('')).toMatch(/^\d+\.\d+\.\d+/);

    out.length = 0;
    await run(['help', 'clone'], e);
    expect(out.join('\n')).toContain('thaddeus clone');

    out.length = 0;
    await run(['log', '--help'], e);
    expect(out.join('\n')).toContain('--since');

    out.length = 0;
    await run([], e);
    expect(out.join('\n')).toContain('the Thaddeus CLI');
  });

  test('whoami prints the DID, and --json wraps it', async () => {
    const srv = createServer({ backend: new MemoryBackend() });
    const home = await clientHome(srv.fetch.bind(srv), 'who');
    const out: string[] = [];
    const e = { cwd: home, home, out: (l: string) => out.push(l) };

    await run(['whoami'], e);
    expect(out.join('')).toMatch(/^did:/);

    out.length = 0;
    await run(['whoami', '--json'], e);
    const parsed = JSON.parse(out.join('')) as { did: string };
    expect(parsed.did).toMatch(/^did:/);
  });
});

describe('thaddeus diff / status --json / log filters', () => {
  test('diff shows added then modified lines; status/log emit JSON', async () => {
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
    writeFileSync(join(a, 'auth.rs'), 'fn one() {}\nfn two() {}\n');

    // diff of a brand-new file shows it added, line by line.
    out.length = 0;
    expect(await run(['diff'], e(a))).toBe(0);
    const added = out.join('\n');
    expect(added).toContain('auth.rs (added)');
    expect(added).toContain('+fn one() {}');

    // status --json lists the added path.
    out.length = 0;
    await run(['status', '--json'], e(a));
    const st = JSON.parse(out.join('')) as { added: string[]; clean: boolean };
    expect(st.clean).toBe(false);
    expect(st.added).toContain('auth.rs');

    // publish it, then edit one line.
    expect(await run(['push', '-m', 'initial import'], e(a))).toBe(0);
    writeFileSync(join(a, 'auth.rs'), 'fn one() {}\nfn THREE() {}\n');

    // diff now shows the modified hunk (line removed + line added).
    out.length = 0;
    await run(['diff'], e(a));
    const mod = out.join('\n');
    expect(mod).toContain('auth.rs (modified)');
    expect(mod).toContain('-fn two() {}');
    expect(mod).toContain('+fn THREE() {}');
    expect(mod).toContain(' fn one() {}'); // context line unchanged

    // log --json carries the signed why.
    out.length = 0;
    await run(['log', '--json'], e(a));
    const log = JSON.parse(out.join('')) as { why: { intent: string }[] }[];
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].why[0].intent).toBe('initial import');

    // --since in the far future filters everything out.
    out.length = 0;
    await run(['log', '--since', '2999-01-01T00:00:00Z', '--json'], e(a));
    expect(JSON.parse(out.join(''))).toEqual([]);
  });
});
