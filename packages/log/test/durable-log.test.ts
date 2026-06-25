import { Identity, ready } from '@thaddeus.run/identity';
import type { Backend } from '@thaddeus.run/store';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { OpLog } from '../src/oplog';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function memoryBackend(): Backend {
  const m = new Map<string, Uint8Array>();
  return {
    put: async (k, b) => void m.set(k, new Uint8Array(b)),
    get: async (k) => {
      const v = m.get(k);
      return v === undefined ? undefined : new Uint8Array(v);
    },
    list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
    delete: async (k) => void m.delete(k),
  };
}

describe('OpLog — durable mode', () => {
  test('write-through then reload: ops + views survive', async () => {
    const backend = memoryBackend();
    const author = Identity.create();

    const store = new MemoryStore(backend);
    const log = new OpLog(store, backend);
    const op = await log.write('main', 'src/a.rs', enc('fn a() {}'), author);

    // Discard log+store; rebuild from the backend (store first, then log).
    const store2 = await MemoryStore.open(backend);
    const log2 = await OpLog.load(store2, backend);
    expect(log2.heads('main')).toEqual([op.id]);
    expect(log2.materialize('main').get('src/a.rs')?.op.id).toBe(op.id);
    expect(log2.verify(op.id)).toBe(true);
  });

  test('repoint persists a shared view re-point', async () => {
    const backend = memoryBackend();
    const author = Identity.create();
    const store = new MemoryStore(backend);
    const log = new OpLog(store, backend);
    const op = await log.write('feature', 'x.rs', enc('x'), author);
    await log.repoint('main', [op.id]);

    const log2 = await OpLog.load(await MemoryStore.open(backend), backend);
    expect(log2.heads('main')).toEqual([op.id]);
  });

  test('no backend ⇒ unchanged behavior', async () => {
    const author = Identity.create();
    const log = new OpLog(new MemoryStore());
    const op = await log.write('main', 'a', enc('a'), author);
    expect(log.heads('main')).toEqual([op.id]);
  });
});
