import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { AccessDenied, address, MemoryStore } from '../src/index';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

beforeAll(async () => {
  await ready();
});

describe('MemoryStore', () => {
  test('owner reads; stored bytes are ciphertext (zero plaintext at rest)', async () => {
    const store = new MemoryStore();
    const alice = Identity.create();
    const secret = 'DATABASE_URL=postgres://app/prod';
    const ref = await store.put(enc(secret), alice);
    expect(dec(await store.get(ref, alice))).toBe(secret);
    const raw = store.rawObject(ref.id);
    expect(raw).toBeDefined();
    expect(dec(raw!.ciphertext).includes('postgres')).toBe(false);
  });

  test('a non-grantee cannot decrypt', async () => {
    const store = new MemoryStore();
    const ref = await store.put(enc('s3cret'), Identity.create());
    expect(store.get(ref, Identity.create())).rejects.toBeInstanceOf(
      AccessDenied
    );
  });

  test('grant lets a grantee read', async () => {
    const store = new MemoryStore();
    const alice = Identity.create();
    const bob = Identity.create();
    const ref = await store.put(enc('s3cret'), alice);
    await store.grant(ref, bob.toPublic(), alice);
    expect(dec(await store.get(ref, bob))).toBe('s3cret');
  });

  test('revoke is forward-only: revoked loses access, others keep it', async () => {
    const store = new MemoryStore();
    const alice = Identity.create();
    const bob = Identity.create();
    const ref = await store.put(enc('s3cret'), alice);
    await store.grant(ref, bob.toPublic(), alice);
    await store.revoke(ref, bob.toPublic(), alice);
    expect(store.get(ref, bob)).rejects.toBeInstanceOf(AccessDenied);
    expect(dec(await store.get(ref, alice))).toBe('s3cret');
  });

  test('addressing + integrity: id is blake3(ciphertext); verify detects it', async () => {
    const store = new MemoryStore();
    const ref = await store.put(enc('s3cret'), Identity.create());
    const raw = store.rawObject(ref.id)!;
    expect(address(raw.ciphertext)).toBe(ref.id);
    expect(store.verify(ref.id)).toBe(true);
  });

  test('plaintext_id is stable across rotation', async () => {
    const store = new MemoryStore();
    const alice = Identity.create();
    const bob = Identity.create();
    const ref = await store.put(enc('s3cret'), alice);
    const before = ref.plaintext_id;
    await store.grant(ref, bob.toPublic(), alice);
    await store.revoke(ref, bob.toPublic(), alice);
    expect(ref.plaintext_id).toBe(before);
    expect(dec(await store.get(ref, alice))).toBe('s3cret');
  });

  test('revoke completes well under a second', async () => {
    const store = new MemoryStore();
    const alice = Identity.create();
    const bob = Identity.create();
    const ref = await store.put(enc('s3cret'), alice);
    await store.grant(ref, bob.toPublic(), alice);
    const t0 = performance.now();
    await store.revoke(ref, bob.toPublic(), alice);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test('current() follows rotation to the latest object', async () => {
    const store = new MemoryStore();
    const alice = Identity.create();
    const bob = Identity.create();
    const ref = await store.put(enc('s3cret'), alice);
    expect(store.current(ref.plaintext_id)?.id).toBe(ref.id);
    await store.grant(ref, bob.toPublic(), alice);
    await store.revoke(ref, bob.toPublic(), alice);
    const after = store.current(ref.plaintext_id);
    expect(after).toBeDefined();
    expect(after?.plaintext_id).toBe(ref.plaintext_id);
    expect(after?.id).not.toBe(ref.id);
  });

  test('get accepts an injected now without breaking an always-valid grant (clock smoke test)', async () => {
    // Smoke test that get tolerates an injected `now` for an EPOCH grant. This
    // does NOT prove `now` gates access (an always-valid grant reads at any
    // now). The real proof — denial before T, success at/after T against a
    // future not_before — lives in membrane.test.ts via scheduleReveal, the
    // only public path that produces a future-dated capability.
    const store = new MemoryStore();
    const alice = Identity.create();
    const bob = Identity.create();
    const ref = await store.put(new TextEncoder().encode('hi'), alice);

    await store.grant(ref, bob.toPublic(), alice);
    const early = '2000-01-01T00:00:00.000Z';
    expect(new TextDecoder().decode(await store.get(ref, bob, early))).toBe(
      'hi'
    );
  });
});
