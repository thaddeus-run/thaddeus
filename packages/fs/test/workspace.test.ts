import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Workspace } from '../src/workspace';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('Workspace — open, edit overlay, reads', () => {
  test('a staged write is readable, listed, and shown in status before any commit', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });

    ws.write('src/a.rs', enc('fn a() {}'));
    expect(dec((await ws.read('src/a.rs'))!)).toBe('fn a() {}');
    expect(await ws.list()).toEqual(['src/a.rs']);
    expect(ws.status()).toEqual([{ path: 'src/a.rs', change: 'write' }]);
  });

  test('read returns null for an absent path', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    expect(await ws.read('nope.rs')).toBeNull();
  });

  test('reads project the pinned base (a pre-seeded op); an overlay write shadows it', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    // Seed the source view BEFORE opening — this is the base the workspace forks.
    await log.write('main', 'src/auth.rs', enc('fn old() {}'), author);

    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    expect(dec((await ws.read('src/auth.rs'))!)).toBe('fn old() {}');
    expect(await ws.list()).toContain('src/auth.rs');

    ws.write('src/auth.rs', enc('fn new() {}'));
    expect(dec((await ws.read('src/auth.rs'))!)).toBe('fn new() {}');
  });

  test('rm stages a tombstone: read null, gone from list, status shows rm', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    await log.write('main', 'src/auth.rs', enc('fn old() {}'), author);
    const ws = Workspace.open(log, store, { source: 'main', reader: author });

    ws.rm('src/auth.rs');
    expect(await ws.read('src/auth.rs')).toBeNull();
    expect(await ws.list()).not.toContain('src/auth.rs');
    expect(ws.status()).toEqual([{ path: 'src/auth.rs', change: 'rm' }]);
  });

  test('list filters by prefix and returns a sorted, deterministic order', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    ws.write('src/b.rs', enc('b'));
    ws.write('src/a.rs', enc('a'));
    ws.write('docs/x.md', enc('x'));
    expect(await ws.list('src/')).toEqual(['src/a.rs', 'src/b.rs']);
    expect(await ws.list()).toEqual(['docs/x.md', 'src/a.rs', 'src/b.rs']);
  });
});
