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
});
