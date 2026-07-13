import { Identity, ready } from '@thaddeus.run/identity';
import {
  decodeHeadRecord,
  encodeHeadRecord,
  type HeadRecordWire,
  signHead,
} from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import { encodeRecord } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { createServer } from '../src/server';
import { signRequest } from '../src/sign';
import { createRepoBody } from './heads';

beforeAll(async () => {
  await ready();
});

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
      '/repos/legacy/views',
      '/repos/legacy/pull?view=main',
    ]) {
      expect((await first.fetch(new Request(`http://t${path}`))).status).toBe(
        428
      );
    }

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
});
