import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

// The brief's "one edit, end to end" flow. Tier 0 (identity + store) is real
// today; higher pillars are test.todo and become real as each ships. See
// ARCHITECTURE.md → north-star flow.
beforeAll(async () => {
  await ready();
});

describe('north-star: one edit, end to end', () => {
  test('P05/P01: write an object → stored as ciphertext a mirror can verify', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const ref = await store.put(
      new TextEncoder().encode('fn refresh() {}'),
      author
    );
    expect(store.verify(ref.id)).toBe(true);
    expect(store.rawObject(ref.id)).toBeDefined();
  });

  test('P01/P02: grant releases the content key to a named grantee', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const reviewer = Identity.create();
    const ref = await store.put(
      new TextEncoder().encode('fn refresh() {}'),
      author
    );
    await store.grant(ref, reviewer.toPublic(), author);
    expect(new TextDecoder().decode(await store.get(ref, reviewer))).toBe(
      'fn refresh() {}'
    );
  });

  // @ts-expect-error bun-types@1.3.12 requires a fn arg, but the runtime supports label-only todo
  test.todo('P03: the edit is recorded as a signed Op in the operation log');
  // @ts-expect-error bun-types@1.3.12 requires a fn arg, but the runtime supports label-only todo
  test.todo('P04: a signed Provenance record attaches the why to the Op');
  // @ts-expect-error bun-types@1.3.12 requires a fn arg, but the runtime supports label-only todo
  test.todo('P02: a scheduled reveal re-wraps the content key to public at T');
});
