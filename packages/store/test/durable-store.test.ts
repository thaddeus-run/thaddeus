import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { type Backend, scanKeys } from '../src/backend';
import { issueCapability } from '../src/capability';
import { publicIdentity } from '../src/membrane';
import { encrypt, newContentKey } from '../src/object';
import { MemoryStore } from '../src/store';
import { expectRejects } from './reject';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// A minimal in-test backend (avoids depending on @thaddeus.run/persist here).
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

describe('MemoryStore — durable mode', () => {
  test('write-through then reopen: objects + a grant survive', async () => {
    const backend = memoryBackend();
    const owner = Identity.create();
    const reader = Identity.create();

    const a = new MemoryStore(backend);
    const ref = await a.put(enc('fn refresh() {}'), owner);
    await a.grant(ref, reader.toPublic(), owner);

    // Discard `a`; rebuild purely from the backend.
    const b = await MemoryStore.open(backend);
    expect(dec(await b.get(ref, owner))).toBe('fn refresh() {}');
    expect(dec(await b.get(ref, reader))).toBe('fn refresh() {}'); // grant survived
    expect(b.verify(ref.id)).toBe(true);
  });

  test('a cached object is frozen (freeze-on-store)', async () => {
    const backend = memoryBackend();
    const owner = Identity.create();
    const a = new MemoryStore(backend);
    const ref = await a.put(enc('x'), owner);
    expect(Object.isFrozen(a.rawObject(ref.id))).toBe(true);
    const b = await MemoryStore.open(backend);
    expect(Object.isFrozen(b.rawObject(ref.id))).toBe(true);
  });

  test('a torn object blob (id mismatch) is skipped on load', async () => {
    const backend = memoryBackend();
    const owner = Identity.create();
    const a = new MemoryStore(backend);
    const ref = await a.put(enc('x'), owner);
    // Corrupt the stored blob under its key (simulate a torn write).
    await backend.put(
      `obj/${ref.id}`,
      enc(
        '{"v":"tplv1","d":{"id":"' +
          ref.id +
          '","plaintext_id":"' +
          ref.plaintext_id +
          '","alg":"x","nonce":{"$u8":""},"ciphertext":{"$u8":""}}}'
      )
    );
    const b = await MemoryStore.open(backend);
    expect(b.rawObject(ref.id)).toBeUndefined(); // skipped, not trusted
  });

  test('no backend ⇒ unchanged behavior', async () => {
    const owner = Identity.create();
    const s = new MemoryStore();
    const ref = await s.put(enc('y'), owner);
    expect(dec(await s.get(ref, owner))).toBe('y');
  });

  test('a garbage/undecodable blob under obj/ is skipped — reload does not abort', async () => {
    const backend = memoryBackend();
    const owner = Identity.create();

    // Write a valid object so we have something to verify survives.
    const a = new MemoryStore(backend);
    const ref = await a.put(enc('valid payload'), owner);

    // Inject a garbage blob under the same namespace but a different key.
    await backend.put('obj/zzz', new TextEncoder().encode('not json'));

    // Reload must not throw — the garbage key is skipped and the valid object
    // is still present.
    const b = await MemoryStore.open(backend);
    expect(b.rawObject('zzz' as string)).toBeUndefined();
    expect(b.rawObject(ref.id)).toBeDefined();
    expect(dec(await b.get(ref, owner))).toBe('valid payload');
  });

  test('a pending reveal survives restart and its released capability persists', async () => {
    const backend = memoryBackend();
    const owner = Identity.create();
    const ref = await new MemoryStore(backend).put(enc('public later'), owner);
    const first = await MemoryStore.open(backend);
    await first.scheduleReveal(ref, '2030-01-01T00:00:00.000Z', owner);

    const scheduler = await MemoryStore.open(backend);
    expect(scheduler.pendingReveals(ref.plaintext_id)).toHaveLength(1);
    expect(await scheduler.revealDue('2030-01-01T00:00:00.000Z')).toBe(1);

    const restarted = await MemoryStore.open(backend);
    expect(restarted.pendingReveals(ref.plaintext_id)).toHaveLength(0);
    expect(
      dec(
        await restarted.get(ref, Identity.create(), '2030-01-01T00:00:00.000Z')
      )
    ).toBe('public later');
  });

  test('a recall journal restores failures at every persistence boundary', async () => {
    for (const boundary of ['obj', 'current', 'cap', 'pending']) {
      const inner = memoryBackend();
      let failKey: string | undefined;
      let failed = false;
      const backend: Backend = {
        put: async (key, bytes) => {
          if (key === failKey && !failed) {
            failed = true;
            throw new Error(`injected ${boundary} write failure`);
          }
          await inner.put(key, bytes);
        },
        get: (key) => inner.get(key),
        openScan: (prefix) => inner.openScan(prefix),
        list: (prefix) => inner.list(prefix),
        delete: (key) => inner.delete(key),
      };
      const owner = Identity.create();
      const ref = await new MemoryStore(backend).put(
        enc('survives recall'),
        owner
      );
      const first = await MemoryStore.open(backend);
      const at = '2030-01-01T00:00:00.000Z';
      await first.scheduleReveal(ref, at, owner);
      const key = newContentKey();
      const object = encrypt(enc('survives recall'), key);
      const ownerCap = issueCapability({
        object: ref.plaintext_id,
        contentKey: key,
        grantee: owner.toPublic(),
        grantedBy: owner,
      });
      const revealCap = issueCapability({
        object: ref.plaintext_id,
        contentKey: key,
        grantee: publicIdentity().toPublic(),
        grantedBy: owner,
        notBefore: at,
      });
      failKey =
        boundary === 'obj'
          ? `obj/${object.id}`
          : `${boundary}/${ref.plaintext_id}`;

      await expectRejects(
        first.ingestRecall(object, [ownerCap], [revealCap]),
        Error
      );
      const restarted = await MemoryStore.open(backend);

      expect(await restarted.revealDue(at)).toBe(1);
      expect(dec(await restarted.get(ref, Identity.create(), at))).toBe(
        'survives recall'
      );
      expect(await backend.list('recall/')).toHaveLength(0);
    }
  });

  test('a stale recall journal cannot roll back a later grant', async () => {
    const inner = memoryBackend();
    let failDelete = true;
    const backend: Backend = {
      put: (key, bytes) => inner.put(key, bytes),
      get: (key) => inner.get(key),
      openScan: (prefix) => inner.openScan(prefix),
      list: (prefix) => inner.list(prefix),
      delete: async (key) => {
        if (failDelete && key.startsWith('recall/')) {
          failDelete = false;
          throw new Error('injected journal delete failure');
        }
        await inner.delete(key);
      },
    };
    const owner = Identity.create();
    const reader = Identity.create();
    const ref = await new MemoryStore(backend).put(enc('current'), owner);
    const store = await MemoryStore.open(backend);
    const key = newContentKey();
    const object = encrypt(enc('current'), key);
    const ownerCap = issueCapability({
      object: ref.plaintext_id,
      contentKey: key,
      grantee: owner.toPublic(),
      grantedBy: owner,
    });
    await store.ingestRecall(object, [ownerCap], []);
    await store.grant(ref, reader.toPublic(), owner);

    const restarted = await MemoryStore.open(backend);
    expect(dec(await restarted.get(ref, reader))).toBe('current');
  });

  test('a failed reveal promotion retries without a restart', async () => {
    for (const boundary of ['cap', 'pending']) {
      const inner = memoryBackend();
      let failKey: string | undefined;
      let failed = false;
      const backend: Backend = {
        put: async (key, bytes) => {
          if (key === failKey && !failed) {
            failed = true;
            throw new Error(`injected ${boundary} promotion failure`);
          }
          await inner.put(key, bytes);
        },
        get: (key) => inner.get(key),
        openScan: (prefix) => inner.openScan(prefix),
        list: (prefix) => inner.list(prefix),
        delete: (key) => inner.delete(key),
      };
      const owner = Identity.create();
      const store = new MemoryStore(backend);
      const ref = await store.put(enc('retry reveal'), owner);
      const at = '2030-01-01T00:00:00.000Z';
      await store.scheduleReveal(ref, at, owner);
      failKey = `${boundary}/${ref.plaintext_id}`;

      await expectRejects(store.revealDue(at), Error);
      expect(store.pendingReveals(ref.plaintext_id)).toHaveLength(1);
      expect(await store.revealDue(at)).toBe(1);
      expect(dec(await store.get(ref, Identity.create(), at))).toBe(
        'retry reveal'
      );
    }
  });
});
