import { Identity, ready } from '@thaddeus.run/identity';
import { type Backend, encodeRecord } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { signHead, verifyHead } from '../src/head';
import { HeadStore, HeadVerificationError } from '../src/headstore';
import { expectRejects } from './reject';

beforeAll(async () => {
  await ready();
});

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

class MemoryBackend implements Backend {
  readonly records = new Map<string, Uint8Array>();

  put(key: string, bytes: Uint8Array): Promise<void> {
    this.records.set(key, new Uint8Array(bytes));
    return Promise.resolve();
  }

  putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    if (this.records.has(key)) {
      return Promise.resolve(false);
    }
    this.records.set(key, new Uint8Array(bytes));
    return Promise.resolve(true);
  }

  get(key: string): Promise<Uint8Array | undefined> {
    const bytes = this.records.get(key);
    return Promise.resolve(
      bytes === undefined ? undefined : new Uint8Array(bytes)
    );
  }

  list(prefix: string): Promise<readonly string[]> {
    return Promise.resolve(
      [...this.records.keys()].filter((key) => key.startsWith(prefix))
    );
  }

  delete(key: string): Promise<void> {
    this.records.delete(key);
    return Promise.resolve();
  }
}

describe('HeadStore', () => {
  test('persists and reopens complete histories', async () => {
    const backend = new MemoryBackend();
    const owner = Identity.create();
    const store = await HeadStore.load('r', backend);
    const genesis = signHead(
      { repo: 'r', view: 'main', version: 0, previous: null, heads: [A] },
      owner
    );
    const next = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 1,
        previous: genesis.id,
        heads: [A, B],
      },
      owner
    );
    await store.bootstrap(genesis);
    await store.advance(next);

    const reopened = await HeadStore.load('r', backend);
    expect(reopened.owner).toBe(owner.did);
    expect(reopened.views()).toEqual(['main']);
    expect(reopened.history('main').map((head) => head.id)).toEqual([
      genesis.id,
      next.id,
    ]);
  });

  test('imports against a pinned prefix and re-imports idempotently', async () => {
    const owner = Identity.create();
    const genesis = signHead(
      { repo: 'r', view: 'main', version: 0, previous: null, heads: [A] },
      owner
    );
    const next = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 1,
        previous: genesis.id,
        heads: [A, B],
      },
      owner
    );
    const store = new HeadStore('r');
    await store.import([genesis, next], owner.did);
    await store.import([genesis, next], owner.did);
    await store.advance(next);
    expect(store.current('main')?.id).toBe(next.id);
    await expectRejects(store.import([genesis], owner.did));

    const forgedExact = {
      ...next,
      sig: new Uint8Array(next.sig.length),
    };
    await expectRejects(store.advance(forgedExact), HeadVerificationError);
  });

  test('does not expose mutable stored records', async () => {
    const owner = Identity.create();
    const genesis = signHead(
      { repo: 'r', view: 'main', version: 0, previous: null, heads: [A] },
      owner
    );
    const store = new HeadStore('r');
    await store.bootstrap(genesis);

    genesis.sig.fill(0);
    const exposed = store.current('main');
    expect(exposed).toBeDefined();
    exposed?.sig.fill(0);

    const retained = store.current('main');
    expect(retained).toBeDefined();
    expect(verifyHead(exposed as NonNullable<typeof exposed>)).toEqual({
      ok: true,
    });
    expect(verifyHead(retained as NonNullable<typeof retained>)).toEqual({
      ok: true,
    });
    expect(() => (exposed?.heads as string[] | undefined)?.push(B)).toThrow();
  });

  test('advance rejects rollback, same-version forks, and gaps by stable code', async () => {
    const owner = Identity.create();
    const genesis = signHead(
      { repo: 'r', view: 'main', version: 0, previous: null, heads: [A] },
      owner
    );
    const next = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 1,
        previous: genesis.id,
        heads: [A, B],
      },
      owner
    );
    const store = new HeadStore('r');
    await store.import([genesis, next]);

    const attempts = [
      [genesis, 'rollback'],
      [
        signHead(
          {
            repo: 'r',
            view: 'main',
            version: 1,
            previous: genesis.id,
            heads: [A, C],
          },
          owner
        ),
        'fork',
      ],
      [
        signHead(
          {
            repo: 'r',
            view: 'main',
            version: 3,
            previous: next.id,
            heads: [A, B],
          },
          owner
        ),
        'gap',
      ],
    ] as const;
    for (const [record, code] of attempts) {
      try {
        await store.advance(record);
        throw new Error('expected advance to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(HeadVerificationError);
        expect((error as HeadVerificationError).verification.code).toBe(code);
      }
    }
  });

  test('concurrent stores cannot publish conflicting successors', async () => {
    const backend = new MemoryBackend();
    const owner = Identity.create();
    const genesis = signHead(
      { repo: 'r', view: 'main', version: 0, previous: null, heads: [] },
      owner
    );
    const seed = await HeadStore.load('r', backend);
    await seed.bootstrap(genesis);
    const [left, right] = await Promise.all([
      HeadStore.load('r', backend),
      HeadStore.load('r', backend),
    ]);
    const leftHead = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 1,
        previous: genesis.id,
        heads: [A],
      },
      owner
    );
    const rightHead = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 1,
        previous: genesis.id,
        heads: [B],
      },
      owner
    );

    const results = await Promise.allSettled([
      left.advance(leftHead),
      right.advance(rightHead),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    expect(
      rejected?.status === 'rejected' ? rejected.reason : undefined
    ).toBeInstanceOf(HeadVerificationError);

    const reopened = await HeadStore.load('r', backend);
    expect(reopened.history('main')).toHaveLength(2);
    const reopenedCurrent = reopened.current('main');
    expect(reopenedCurrent).toBeDefined();
    if (reopenedCurrent === undefined) {
      throw new Error('expected a persisted concurrent winner');
    }
    expect([leftHead.id, rightHead.id]).toContain(reopenedCurrent.id);
    expect(
      [left.history('main').length, right.history('main').length].sort(
        (a, b) => a - b
      )
    ).toEqual([1, 2]);
  });

  test('fails closed on corrupt or incomplete persisted histories', async () => {
    const owner = Identity.create();
    const genesis = signHead(
      { repo: 'r', view: 'main', version: 0, previous: null, heads: [A] },
      owner
    );
    const backend = new MemoryBackend();
    await backend.put(
      'head/main/0000000000000001',
      encodeRecord(
        signHead(
          {
            repo: 'r',
            view: 'main',
            version: 1,
            previous: genesis.id,
            heads: [A, B],
          },
          owner
        )
      )
    );
    await expectRejects(HeadStore.load('r', backend));

    const corrupt = new MemoryBackend();
    await corrupt.put(
      'head/main/0000000000000000',
      new TextEncoder().encode('not a record')
    );
    await expectRejects(HeadStore.load('r', corrupt));

    const ownerChange = new MemoryBackend();
    await ownerChange.put('head/main/0000000000000000', encodeRecord(genesis));
    await ownerChange.put(
      'head/feature/0000000000000000',
      encodeRecord(
        signHead(
          {
            repo: 'r',
            view: 'feature',
            version: 0,
            previous: null,
            heads: [],
          },
          Identity.create()
        )
      )
    );
    await expectRejects(
      HeadStore.load('r', ownerChange),
      HeadVerificationError
    );
  });
});
