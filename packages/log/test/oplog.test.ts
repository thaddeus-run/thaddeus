import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { verifyOp } from '../src/op';
import { OpLog } from '../src/oplog';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('OpLog write + clock', () => {
  test('write records a signed op; lamport starts at 0 then increments', async () => {
    const log = new OpLog(new MemoryStore());
    const author = Identity.create();

    const a = await log.write('main', 'a.ts', enc('one'), author);
    expect(verifyOp(a)).toBe(true);
    expect(a.parents).toEqual([]);
    expect(a.lamport).toBe(0);

    const b = await log.write('main', 'a.ts', enc('two'), author);
    expect(b.parents).toEqual([a.id]);
    expect(b.lamport).toBe(1);

    // ops() is sorted by (lamport, id): a (0) before b (1).
    expect(log.ops().map((o) => o.id)).toEqual([a.id, b.id]);
  });

  test('ops() breaks lamport ties by id (deterministic total order)', async () => {
    const log = new OpLog(new MemoryStore());
    const author = Identity.create();
    // Two root ops in different views → both lamport 0, concurrent.
    const a = await log.write('main', 'a.ts', enc('a'), author);
    const b = await log.write('feature', 'b.ts', enc('b'), author);
    expect(a.lamport).toBe(0);
    expect(b.lamport).toBe(0);
    expect(log.ops().map((o) => o.id)).toEqual([a.id, b.id].sort());
  });
});

describe('OpLog materialize (LWW per path, cleartext only)', () => {
  test('latest write per path wins; content reads back via the store', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();

    await log.write('main', 'a.ts', enc('a1'), author);
    await log.write('main', 'b.ts', enc('b1'), author);
    const a2 = await log.write('main', 'a.ts', enc('a2'), author);

    const tree = log.materialize('main');
    // Structure resolved from metadata alone — no decryption in materialize.
    expect([...tree.keys()].sort()).toEqual(['a.ts', 'b.ts']);
    expect(tree.get('a.ts')?.op.id).toBe(a2.id); // latest write wins

    // Content comes from a separate, capability-checked store.get.
    const ref = tree.get('a.ts')!.ref!;
    expect(new TextDecoder().decode(await store.get(ref, author))).toBe('a2');
  });
});
