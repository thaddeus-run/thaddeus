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
    expect(await list.json()).toEqual({ repos: ['acme/web'] });
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
