import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import type { Backend } from '../src/backend';
import { MemoryStore } from '../src/store';

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
});
