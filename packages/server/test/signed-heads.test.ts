import { signDelegation } from '@thaddeus.run/agent';
import { Identity, ready } from '@thaddeus.run/identity';
import {
  decodeHeadRecord,
  encodeHeadRecord,
  type HeadRecordWire,
  signHead,
  signOp,
} from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import { signClaim } from '@thaddeus.run/reputation';
import {
  type Backend,
  type ConsumeNonceInput,
  type ConsumeNonceResult,
  encodeRecord,
  type ReplayNonceBackend,
} from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { encodeBundle, encodeClaim, encodeDelegation } from '../src/dto';
import { createServer } from '../src/server';
import { signRequest } from '../src/sign';
import { createRepoBody, landBody } from './heads';

beforeAll(async () => {
  await ready();
});

class FailFirstReputationWrite implements Backend, ReplayNonceBackend {
  readonly inner = new MemoryBackend();
  #failed = false;

  put(key: string, bytes: Uint8Array): Promise<void> {
    if (!this.#failed && key.startsWith('rep/')) {
      this.#failed = true;
      return Promise.reject(new Error('simulated reputation write failure'));
    }
    return this.inner.put(key, bytes);
  }

  putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    return this.inner.putIfAbsent(key, bytes);
  }

  get(key: string): Promise<Uint8Array | undefined> {
    return this.inner.get(key);
  }

  list(prefix: string): Promise<readonly string[]> {
    return this.inner.list(prefix);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  consumeNonce(input: ConsumeNonceInput): Promise<ConsumeNonceResult> {
    return this.inner.consumeNonce(input);
  }
}

function signedPost(path: string, value: unknown, signer: Identity): Request {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const signed = signRequest(
    'POST',
    path,
    body,
    signer,
    new Date().toISOString()
  );
  return new Request(`http://t${path}`, {
    method: 'POST',
    body,
    headers: {
      'x-thaddeus-did': signed.did,
      'x-thaddeus-timestamp': signed.timestamp,
      'x-thaddeus-nonce': signed.nonce,
      'x-thaddeus-signature': signed.signature,
    },
  });
}

