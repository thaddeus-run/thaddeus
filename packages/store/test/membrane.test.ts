import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { publicDid, publicIdentity } from '../src/membrane';
import { MemoryStore } from '../src/store';

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
    // And the public identity cannot read before release, even at a far-future now.
    expect(store.get(ref, publicIdentity(), T)).rejects.toThrow();

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
