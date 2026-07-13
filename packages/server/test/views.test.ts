import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { beforeAll, describe, expect, test } from 'bun:test';

import { createServer } from '../src/server';
import { signRequest } from '../src/sign';
import { createRepoBody, createViewBody } from './heads';

beforeAll(async () => {
  await ready();
});

function signedPost(path: string, bodyObj: unknown, signer: Identity): Request {
  const body = new TextEncoder().encode(JSON.stringify(bodyObj));
  const h = signRequest('POST', path, body, signer, new Date().toISOString());
  return new Request(`http://t${path}`, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-thaddeus-did': h.did,
      'x-thaddeus-timestamp': h.timestamp,
      'x-thaddeus-nonce': h.nonce,
      'x-thaddeus-signature': h.signature,
    },
  });
}

describe('views (branches)', () => {
  test('list, create, and the create-only guards', async () => {
    const owner = Identity.create();
    const stranger = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(signedPost('/repos', createRepoBody('r', owner), owner));

    // A fresh repo has only `main` (seeded empty).
    const listed = await srv.fetch(new Request('http://t/repos/r/views'));
    expect(listed.status).toBe(200);
    expect(
      Object.keys(((await listed.json()) as { views: object }).views)
    ).toEqual(['main']);

    // Create a branch at main's (empty) head-set.
    const made = await srv.fetch(
      signedPost(
        '/repos/r/views',
        createViewBody('r', 'feature', [], owner),
        owner
      )
    );
    expect(made.status).toBe(201);
    const after = (await (
      await srv.fetch(new Request('http://t/repos/r/views'))
    ).json()) as { views: Record<string, string[]> };
    expect(Object.keys(after.views).sort()).toEqual(['feature', 'main']);

    // Create-only: re-pointing an existing view must go through `land`.
    const dup = await srv.fetch(
      signedPost(
        '/repos/r/views',
        createViewBody('r', 'feature', [], owner),
        owner
      )
    );
    expect(dup.status).toBe(409);

    // The internal prefix is reserved.
    const reserved = await srv.fetch(
      signedPost(
        '/repos/r/views',
        createViewBody('r', 'land/x', [], owner),
        owner
      )
    );
    expect(reserved.status).toBe(400);

    // Heads must already be ingested.
    const unknown = await srv.fetch(
      signedPost(
        '/repos/r/views',
        createViewBody('r', 'b', ['d'.repeat(64)], owner),
        owner
      )
    );
    expect(unknown.status).toBe(400);

    // Unsigned → 401; a stranger (no delegation) → 403.
    const unsigned = await srv.fetch(
      new Request('http://t/repos/r/views', {
        method: 'POST',
        body: new TextEncoder().encode(
          JSON.stringify({ view: 'z', heads: [] })
        ),
      })
    );
    expect(unsigned.status).toBe(401);
    const forbidden = await srv.fetch(
      signedPost(
        '/repos/r/views',
        createViewBody('r', 'z', [], stranger),
        stranger
      )
    );
    expect(forbidden.status).toBe(403);
  });
});
