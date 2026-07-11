import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { beforeAll, describe, expect, test } from 'bun:test';

import { createServer } from '../src/server';
import { signRequest } from '../src/sign';

beforeAll(async () => {
  await ready();
});

// Helper: a signed POST Request the server can consume.
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

// Helper: a signed DELETE Request (no body) the server can consume.
function signedDelete(path: string, signer: Identity): Request {
  const h = signRequest(
    'DELETE',
    path,
    new Uint8Array(),
    signer,
    new Date().toISOString()
  );
  return new Request(`http://t${path}`, {
    method: 'DELETE',
    headers: {
      'x-thaddeus-did': h.did,
      'x-thaddeus-timestamp': h.timestamp,
      'x-thaddeus-nonce': h.nonce,
      'x-thaddeus-signature': h.signature,
    },
  });
}

describe('repos', () => {
  test('signed create sets the owner; list shows it', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });

    const created = await srv.fetch(
      signedPost('/repos', { name: 'acme/web' }, a)
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ name: 'acme/web', owner: a.did });

    const list = await srv.fetch(new Request('http://t/repos'));
    expect(await list.json()).toEqual({
      repos: ['acme/web'],
      owners: { 'acme/web': a.did },
    });
  });

  test('delete: owner-only, then gone from the list', async () => {
    const owner = Identity.create();
    const other = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(signedPost('/repos', { name: 'del/me' }, owner));

    // Unsigned → 401.
    const unsigned = await srv.fetch(
      new Request('http://t/repos/del%2Fme', { method: 'DELETE' })
    );
    expect(unsigned.status).toBe(401);

    // Signed by a non-owner → 403.
    expect(
      (await srv.fetch(signedDelete('/repos/del%2Fme', other))).status
    ).toBe(403);

    // Owner → 200, and the repo is gone from the listing.
    expect(
      (await srv.fetch(signedDelete('/repos/del%2Fme', owner))).status
    ).toBe(200);
    const list = await srv.fetch(new Request('http://t/repos'));
    expect(await list.json()).toEqual({ repos: [], owners: {} });

    // Deleting a now-missing repo → 404.
    expect(
      (await srv.fetch(signedDelete('/repos/del%2Fme', owner))).status
    ).toBe(404);
  });

  test('create without a signature is 401', async () => {
    const srv = createServer({ backend: new MemoryBackend() });
    const body = new TextEncoder().encode(JSON.stringify({ name: 'x' }));
    const res = await srv.fetch(
      new Request('http://t/repos', { method: 'POST', body })
    );
    expect(res.status).toBe(401);
  });

  test('creating an existing repo is 409', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(signedPost('/repos', { name: 'dup' }, a));
    const again = await srv.fetch(signedPost('/repos', { name: 'dup' }, a));
    expect(again.status).toBe(409);
  });

  test('a signed but non-JSON body is 400', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const raw = new TextEncoder().encode('this is not json');
    const h = signRequest('POST', '/repos', raw, a, new Date().toISOString());
    const res = await srv.fetch(
      new Request('http://t/repos', {
        method: 'POST',
        body: raw,
        headers: {
          'x-thaddeus-did': h.did,
          'x-thaddeus-timestamp': h.timestamp,
          'x-thaddeus-nonce': h.nonce,
          'x-thaddeus-signature': h.signature,
        },
      })
    );
    expect(res.status).toBe(400);
  });

  test('a null JSON body to POST /repos is 400 not 500', async () => {
    // typeof null === 'object', so a guard of `typeof parsed !== 'object'`
    // alone would pass null through and throw at destructuring → 500.
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const raw = new TextEncoder().encode('null');
    const h = signRequest('POST', '/repos', raw, a, new Date().toISOString());
    const res = await srv.fetch(
      new Request('http://t/repos', {
        method: 'POST',
        body: raw,
        headers: {
          'x-thaddeus-did': h.did,
          'x-thaddeus-timestamp': h.timestamp,
          'x-thaddeus-nonce': h.nonce,
          'x-thaddeus-signature': h.signature,
        },
      })
    );
    expect(res.status).toBe(400);
  });

  test('a malformed percent-escape path to GET /repos/.../pull is 400 not 500', async () => {
    // decodeURIComponent('%E0%A4%A') throws — must be caught and returned as 400.
    const srv = createServer({ backend: new MemoryBackend() });
    const res = await srv.fetch(
      new Request('http://t/repos/%E0%A4%A/pull', { method: 'GET' })
    );
    expect(res.status).toBe(400);
  });
});
