import { Identity, ready } from '@thaddeus.run/identity';
import {
  encodeHeadRecord,
  type HeadRecord,
  signHead,
  signOp,
} from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import { Platform } from '@thaddeus.run/platform';
import { encodeBundle } from '@thaddeus.run/server';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '../src/client';

beforeAll(async () => {
  await ready();
});

function pullBody(
  repo: string,
  view: string,
  chain: readonly HeadRecord[],
  ops: Parameters<typeof encodeBundle>[0]
): Record<string, unknown> {
  const head = chain.at(-1);
  if (head === undefined) throw new Error('test head chain must not be empty');
  return {
    view,
    head: encodeHeadRecord(head),
    chain: chain.map(encodeHeadRecord),
    ...encodeBundle(ops, [], []),
  };
}

function responseFetch(
  body: () => unknown
): (request: Request) => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
}

// Awaits the real promise so rejection assertions remain lint-clean with Bun.
async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected promise to reject, but it resolved');
}

describe('Client signed-head verification', () => {
  test('listViewsPage rejects malformed head entries', async () => {
    const client = new Client(
      'http://t',
      Identity.create(),
      responseFetch(() => ({ views: { main: {} }, nextCursor: null }))
    );
    expect((await failureOf(client.listViewsPage('r'))).message).toContain(
      'malformed_record'
    );
  });

  test('expected owner accepts the match and rejects owner, scope, and record substitution', async () => {
    const owner = Identity.create();
    const stranger = Identity.create();
    const ownerGenesis = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 0,
        previous: null,
        heads: [],
      },
      owner
    );
    const strangerGenesis = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 0,
        previous: null,
        heads: [],
      },
      stranger
    );
    let body = pullBody('r', 'main', [ownerGenesis], []);
    const client = new Client(
      'http://t',
      owner,
      responseFetch(() => body)
    );
    expect(
      await client.clone('r', new MemoryBackend(), 'main', {
        expectedOwner: owner.did,
      })
    ).toMatchObject({ head: { id: ownerGenesis.id } });

    body = pullBody('r', 'main', [strangerGenesis], []);
    expect(
      (
        await failureOf(
          client.clone('r', new MemoryBackend(), 'main', {
            expectedOwner: owner.did,
          })
        )
      ).message
    ).toContain('wrong_owner');

    const wrongRepo = signHead(
      {
        repo: 'other',
        view: 'main',
        version: 0,
        previous: null,
        heads: [],
      },
      owner
    );
    body = pullBody('r', 'main', [wrongRepo], []);
    expect(
      (
        await failureOf(
          client.clone('r', new MemoryBackend(), 'main', {
            expectedOwner: owner.did,
          })
        )
      ).message
    ).toContain('wrong_repo');

    const forged = pullBody('r', 'main', [ownerGenesis], []);
    forged.head = {
      ...(forged.head as object),
      id: '0'.repeat(64),
    };
    body = forged;
    expect(
      (await failureOf(client.clone('r', new MemoryBackend(), 'main'))).message
    ).toContain('malformed_record');
  });

  test('trust on first use pins the owner durably and rejects a later change', async () => {
    const firstOwner = Identity.create();
    const substitute = Identity.create();
    const reader = Identity.create();
    const genesis = (owner: Identity) =>
      signHead(
        {
          repo: 'r',
          view: 'main',
          version: 0,
          previous: null,
          heads: [],
        },
        owner
      );
    const first = genesis(firstOwner);
    let body = pullBody('r', 'main', [first], []);
    const backend = new MemoryBackend();
    const client = new Client(
      'http://t',
      reader,
      responseFetch(() => body)
    );
    await client.clone('r', backend);

    body = pullBody('r', 'main', [genesis(substitute)], []);
    expect((await failureOf(client.clone('r', backend))).message).toContain(
      'wrong_owner'
    );
    const reopened = await new Platform().openDurable('r', backend);
    expect(reopened.headRecords.owner).toBe(firstOwner.did);
    expect(reopened.headRecords.current('main')?.id).toBe(first.id);
  });

  test('view listing rejects pinned rollback and forks and verifies newer chains', async () => {
    const owner = Identity.create();
    const genesis = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 0,
        previous: null,
        heads: [],
      },
      owner
    );
    const next = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 1,
        previous: genesis.id,
        heads: [],
      },
      owner
    );
    const fork = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 1,
        previous: genesis.id,
        heads: ['f'.repeat(64)],
      },
      owner
    );
    const backend = new MemoryBackend();
    const repo = await new Platform().openDurable('r', backend);
    await repo.headRecords.import([genesis, next], owner.did);
    let listed = next;
    let chain: readonly HeadRecord[] = [genesis, next];
    const client = new Client('http://t', Identity.create(), (request) => {
      const path = new URL(request.url).pathname;
      const response = path.endsWith('/views')
        ? { views: { main: encodeHeadRecord(listed) } }
        : {
            view: 'main',
            head: encodeHeadRecord(chain.at(-1) as HeadRecord),
            chain: chain.map(encodeHeadRecord),
          };
      return Promise.resolve(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    });

    listed = genesis;
    expect((await failureOf(client.listViews('r', repo))).message).toContain(
      'rollback'
    );
    listed = fork;
    expect((await failureOf(client.listViews('r', repo))).message).toContain(
      'fork'
    );

    const higher = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 2,
        previous: next.id,
        heads: [],
      },
      owner
    );
    listed = higher;
    chain = [genesis, next];
    expect((await failureOf(client.listViews('r', repo))).message).toContain(
      'pagination_snapshot_changed'
    );
    chain = [genesis, next, higher];
    expect(await client.listViews('r', repo)).toEqual({ main: [] });
    expect(repo.headRecords.current('main')?.id).toBe(next.id);
  });

  test('restarts the complete view read when list and detail cross snapshots', async () => {
    const owner = Identity.create();
    const genesis = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 0,
        previous: null,
        heads: [],
      },
      owner
    );
    const next = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 1,
        previous: genesis.id,
        heads: [],
      },
      owner
    );
    const higher = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 2,
        previous: next.id,
        heads: [],
      },
      owner
    );
    const repo = await new Platform().openDurable('r', new MemoryBackend());
    await repo.headRecords.bootstrap(genesis);
    let listCalls = 0;
    const client = new Client('http://t', Identity.create(), (request) => {
      const list = new URL(request.url).pathname.endsWith('/views');
      if (list) listCalls += 1;
      const response = list
        ? {
            views: {
              main: encodeHeadRecord(listCalls === 1 ? next : higher),
            },
            nextCursor: null,
          }
        : {
            view: 'main',
            head: encodeHeadRecord(higher),
            chain: [genesis, next, higher].map(encodeHeadRecord),
            nextCursor: null,
          };
      return Promise.resolve(Response.json(response));
    });

    expect(await client.listViews('r', repo)).toEqual({ main: [] });
    expect(listCalls).toBe(2);
  });

  test('rejects rollback, a pinned-version fork, and broken or gapped chains', async () => {
    const owner = Identity.create();
    const author = Identity.create();
    const root = signOp(
      {
        path: 'root',
        parents: [],
        lamport: 0,
        at: '2026-07-13T00:00:00.000Z',
        payload: null,
      },
      author
    );
    const genesis = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 0,
        previous: null,
        heads: [],
      },
      owner
    );
    const next = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 1,
        previous: genesis.id,
        heads: [root.id],
      },
      owner
    );
    let body = pullBody('r', 'main', [genesis, next], [root]);
    const backend = new MemoryBackend();
    const client = new Client(
      'http://t',
      owner,
      responseFetch(() => body)
    );
    const { repo } = await client.clone('r', backend);

    const fork = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 1,
        previous: genesis.id,
        heads: [],
      },
      owner
    );
    const gap = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 2,
        previous: next.id,
        heads: [root.id],
      },
      owner
    );
    const broken = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 1,
        previous: 'f'.repeat(64),
        heads: [root.id],
      },
      owner
    );
    const attacks = [
      { chain: [genesis], ops: [], code: 'rollback' },
      { chain: [genesis, fork], ops: [], code: 'fork' },
      { chain: [genesis, gap], ops: [root], code: 'gap' },
      {
        chain: [genesis, broken],
        ops: [root],
        code: 'broken_previous',
      },
    ] as const;
    for (const attack of attacks) {
      body = pullBody('r', 'main', attack.chain, attack.ops);
      expect(
        (await failureOf(client.pull('r', repo, backend))).message
      ).toContain(attack.code);
      expect(repo.headRecords.current('main')?.id).toBe(next.id);
      expect(repo.log.heads('main')).toEqual([root.id]);
    }
  });

  test('withheld, forged, duplicate, and injected operations cannot move a local view', async () => {
    const owner = Identity.create();
    const author = Identity.create();
    const root = signOp(
      {
        path: 'root',
        parents: [],
        lamport: 0,
        at: '2026-07-13T00:00:00.000Z',
        payload: null,
      },
      author
    );
    const child = signOp(
      {
        path: 'child',
        parents: [root.id],
        lamport: 1,
        at: '2026-07-13T00:00:01.000Z',
        payload: null,
      },
      author
    );
    const extra = signOp(
      {
        path: 'extra',
        parents: [],
        lamport: 0,
        at: '2026-07-13T00:00:02.000Z',
        payload: null,
      },
      author
    );
    const genesis = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 0,
        previous: null,
        heads: [],
      },
      owner
    );
    const next = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 1,
        previous: genesis.id,
        heads: [child.id],
      },
      owner
    );
    let body = pullBody('r', 'main', [genesis], []);
    const backend = new MemoryBackend();
    const client = new Client(
      'http://t',
      owner,
      responseFetch(() => body)
    );
    const { repo } = await client.clone('r', backend);
    const forged = { ...child, path: 'forged' };
    const attacks = [
      { ops: [], code: 'missing_operation' },
      { ops: [child], code: 'missing_operation' },
      { ops: [root, child, extra], code: 'extra_operation' },
      { ops: [root, forged], code: 'invalid_operation' },
    ];
    for (const attack of attacks) {
      body = pullBody('r', 'main', [genesis, next], attack.ops);
      expect(
        (await failureOf(client.pull('r', repo, backend))).message
      ).toContain(attack.code);
      expect(repo.headRecords.current('main')?.id).toBe(genesis.id);
      expect(repo.log.heads('main')).toEqual([]);
    }

    // Page reassembly deliberately deduplicates identical wire records before
    // final completeness verification.
    body = pullBody('r', 'main', [genesis, next], [root, child, child]);
    const pulled = await client.pull('r', repo, backend);
    expect(pulled.head.id).toBe(next.id);
    expect(repo.log.heads('main')).toEqual([child.id]);
    const reopened = await new Platform().openDurable('r', backend);
    expect(reopened.headRecords.current('main')?.id).toBe(next.id);
  });
});
