import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { beforeAll, describe, expect, test } from 'bun:test';

import { createServer } from '../src/server';
import { signRequest } from '../src/sign';

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
      'x-thaddeus-did': h.did,
      'x-thaddeus-timestamp': h.timestamp,
      'x-thaddeus-signature': h.signature,
    },
  });
}

describe('reads', () => {
  test('views of an unknown repo is 404; pull of an empty main is an empty bundle', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    expect(
      (await srv.fetch(new Request('http://t/repos/nope/views/main'))).status
    ).toBe(404);
    await srv.fetch(signedPost('/repos', { name: 'acme/web' }, a));
    const pull = await srv.fetch(
      new Request('http://t/repos/acme/web/pull?view=main')
    );
    const body = await pull.json();
    expect(body).toMatchObject({ ops: [], objects: [], caps: [] });
  });

  test('pull returns view + heads alongside the bundle', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(signedPost('/repos', { name: 'acme/web' }, a));
    const pull = await srv.fetch(
      new Request('http://t/repos/acme%2Fweb/pull?view=main')
    );
    const body = (await pull.json()) as {
      view: string;
      heads: string[];
      ops: string[];
    };
    expect(body.view).toBe('main');
    expect(body.heads).toEqual([]);
    expect(body.ops).toEqual([]);
  });
});
