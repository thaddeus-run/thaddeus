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
