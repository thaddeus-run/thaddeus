import { scoped } from '@thaddeus.run/store';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileBackend } from '../src/file';
import { MemoryBackend } from '../src/memory';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-persist-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

for (const [name, make] of [
  ['MemoryBackend', () => new MemoryBackend()],
  ['FileBackend', () => new FileBackend(mkdtempSync(join(tmp, 'b-')))],
] as const) {
  describe(`${name} — Backend contract`, () => {
    test('put/get round-trips; absent get is undefined; delete is idempotent', async () => {
      const b = make();
      expect(await b.get('obj/x')).toBeUndefined();
      await b.put('obj/x', enc('hello'));
      expect(dec((await b.get('obj/x'))!)).toBe('hello');
      await b.delete('obj/x');
      expect(await b.get('obj/x')).toBeUndefined();
      await b.delete('obj/x'); // no throw
    });

    test('list returns keys under a prefix; keys with slashes round-trip', async () => {
      const b = make();
      await b.put('view/main', enc('m'));
      await b.put('view/ws/main/0', enc('w'));
      await b.put('op/abc', enc('o'));
      expect([...(await b.list('view/'))].sort()).toEqual([
        'view/main',
        'view/ws/main/0',
      ]);
      expect(dec((await b.get('view/ws/main/0'))!)).toBe('w');
    });

    test('put overwrites an existing key', async () => {
      const b = make();
      await b.put('current/p', enc('a'));
      await b.put('current/p', enc('b'));
      expect(dec((await b.get('current/p'))!)).toBe('b');
    });

    test('putIfAbsent atomically preserves the first value', async () => {
      const b = make();
      expect(await b.putIfAbsent('head/0', enc('first'))).toBe(true);
      expect(await b.putIfAbsent('head/0', enc('second'))).toBe(false);
      expect(dec((await b.get('head/0'))!)).toBe('first');
    });
  });
}

describe('FileBackend — malformed filenames', () => {
  test('list skips an undecodable filename instead of throwing', async () => {
    const root = mkdtempSync(join(tmp, 'malformed-'));
    const b = new FileBackend(root);
    await b.put('op/abc', enc('o'));
    // A stray file whose name is not valid percent-encoding (decodeURIComponent
    // would throw URIError). list() must skip it, not abort the whole load.
    writeFileSync(join(root, '%GG'), enc('garbage'));
    expect([...(await b.list(''))]).toEqual(['op/abc']);
  });
});

describe('scoped', () => {
  test('prefixes keys and isolates namespaces', async () => {
    const base = new MemoryBackend();
    const a = scoped(base, 'repo/a/');
    const b = scoped(base, 'repo/b/');
    await a.put('view/main', enc('A'));
    await b.put('view/main', enc('B'));
    expect(dec((await a.get('view/main'))!)).toBe('A');
    expect(dec((await b.get('view/main'))!)).toBe('B');
    expect([...(await a.list('view/'))]).toEqual(['view/main']);
  });
});
