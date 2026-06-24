import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Workspace } from '../src/workspace';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('Workspace — grep (decryption-bounded)', () => {
  test('grep matches committed and staged content; 1-based lines, sorted by path then line', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    ws.write('src/auth.rs', enc('fn login() {}\nfn refresh() {}\n'));
    await ws.commit(author);
    ws.write('src/new.rs', enc('fn refresh_token() {}'));

    expect(await ws.grep('refresh')).toEqual([
      { path: 'src/auth.rs', line: 2, text: 'fn refresh() {}' },
      { path: 'src/new.rs', line: 1, text: 'fn refresh_token() {}' },
    ]);
  });

  test('grep skips base objects the reader cannot decrypt; read returns null', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const owner = Identity.create();
    const reader = Identity.create();
    // Owner writes a secret to `main` WITHOUT granting the reader.
    await log.write('main', 'secret.txt', enc('refresh THE SECRET'), owner);

    const ws = Workspace.open(log, store, { source: 'main', reader });
    // The path is visible (cleartext metadata) but its content is undecryptable.
    expect(await ws.list()).toContain('secret.txt');
    expect(await ws.read('secret.txt')).toBeNull();
    expect(await ws.grep('refresh')).toEqual([]); // skipped, not errored

    // A staged plaintext write IS searched.
    ws.write('mine.txt', enc('refresh mine'));
    expect(await ws.grep('refresh')).toEqual([
      { path: 'mine.txt', line: 1, text: 'refresh mine' },
    ]);
  });

  test('grep accepts a RegExp', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    ws.write('a.txt', enc('foo123bar'));
    expect(await ws.grep(/\d+/)).toEqual([
      { path: 'a.txt', line: 1, text: 'foo123bar' },
    ]);
  });
});
