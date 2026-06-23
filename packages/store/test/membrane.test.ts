import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { publicDid, publicIdentity } from '../src/membrane';
import { MemoryStore } from '../src/store';
import { expectRejects } from './reject';

beforeAll(async () => {
  await ready();
});

describe('public identity', () => {
  test('is stable and world-constructible', () => {
    expect(publicIdentity().did).toBe(publicDid());
    expect(publicDid().startsWith('did:key:z')).toBe(true);
    // Memoized: same instance every call.
    expect(publicIdentity()).toBe(publicIdentity());
  });
});

describe('scheduled reveal (manual trigger)', () => {
  const T = '2030-01-01T00:00:00.000Z';
  const beforeT = '2026-06-23T00:00:00.000Z';

  test('withheld until released, then public can read', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const ref = await store.put(new TextEncoder().encode('fix'), author);
    await store.scheduleReveal(ref, T, author);

    // Withheld: no served capability is wrapped to the public identity.
    expect(
      store.caps(ref.plaintext_id).some((c) => c.grantee === publicDid())
    ).toBe(false);
    // And the public identity cannot read before T, even with a read attempt.
    await expectRejects(store.get(ref, publicIdentity(), beforeT));

    // Releasing before T does nothing.
    expect(await store.reveal(ref, beforeT)).toBe(false);

    // Release at T: the public capability is now served and readable.
    expect(await store.reveal(ref, T)).toBe(true);
    expect(
      store.caps(ref.plaintext_id).some((c) => c.grantee === publicDid())
    ).toBe(true);
    expect(
      new TextDecoder().decode(await store.get(ref, publicIdentity(), T))
    ).toBe('fix');
  });
});

describe('scheduled reveal (timestamp trigger, lazy on get)', () => {
  const T = '2030-01-01T00:00:00.000Z';
  const beforeT = '2026-06-23T00:00:00.000Z';

  test('public read fires the reveal at or after T without a manual call', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const ref = await store.put(new TextEncoder().encode('fix'), author);
    await store.scheduleReveal(ref, T, author);

    // Before T: still denied (the read attempt releases nothing).
    await expectRejects(store.get(ref, publicIdentity(), beforeT));
    // At/after T: the get itself triggers the key-release.
    expect(
      new TextDecoder().decode(await store.get(ref, publicIdentity(), T))
    ).toBe('fix');
  });
});

describe('scheduled reveal (partial release)', () => {
  const T1 = '2030-01-01T00:00:00.000Z';
  const T2 = '2040-01-01T00:00:00.000Z';
  const between = '2035-01-01T00:00:00.000Z';

  test('releasing at T1<=now<T2 reveals once and retains the later reveal', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const ref = await store.put(new TextEncoder().encode('fix'), author);
    await store.scheduleReveal(ref, T1, author);
    await store.scheduleReveal(ref, T2, author);

    // At `between`: the T1 reveal fires, public can read.
    expect(
      new TextDecoder().decode(await store.get(ref, publicIdentity(), between))
    ).toBe('fix');
    // Exactly one served public cap now (the T1 reveal); the T2 reveal is still withheld.
    expect(
      store.caps(ref.plaintext_id).filter((c) => c.grantee === publicDid())
        .length
    ).toBe(1);
    // Releasing again at `between` finds nothing new due (T2 not yet due).
    expect(await store.reveal(ref, between)).toBe(false);
  });
});

describe('malformed now timestamp', () => {
  test('get throws RangeError on a malformed now string', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const ref = await store.put(new TextEncoder().encode('hi'), author);
    await expectRejects(store.get(ref, author, 'not-a-date'), RangeError);
  });

  test('reveal throws RangeError on a malformed now string', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const ref = await store.put(new TextEncoder().encode('hi'), author);
    await expectRejects(store.reveal(ref, 'not-a-date'), RangeError);
  });

  test('scheduleReveal throws RangeError on a malformed at string', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const ref = await store.put(new TextEncoder().encode('hi'), author);
    await expectRejects(
      store.scheduleReveal(ref, 'not-a-date', author),
      RangeError
    );
  });
});

describe('reveal interaction with revoke', () => {
  const T = '2030-01-01T00:00:00.000Z';

  test('a scheduled reveal survives a key rotation', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const bob = Identity.create();
    const ref = await store.put(new TextEncoder().encode('fix'), author);
    await store.scheduleReveal(ref, T, author);
    await store.grant(ref, bob.toPublic(), author);
    await store.revoke(ref, bob.toPublic(), author); // rotates the content key

    // The pending reveal was re-keyed; at T the public reads the live object.
    expect(
      new TextDecoder().decode(await store.get(ref, publicIdentity(), T))
    ).toBe('fix');
  });

  test('revoking the public identity cancels a pending reveal', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const ref = await store.put(new TextEncoder().encode('fix'), author);
    await store.scheduleReveal(ref, T, author);
    await store.revoke(ref, publicIdentity().toPublic(), author); // cancel

    await expectRejects(store.get(ref, publicIdentity(), T));
  });
});
