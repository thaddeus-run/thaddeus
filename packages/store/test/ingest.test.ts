import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { issueCapability } from '../src/capability';
import { encrypt, newContentKey } from '../src/object';
import { MemoryStore } from '../src/store';
import { expectRejects } from './reject';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('MemoryStore.ingest', () => {
  test('ingests a verified object + cap so the grantee can read', async () => {
    const owner = Identity.create();
    const key = newContentKey();
    const object = encrypt(enc('fn refresh() {}'), key);
    const cap = issueCapability({
      object: object.plaintext_id,
      contentKey: key,
      grantee: owner.toPublic(),
      grantedBy: owner,
    });

    const store = new MemoryStore();
    await store.ingest(object, [cap]);
    expect(store.rawObject(object.id)).toBeDefined();
    expect(Object.isFrozen(store.rawObject(object.id))).toBe(true);
    const ref = { id: object.id, plaintext_id: object.plaintext_id };
    expect(dec(await store.get(ref, owner))).toBe('fn refresh() {}');
  });

  test('rejects a mis-addressed object', async () => {
    const key = newContentKey();
    const object = encrypt(enc('x'), key);
    const tampered = { ...object, id: 'blake3:deadbeef' };
    const store = new MemoryStore();
    await expectRejects(store.ingest(tampered, []));
    expect(store.rawObject('blake3:deadbeef')).toBeUndefined();
  });

  test('drops an invalid capability but keeps the object', async () => {
    const owner = Identity.create();
    const key = newContentKey();
    const object = encrypt(enc('y'), key);
    const cap = issueCapability({
      object: object.plaintext_id,
      contentKey: key,
      grantee: owner.toPublic(),
      grantedBy: owner,
    });
    const forged = { ...cap, sig: new Uint8Array(cap.sig.length) }; // zeroed sig
    const store = new MemoryStore();
    await store.ingest(object, [forged]);
    expect(store.rawObject(object.id)).toBeDefined();
    expect(store.caps(object.plaintext_id)).toHaveLength(0); // invalid cap dropped
  });
});