describe('server signed shared heads', () => {
  test('repository creation requires the owner-signed empty main genesis', async () => {
    const owner = Identity.create();
    const stranger = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });

    expect(
      (await srv.fetch(signedPost('/repos', { name: 'missing' }, owner))).status
    ).toBe(400);

    const tampered = createRepoBody('tampered', owner);
    tampered.head = { ...tampered.head, repo: 'elsewhere' };
    expect(
      (await srv.fetch(signedPost('/repos', tampered, owner))).status
    ).toBe(400);

    expect(
      (
        await srv.fetch(
          signedPost('/repos', createRepoBody('wrong-owner', owner), stranger)
        )
      ).status
    ).toBe(403);

    const created = await srv.fetch(
      signedPost('/repos', createRepoBody('valid', owner), owner)
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { head: HeadRecordWire };
    expect(decodeHeadRecord(body.head)).toMatchObject({
      repo: 'valid',
      view: 'main',
      version: 0,
      owner: owner.did,
      heads: [],
    });
  });

  test('legacy raw views fail closed, bootstrap owner-selected heads, and survive restart', async () => {
    const owner = Identity.create();
    const stranger = Identity.create();
    const backend = new MemoryBackend();
    await backend.put(
      'repo/legacy/meta/repo',
      encodeRecord({ owner: owner.did })
    );
    await backend.put('repo/legacy/view/main', encodeRecord([]));

    const first = createServer({ backend });
    for (const path of [
      '/repos/legacy/views/main',
      '/repos/legacy/pull?view=main',
    ]) {
      expect((await first.fetch(new Request(`http://t${path}`))).status).toBe(
        428
      );
    }
    const unsignedList = await first.fetch(
      new Request('http://t/repos/legacy/views')
    );
    expect(unsignedList.status).toBe(200);
    expect(await unsignedList.json()).toEqual({ views: {} });

    const strangerHead = signHead(
      {
        repo: 'legacy',
        view: 'main',
        version: 0,
        previous: null,
        heads: [],
      },
      stranger
    );
    expect(
      (
        await first.fetch(
          signedPost(
            '/repos/legacy/heads/bootstrap',
            { head: encodeHeadRecord(strangerHead) },
            stranger
          )
        )
      ).status
    ).toBe(403);

    const incomplete = signHead(
      {
        repo: 'legacy',
        view: 'main',
        version: 0,
        previous: null,
        heads: ['a'.repeat(64)],
      },
      owner
    );
    expect(
      (
        await first.fetch(
          signedPost(
            '/repos/legacy/heads/bootstrap',
            { head: encodeHeadRecord(incomplete) },
            owner
          )
        )
      ).status
    ).toBe(400);

    const genesis = signHead(
      {
        repo: 'legacy',
        view: 'main',
        version: 0,
        previous: null,
        heads: [],
      },
      owner
    );
    const bootstrapped = await first.fetch(
      signedPost(
        '/repos/legacy/heads/bootstrap',
        { head: encodeHeadRecord(genesis) },
        owner
      )
    );
    expect(bootstrapped.status).toBe(200);
    expect(
      (
        await first.fetch(
          signedPost(
            '/repos/legacy/heads/bootstrap',
            { head: encodeHeadRecord(genesis) },
            owner
          )
        )
      ).status
    ).toBe(409);

    const restarted = createServer({ backend });
    const pulled = await restarted.fetch(
      new Request('http://t/repos/legacy/pull?view=main')
    );
    expect(pulled.status).toBe(200);
    const pullBody = (await pulled.json()) as {
      head: HeadRecordWire;
      chain: HeadRecordWire[];
      heads?: unknown;
    };
    expect(pullBody.head.id).toBe(genesis.id);
    expect(pullBody.chain.map((record) => record.id)).toEqual([genesis.id]);
    expect(pullBody.heads).toBeUndefined();
  });

  test('an unsigned legacy view does not hide unrelated signed views', async () => {
    const owner = Identity.create();
    const backend = new MemoryBackend();
    const genesis = signHead(
      {
        repo: 'partial',
        view: 'main',
        version: 0,
        previous: null,
        heads: [],
      },
      owner
    );
    await backend.put(
      'repo/partial/meta/repo',
      encodeRecord({ owner: owner.did })
    );
    await backend.put('repo/partial/view/main', encodeRecord([]));
    await backend.put('repo/partial/view/legacy', encodeRecord([]));
    await backend.put(
      'repo/partial/head/main/0000000000000000',
      encodeRecord(genesis)
    );
    const srv = createServer({ backend });

    const listed = await srv.fetch(new Request('http://t/repos/partial/views'));
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      views: Record<string, HeadRecordWire>;
    };
    expect(Object.keys(body.views)).toEqual(['main']);
    expect(decodeHeadRecord(body.views.main)).toMatchObject({
      id: genesis.id,
      view: 'main',
    });
    expect(
      (await srv.fetch(new Request('http://t/repos/partial/views/legacy')))
        .status
    ).toBe(428);
  });

  test('committed land survives and recovers failed reputation bookkeeping', async () => {
    const owner = Identity.create();
    const author = Identity.create();
    const host = Identity.create();
    const backend = new FailFirstReputationWrite();
    const first = createServer({ backend, host });
    expect(
      (
        await first.fetch(
          signedPost('/repos', createRepoBody('effects', owner), owner)
        )
      ).status
    ).toBe(201);
    expect(
      (
        await first.fetch(
          signedPost(
            '/repos/effects/grants',
            {
              delegation: encodeDelegation(
                signDelegation(
                  {
                    agent: author.did,
                    paths: ['**'],
                    maxChanges: 100,
                    maxSpend: 100,
                  },
                  owner
                )
              ),
            },
            owner
          )
        )
      ).status
    ).toBe(200);
    const op = signOp(
      {
        path: 'README.md',
        parents: [],
        lamport: 0,
        at: '2026-07-13T00:00:00.000Z',
        payload: null,
      },
      author
    );
    expect(
      (
        await first.fetch(
          signedPost('/repos/effects/push', encodeBundle([op], [], []), author)
        )
      ).status
    ).toBe(200);
    const claim = signClaim(
      {
        repo: 'effects',
        ref: op.id,
        kind: 'merge',
        at: op.at,
      },
      author
    );
    const landed = await first.fetch(
      signedPost(
        '/repos/effects/land',
        await landBody(
          first.fetch.bind(first),
          'effects',
          [op.id],
          owner,
          'main',
          { contrib: [encodeClaim(claim)] }
        ),
        owner
      )
    );
    expect(landed.status).toBe(200);
    expect(await landed.json()).toMatchObject({ landed: true });

    const restarted = createServer({ backend, host });
    expect(
      (await restarted.fetch(new Request('http://t/repos/effects/views/main')))
        .status
    ).toBe(200);
    const profile = (await (
      await restarted.fetch(
        new Request(`http://t/reputation/${encodeURIComponent(author.did)}`)
      )
    ).json()) as { byKind: Record<string, number> };
    expect(profile.byKind.merge).toBe(1);
  });
});
