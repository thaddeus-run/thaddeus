import { Identity, ready } from '@thaddeus.run/identity';
import { type Backend, scanKeys } from '@thaddeus.run/store';
import { MemoryStore, publicIdentity } from '@thaddeus.run/store';
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
    openScan: async (p) => scanKeys(m.keys(), p),
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

  test('dropView removes a durable view name without deleting ops', async () => {
    const backend = memoryBackend();
    const author = Identity.create();
    const store = new MemoryStore(backend);
    const log = new OpLog(store, backend);
    const op = await log.write('feature', 'x.rs', enc('x'), author);
    await log.repoint('land/inspect/feature', [op.id]);

    await log.dropView('land/inspect/feature');

    const log2 = await OpLog.load(await MemoryStore.open(backend), backend);
    expect(log2.heads('land/inspect/feature')).toEqual([]);
    expect(log2.views()).not.toContain('land/inspect/feature');
    expect(log2.verify(op.id)).toBe(true);
  });

  test('no backend ⇒ unchanged behavior', async () => {
    const author = Identity.create();
    const log = new OpLog(new MemoryStore());
    const op = await log.write('main', 'a', enc('a'), author);
    expect(log.heads('main')).toEqual([op.id]);
  });

  test('embargo write-through + reveal survive a reload', async () => {
    const T = '2030-01-01T00:00:00.000Z';
    const beforeT = '2026-06-24T00:00:00.000Z';
    const backend = memoryBackend();
    const maintainer = Identity.create();

    // Write an embargoed op into a backend-backed log.
    const store = new MemoryStore(backend);
    const log = new OpLog(store, backend);
    const op = await log.write('main', 'src/auth.ts', enc('fix'), maintainer, {
      embargoUntil: T,
    });

    // Discard log+store; rebuild from the backend (store first, then log).
    const store2 = await MemoryStore.open(backend);
    const log2 = await OpLog.load(store2, backend);

    // The op survived the reload and the view head is intact.
    expect(log2.heads('main')).toEqual([op.id]);

    // The embargo state survived: public materialize hides the op, but the
    // maintainer (capability holder) still sees it placed.
    expect(log2.materialize('main').has('src/auth.ts')).toBe(false);
    expect(log2.materialize('main', maintainer).has('src/auth.ts')).toBe(true);

    // publicView still returns the opaque embargoed token, not the open op.
    const pv = log2.publicView(op.id);
    expect(pv.kind).toBe('embargoed');
    if (pv.kind === 'embargoed') {
      expect(pv.ordering_token.length).toBeGreaterThan(0);
      expect(JSON.stringify(pv)).not.toContain('src/auth.ts');
    }

    // Before T the reveal still fails.
    expect(await log2.reveal(op.id, beforeT)).toBe(false);
    expect(log2.materialize('main').has('src/auth.ts')).toBe(false);

    // At T the key-release fires; the op lands publicly and the backend is
    // updated so a further reload would also see revealed: true.
    expect(await log2.reveal(op.id, T)).toBe(true);
    expect(log2.publicView(op.id).kind).toBe('open');
    expect(log2.materialize('main').get('src/auth.ts')?.op.id).toBe(op.id);

    // The sealed metadata is now world-readable via the membrane.
    const sealed = pv.kind === 'embargoed' ? pv.sealed_meta : undefined;
    if (sealed !== undefined) {
      const meta = await store2.get(sealed, publicIdentity(), T);
      expect(new TextDecoder().decode(meta).length).toBeGreaterThan(0);
    }
  });

  test('a garbage/undecodable blob under op/ is skipped — load does not abort', async () => {
    const backend = memoryBackend();
    const author = Identity.create();

    // Write a valid op so we have something to verify survives.
    const store = new MemoryStore(backend);
    const log = new OpLog(store, backend);
    const op = await log.write('main', 'src/a.rs', enc('fn a() {}'), author);

    // Inject a garbage blob under the same namespace but a different key.
    await backend.put('op/zzz', new TextEncoder().encode('not json'));

    // Reload must not throw — the garbage key is skipped and the valid op is
    // still present.
    const store2 = await MemoryStore.open(backend);
    const log2 = await OpLog.load(store2, backend);
    expect(log2.heads('main')).toEqual([op.id]);
    expect(log2.verify(op.id)).toBe(true);
    // The garbage key does not appear in materialize or ops().
    expect(log2.ops().find((o) => o.id === 'zzz')).toBeUndefined();
  });
});
