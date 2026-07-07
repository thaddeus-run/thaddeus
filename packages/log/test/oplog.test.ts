import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryStore, publicIdentity } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { verifyOp } from '../src/op';
import { OpLog } from '../src/oplog';
import type { Conflict, PublicOp } from '../src/oplog';

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

  test('write/remove stamp a wall-clock `at`; default is a valid ISO instant', async () => {
    const log = new OpLog(new MemoryStore());
    const author = Identity.create();

    const w = await log.write('main', 'a.ts', enc('x'), author);
    expect(Number.isNaN(Date.parse(w.at))).toBe(false); // a real ISO timestamp
    expect(verifyOp(w)).toBe(true);

    // A pinned `at` is honored (and signed) for both write and remove.
    const pinned = '2026-07-07T12:00:00.000Z';
    const w2 = await log.write('main', 'b.ts', enc('y'), author, {
      at: pinned,
    });
    expect(w2.at).toBe(pinned);
    const r = await log.remove('main', 'b.ts', author, { at: pinned });
    expect(r.at).toBe(pinned);
    expect(verifyOp(w2) && verifyOp(r)).toBe(true);
  });

  test('`at` is descriptive only — ordering stays lamport-based under skew', async () => {
    const log = new OpLog(new MemoryStore());
    const author = Identity.create();
    // The lamport-0 root carries a LATER wall-clock than its lamport-1 child
    // (clock skew). ops() must still order by lamport, ignoring `at`.
    const a = await log.write('main', 'a.ts', enc('a'), author, {
      at: '2026-07-07T23:59:59.000Z',
    });
    const b = await log.write('main', 'a.ts', enc('b'), author, {
      at: '2026-07-07T00:00:00.000Z',
    });
    expect(a.lamport).toBe(0);
    expect(b.lamport).toBe(1);
    expect(log.ops().map((o) => o.id)).toEqual([a.id, b.id]);
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

  test('a linear chain on one path is NOT a conflict', async () => {
    const log = new OpLog(new MemoryStore());
    const author = Identity.create();
    await log.write('main', 'a.ts', enc('v1'), author);
    await log.write('main', 'a.ts', enc('v2'), author);
    await log.write('main', 'a.ts', enc('v3'), author);
    // Sequential edits are ancestors of one another — not concurrent.
    expect(log.conflicts('main')).toHaveLength(0);
  });

  test('the conflict set excludes an ancestor superseded by a concurrent descendant', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    // Chain a1→a2 on one path; a concurrent op d on the same path; converge.
    const l1 = new OpLog(store);
    const a1 = await l1.write('main', 'p.ts', enc('a1'), author);
    const a2 = await l1.write('main', 'p.ts', enc('a2'), author);
    const l2 = new OpLog(store);
    const d = await l2.write('main', 'p.ts', enc('d'), author);

    const log = new OpLog(store);
    for (const op of [a1, a2, d]) {
      log.append(op);
    }
    const c = log.conflicts();
    expect(c).toHaveLength(1);
    // a1 (ancestor of a2) must NOT appear — only the frontier {a2, d}.
    expect([...c[0].ops].sort()).toEqual([a2.id, d.id].sort());
    expect(log.materialize().get('p.ts')?.op.id).toBe(c[0].winner);
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

  test('a merge op (parents = both view heads) converges divergent views', async () => {
    const log = new OpLog(new MemoryStore());
    const author = Identity.create();
    await log.write('main', 'a.ts', enc('a1'), author);
    log.fork('feature', 'main');
    const m = await log.write('main', 'm.ts', enc('m'), author);
    const f = await log.write('feature', 'f.ts', enc('f'), author);

    // "Merging" is just an op whose parents union both views' heads.
    log.view('merged', [...log.heads('main'), ...log.heads('feature')]);
    const merge = await log.write('merged', 'merged.ts', enc('z'), author);
    expect([...merge.parents].sort()).toEqual([m.id, f.id].sort());
    expect([...log.materialize('merged').keys()].sort()).toEqual([
      'a.ts',
      'f.ts',
      'm.ts',
      'merged.ts',
    ]);
  });
});

describe('OpLog.verify', () => {
  test('verifies a stored op; false for an unknown id', async () => {
    const log = new OpLog(new MemoryStore());
    const author = Identity.create();
    const op = await log.write('main', 'a.ts', enc('x'), author);
    expect(log.verify(op.id)).toBe(true);
    expect(log.verify('deadbeef')).toBe(false);
  });
});

describe('OpLog embargo seam (P02 metadata-gating)', () => {
  const T = '2030-01-01T00:00:00.000Z';
  const beforeT = '2026-06-23T00:00:00.000Z';

  test('public sees only an opaque token; reveal at T places the op', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const maintainer = Identity.create();

    const op = await log.write('main', 'src/auth.ts', enc('fix'), maintainer, {
      embargoUntil: T,
    });

    // Public mirror view: opaque token only — no path/author/timing.
    const pv: PublicOp = log.publicView(op.id);
    expect(pv.kind).toBe('embargoed');
    const sealed = pv.kind === 'embargoed' ? pv.sealed_meta : undefined;
    if (pv.kind === 'embargoed') {
      expect(pv.ordering_token.length).toBeGreaterThan(0);
      expect(JSON.stringify(pv)).not.toContain('src/auth.ts');
    }
    expect(sealed).toBeDefined();

    // Public materialize (no reader) does NOT place the embargoed op...
    expect(log.materialize('main').has('src/auth.ts')).toBe(false);
    // ...but the maintainer, who holds the metadata cap, does see it placed.
    expect(log.materialize('main', maintainer).has('src/auth.ts')).toBe(true);

    // Before T the sealed metadata is unreadable by the public reveal trigger.
    expect(await log.reveal(op.id, beforeT)).toBe(false);
    expect(log.materialize('main').has('src/auth.ts')).toBe(false);

    // At T the key-release fires; the op lands publicly.
    expect(await log.reveal(op.id, T)).toBe(true);
    expect(log.publicView(op.id).kind).toBe('open');
    expect(log.materialize('main').get('src/auth.ts')?.op.id).toBe(op.id);

    // And the sealed metadata is now world-readable via the membrane.
    if (sealed !== undefined) {
      const meta = await store.get(sealed, publicIdentity(), T);
      expect(new TextDecoder().decode(meta).length).toBeGreaterThan(0);
    }
  });

  test('an embargoed write with an invalid timestamp is rejected and places nothing', async () => {
    const log = new OpLog(new MemoryStore());
    const author = Identity.create();
    let threw = false;
    try {
      await log.write('main', 'x.ts', enc('y'), author, {
        embargoUntil: 'not-a-date',
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Fail-closed by construction: the op was never committed, so it is not in
    // the log, the view was never advanced, and nothing is publicly placeable.
    expect(log.ops()).toHaveLength(0);
    expect(log.heads('main')).toHaveLength(0);
    expect(log.materialize('main').size).toBe(0);
  });
});
