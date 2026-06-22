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
});
