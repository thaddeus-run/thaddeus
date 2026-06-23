import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { verifyOp } from '../src/op';
import { OpLog } from '../src/oplog';
import type { Conflict } from '../src/oplog';

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

describe('OpLog append (convergence)', () => {
  const store = new MemoryStore();

  test('order-independent: same ops in any ingest order → identical projection', async () => {
    const author = Identity.create();

    // Author three ops in one log over the global frontier.
    const src = new OpLog(store);
    await src.write('main', 'a.ts', enc('a1'), author);
    await src.write('main', 'b.ts', enc('b1'), author);
    await src.write('main', 'a.ts', enc('a2'), author);
    const all = src.ops();

    const project = (log: OpLog): string[] =>
      [...log.materialize().entries()]
        .map(([path, { op }]) => `${path}=${op.id}`)
        .sort();

    // Ingest forwards and reversed into two fresh logs; projections must match.
    const fwd = new OpLog(store);
    for (const op of all) fwd.append(op);
    const rev = new OpLog(store);
    for (const op of [...all].reverse()) rev.append(op);

    expect(project(fwd)).toEqual(project(rev));
    expect(project(fwd)).toEqual(project(src));
  });

  test('append rejects an op whose signature does not verify', async () => {
    const log = new OpLog(store);
    const author = Identity.create();
    const op = await new OpLog(store).write('main', 'a.ts', enc('x'), author);
    expect(() => log.append({ ...op, path: 'tampered.ts' })).toThrow();
  });
});

describe('OpLog conflicts + tombstones', () => {
  test('concurrent same-path writes are surfaced; LWW picks the winner', async () => {
    const store = new MemoryStore();
    const author = Identity.create();

    // Two independent logs author concurrent ops on the same path (both root,
    // no shared parent), then we converge them.
    const l1 = new OpLog(store);
    const x = await l1.write('main', 'a.ts', enc('x'), author);
    const l2 = new OpLog(store);
    const y = await l2.write('main', 'a.ts', enc('y'), author);

    const log = new OpLog(store);
    log.append(x);
    log.append(y);

    const c: readonly Conflict[] = log.conflicts();
    expect(c).toHaveLength(1);
    const conflict = c[0];
    expect(conflict.path).toBe('a.ts');
    expect([...conflict.ops].sort()).toEqual([x.id, y.id].sort());
    // Deterministic winner = higher (lamport, id); both lamport 0 so max id.
    const expectedWinner = x.id > y.id ? x.id : y.id;
    expect(conflict.winner).toBe(expectedWinner);
    expect(log.materialize().get('a.ts')?.op.id).toBe(expectedWinner);
  });

  test('remove writes a tombstone that drops the path', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    await log.write('main', 'a.ts', enc('a1'), author);
    await log.remove('main', 'a.ts', author);
    expect(log.materialize('main').has('a.ts')).toBe(false);
  });
});

describe('OpLog named views (branches dissolve)', () => {
  test('fork is zero-copy; views diverge; an op is shared across views', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();

    const base = await log.write('main', 'a.ts', enc('a1'), author);
    log.fork('feature', 'main'); // copies only the head-set
    expect(log.heads('feature')).toEqual([base.id]);

    // Advancing feature does not touch main.
    await log.write('feature', 'a.ts', enc('a2'), author);
    expect(log.heads('main')).toEqual([base.id]);

    // The base op is shared: both views materialize it at the same path,
    // and there is no `view` field on the op influencing the projection.
    expect('view' in base).toBe(false);
    expect(log.materialize('main').get('a.ts')?.op.id).toBe(base.id);
    expect(log.materialize('feature').get('a.ts')?.op.id).not.toBe(base.id);
  });
});
