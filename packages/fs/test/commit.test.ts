import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Workspace } from '../src/workspace';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// A fault injector for commit()'s partial-failure path: delegates to a real
// OpLog but throws on the Nth write. The in-memory MemoryStore never fails, so a
// fault injector is the only way to exercise a mid-batch commit failure.
class FlakyLog {
  readonly #real: OpLog;
  readonly #failOn: number;
  #writes = 0;
  constructor(real: OpLog, failOn: number) {
    this.#real = real;
    this.#failOn = failOn;
  }
  fork(name: string, from: string): void {
    this.#real.fork(name, from);
  }
  async write(view: string, path: string, bytes: Uint8Array, author: Identity) {
    this.#writes += 1;
    if (this.#writes === this.#failOn) {
      throw new Error('store down');
    }
    return this.#real.write(view, path, bytes, author);
  }
}

describe('Workspace — commit', () => {
  test('commit folds the overlay into ops, clears it, and the edits read back', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });

    ws.write('src/a.rs', enc('fn a() {}'));
    ws.write('src/b.rs', enc('fn b() {}'));
    const ops = await ws.commit(author);

    expect(ops).toHaveLength(2);
    expect(ws.status()).toEqual([]); // overlay cleared
    expect(dec((await ws.read('src/a.rs'))!)).toBe('fn a() {}');
    expect(dec((await ws.read('src/b.rs'))!)).toBe('fn b() {}');
  });

  test('an empty overlay commits to nothing', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    expect(await ws.commit(author)).toEqual([]);
  });

  test('commit ops parent at the pinned base, not on concurrent peer ops', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const peer = Identity.create();
    const base = await log.write('main', 'src/a.rs', enc('a0'), author);

    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    // A peer advances `main` AFTER the workspace opened.
    await log.write('main', 'src/a.rs', enc('a-peer'), peer);

    ws.write('src/a.rs', enc('a-mine'));
    const [op] = await ws.commit(author);
    expect(op?.parents).toEqual([base.id]);
  });

  test('pinned base: a peer write to the source after open does not change reads', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const peer = Identity.create();
    await log.write('main', 'src/a.rs', enc('a0'), author);

    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    await log.write('main', 'src/a.rs', enc('a-peer'), peer);

    expect(dec((await ws.read('src/a.rs'))!)).toBe('a0');
  });

  test('rm commits a tombstone op; the path is gone from the committed view', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    ws.write('src/a.rs', enc('a'));
    await ws.commit(author);

    ws.rm('src/a.rs');
    const [tomb] = await ws.commit(author);
    expect(tomb?.payload).toBeNull(); // payload:null tombstone
    expect(await ws.read('src/a.rs')).toBeNull();
  });

  test('commit clears each path as it succeeds: a mid-batch failure leaves only the uncommitted paths staged', async () => {
    const store = new MemoryStore();
    // The 2nd write throws; with sorted paths a,b,c that is b.rs.
    const log = new FlakyLog(new OpLog(store), 2) as unknown as OpLog;
    const author = Identity.create();
    const ws = Workspace.open(log, store, { source: 'main', reader: author });

    ws.write('a.rs', enc('a'));
    ws.write('b.rs', enc('b'));
    ws.write('c.rs', enc('c'));

    let threw = false;
    try {
      await ws.commit(author);
    } catch (e) {
      threw = e instanceof Error && e.message === 'store down';
    }
    expect(threw).toBe(true);
    // a.rs landed and was cleared; b.rs (failed) and c.rs (unattempted) remain —
    // a retry would NOT re-commit a.rs (no duplicate op).
    expect(ws.status().map((s) => s.path)).toEqual(['b.rs', 'c.rs']);
  });
});
