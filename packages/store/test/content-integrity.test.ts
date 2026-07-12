import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { issueCapability } from '../src/capability';
import { encrypt, newContentKey } from '../src/object';
import { AccessDenied, MemoryStore } from '../src/store';
import { expectRejects } from './reject';

beforeAll(async () => {
  await ready();
});

const enc = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('content integrity', () => {
  test('a substituted current object is rejected, not decrypted', async () => {
    const owner = Identity.create();
    const victim = Identity.create();
    const attacker = Identity.create();
    const store = new MemoryStore();
    const ref = await store.put(enc('REAL'), owner);

    const evilKey = newContentKey();
    const evil = encrypt(enc('EVIL'), evilKey);
    const forgedObject = { ...evil, plaintext_id: ref.plaintext_id };
    const attackerCap = issueCapability({
      object: ref.plaintext_id,
      contentKey: evilKey,
      grantee: victim.toPublic(),
      grantedBy: attacker,
    });

    await store.ingest(forgedObject, [attackerCap]);
    await expectRejects(store.get(ref, victim), AccessDenied);
  });

  test('a tampered wrapped_key yields denial, not garbage', async () => {
    const owner = Identity.create();
    const store = new MemoryStore();
    const ref = await store.put(enc('REAL'), owner);
    const object = store.current(ref.plaintext_id)!;
    const [cap] = store.caps(ref.plaintext_id);
    const tampered = {
      ...cap,
      wrapped_key: owner.toPublic().seal(newContentKey()),
    };

    await store.ingest(object, [tampered]);
    expect(store.caps(ref.plaintext_id)).toHaveLength(0);
    await expectRejects(store.get(ref, owner), AccessDenied);
  });
});
