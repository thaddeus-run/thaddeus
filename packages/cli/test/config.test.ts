import { ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HOSTED_SERVER } from '../src/config';
import { run } from '../src/run';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-use-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A fresh home + an in-memory server reachable over the injected fetch. The
// server URL passed to the CLI is irrelevant to transport (fetchImpl handles
// it), so any http(s) string exercises the resolution logic.
function harness() {
  const home = mkdtempSync(join(tmp, 'home-'));
  const out: string[] = [];
  const srv = createServer({ backend: new MemoryBackend() });
  const e = {
    cwd: home,
    home,
    fetchImpl: srv.fetch.bind(srv),
    out: (l: string) => out.push(l),
  };
  return { home, out, e };
}

const cfgPath = (home: string): string =>
  join(home, '.config', 'thaddeus', 'config.json');
const savedServer = (home: string): string | undefined =>
  (
    JSON.parse(readFileSync(cfgPath(home), 'utf8')) as {
      defaultServer?: string;
    }
  ).defaultServer;

describe('thaddeus use (default server)', () => {
  test('set, show, --json, --hosted, --clear; file is 0600', async () => {
    const { home, out, e } = harness();

    expect(await run(['use', 'https://my-host:4000'], e)).toBe(0);
    expect(savedServer(home)).toBe('https://my-host:4000');
    expect((statSync(cfgPath(home)).mode & 0o777) === 0o600).toBe(true);

    out.length = 0;
    expect(await run(['use'], e)).toBe(0);
    expect(out.join('\n')).toBe('https://my-host:4000');

    out.length = 0;
    expect(await run(['use', '--json'], e)).toBe(0);
    expect(JSON.parse(out[0])).toEqual({
      defaultServer: 'https://my-host:4000',
    });

    expect(await run(['use', '--hosted'], e)).toBe(0);
    expect(savedServer(home)).toBe(HOSTED_SERVER);

    expect(await run(['use', '--clear'], e)).toBe(0);
    expect(savedServer(home)).toBeUndefined();
  });

  test('bare use with no default hints at --hosted', async () => {
    const { out, e } = harness();
    expect(await run(['use'], e)).toBe(0);
    expect(out.join('\n')).toContain('--hosted');
  });

  test('rejects a non-url and a scheme-only url', async () => {
    const { out, e } = harness();
    expect(await run(['use', 'not-a-url'], e)).toBe(2);
    expect(await run(['use', 'https://'], e)).toBe(2); // scheme, no host
    expect(out.join('\n')).toContain('invalid server url');
  });

  test('--hosted together with a positional url is rejected', async () => {
    const { out, e } = harness();
    expect(await run(['use', '--hosted', 'https://x'], e)).toBe(2);
    expect(out.join('\n')).toContain('not both');
  });
});

describe('create/clone server resolution', () => {
  test('uses the saved default when no server is passed', async () => {
    const { out, e } = harness();
    await run(['init'], { ...e, out: () => {} });
    await run(['use', 'http://t'], { ...e, out: () => {} });
    out.length = 0;
    expect(await run(['create', 'r'], e)).toBe(0);
    expect(out.join('\n')).toContain('created r');
  });

  test('--server overrides, and a leading url still works (back-compat)', async () => {
    const { e } = harness();
    await run(['init'], { ...e, out: () => {} });

    const flag: string[] = [];
    expect(
      await run(['create', 'a', '--server', 'http://t'], {
        ...e,
        out: (l) => flag.push(l),
      })
    ).toBe(0);
    expect(flag.join('\n')).toContain('created a');

    const positional: string[] = [];
    expect(
      await run(['create', 'http://t', 'b'], {
        ...e,
        out: (l) => positional.push(l),
      })
    ).toBe(0);
    expect(positional.join('\n')).toContain('created b');
  });

  test('an invalid --server is rejected before contacting a server', async () => {
    const { out, e } = harness();
    expect(await run(['create', 'r', '--server', 'nope'], e)).toBe(2);
    expect(out.join('\n')).toContain('invalid --server url');
  });

  test('no server and no default prints the first-run hint (exit 2)', async () => {
    const { out, e } = harness();
    expect(await run(['create', 'r'], e)).toBe(2);
    expect(out.join('\n')).toContain('use --hosted');
  });

  test('clone resolves the default and records it', async () => {
    const { e } = harness();
    await run(['init'], { ...e, out: () => {} });
    await run(['use', 'http://t'], { ...e, out: () => {} });
    await run(['create', 'repo1'], { ...e, out: () => {} });

    const dir = mkdtempSync(join(tmp, 'work-'));
    const out: string[] = [];
    expect(
      await run(['clone', 'repo1'], { ...e, cwd: dir, out: (l) => out.push(l) })
    ).toBe(0);
    expect(
      readFileSync(join(dir, 'repo1', '.thaddeus', 'config.json'), 'utf8')
    ).toContain('"server": "http://t"');
  });
});
