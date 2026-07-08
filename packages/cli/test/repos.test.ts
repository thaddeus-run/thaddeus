import { ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/run';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-repos-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// One shared server; two homes (identities) point at it via the injected fetch.
const srv = createServer({ backend: new MemoryBackend() });
const fetchImpl = srv.fetch.bind(srv);

const names = (json: string): string[] =>
  (JSON.parse(json) as { name: string }[]).map((r) => r.name).sort();

describe('thaddeus repos + delete', () => {
  test('list, --mine filter, and owner-gated delete', async () => {
    const a = mkdtempSync(join(tmp, 'home-a-'));
    const b = mkdtempSync(join(tmp, 'home-b-'));
    const env = (h: string, out: (l: string) => void) => ({
      cwd: h,
      home: h,
      fetchImpl,
      out,
    });
    const quiet = (h: string) => env(h, () => {});

    for (const h of [a, b]) {
      await run(['init'], quiet(h));
      await run(['use', 'http://t'], quiet(h));
    }
    await run(['create', 'alice/one'], quiet(a));
    await run(['create', 'alice/two'], quiet(a));
    await run(['create', 'bob/one'], quiet(b));

    // A sees every repo…
    let out: string[] = [];
    await run(
      ['repos', '--json'],
      env(a, (l) => out.push(l))
    );
    expect(names(out[0])).toEqual(['alice/one', 'alice/two', 'bob/one']);

    // …but --mine only the two it owns.
    out = [];
    await run(
      ['repos', '--mine', '--json'],
      env(a, (l) => out.push(l))
    );
    expect(names(out[0])).toEqual(['alice/one', 'alice/two']);

    // delete without --yes → refused (exit 2), nothing removed.
    out = [];
    expect(
      await run(
        ['delete', 'alice/one'],
        env(a, (l) => out.push(l))
      )
    ).toBe(2);
    expect(out.join('\n')).toContain('--yes');

    // A cannot delete B's repo → 403 surfaced as exit 1.
    out = [];
    expect(
      await run(
        ['delete', 'bob/one', '--yes'],
        env(a, (l) => out.push(l))
      )
    ).toBe(1);
    expect(out.join('\n')).toContain('owner');

    // A deletes its own repo; it disappears from the listing.
    out = [];
    expect(
      await run(
        ['delete', 'alice/one', '--yes'],
        env(a, (l) => out.push(l))
      )
    ).toBe(0);
    expect(out.join('\n')).toContain('deleted alice/one');

    out = [];
    await run(
      ['repos', '--json'],
      env(a, (l) => out.push(l))
    );
    expect(names(out[0])).toEqual(['alice/two', 'bob/one']);
  });
});
