import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  SERVER_VERSION_HEADER,
} from '../src/protocol';
import { createServer } from '../src/server';
import { signRequest } from '../src/sign';
import { createRepoBody } from './heads';

beforeAll(async () => {
  await ready();
});

const VERSION = '9.9.9-test';

function testServer() {
  return createServer({ backend: new MemoryBackend(), version: VERSION });
}

// Builds a correctly signed POST /repos request carrying extra headers.
function signedCreate(
  signer: Identity,
  extraHeaders: Record<string, string> = {},
  name = 'acme/web'
): Request {
  const path = '/repos';
  const body = new TextEncoder().encode(
    JSON.stringify(createRepoBody(name, signer))
  );
  const h = signRequest('POST', path, body, signer, new Date().toISOString());
  return new Request(`http://t${path}`, {
    method: 'POST',
    body,
    headers: {
      'x-thaddeus-did': h.did,
      'x-thaddeus-timestamp': h.timestamp,
      'x-thaddeus-nonce': h.nonce,
      'x-thaddeus-signature': h.signature,
      ...extraHeaders,
    },
  });
}

describe('wire protocol version', () => {
  test('GET /version returns the server version and protocol', async () => {
    const srv = testServer();
    const res = await srv.fetch(new Request('http://t/version'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: VERSION,
      protocol: PROTOCOL_VERSION,
    });
    await srv.close();
  });

  test('GET /version reports unknown when no version is configured', async () => {
    const srv = createServer({ backend: new MemoryBackend() });
    const res = await srv.fetch(new Request('http://t/version'));
    expect(await res.json()).toEqual({
      version: 'unknown',
      protocol: PROTOCOL_VERSION,
    });
    await srv.close();
  });

  test('every response carries the protocol and version headers', async () => {
    const srv = testServer();
    const cases = [
      new Request('http://t/repos'),
      new Request('http://t/no/such/path'),
      new Request('http://t/metrics'),
      new Request('http://t/version'),
      new Request('http://t/repos/%E0%A4%A'),
    ];
    for (const req of cases) {
      const res = await srv.fetch(req);
      expect(res.headers.get(PROTOCOL_HEADER)).toBe('1');
      expect(res.headers.get(SERVER_VERSION_HEADER)).toBe(VERSION);
    }
    expect((await srv.fetch(new Request('http://t/no/such/path'))).status).toBe(
      404
    );
    await srv.close();
  });

  test('request without the header succeeds', async () => {
    // Pre-protocol clients and lazythad send no header at all.
    const srv = testServer();
    const res = await srv.fetch(new Request('http://t/repos'));
    expect(res.status).toBe(200);
    await srv.close();
  });

  test('a matching header succeeds', async () => {
    const srv = testServer();
    const a = Identity.create();
    const res = await srv.fetch(
      signedCreate(a, { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) })
    );
    expect(res.status).toBe(201);
    await srv.close();
  });

  test('mismatched header returns 426 before authentication', async () => {
    const srv = testServer();
    const a = Identity.create();

    const signedRes = await srv.fetch(
      signedCreate(a, { [PROTOCOL_HEADER]: '2' })
    );
    expect(signedRes.status).toBe(426);
    expect(signedRes.headers.get(PROTOCOL_HEADER)).toBe('1');
    expect(signedRes.headers.get(SERVER_VERSION_HEADER)).toBe(VERSION);
    const signedBody = (await signedRes.json()) as {
      error: string;
      serverProtocol: number;
      clientProtocol: string;
    };
    expect(signedBody).toMatchObject({
      serverProtocol: 1,
      clientProtocol: '2',
    });
    expect(signedBody.error).toBe(
      `protocol mismatch: this server speaks protocol 1 (thaddeus ${VERSION}) and the client sent 2. Install a thaddeus CLI that speaks protocol 1.`
    );

    // An unsigned POST gets the same 426, not a 401.
    const unsigned = () =>
      new Request('http://t/repos', {
        method: 'POST',
        body: JSON.stringify({ name: 'x' }),
        headers: { [PROTOCOL_HEADER]: '2' },
      });
    const unsignedRes = await srv.fetch(unsigned());
    expect(unsignedRes.status).toBe(426);
    expect(await unsignedRes.json()).toEqual(signedBody);

    // Without the header the same unsigned POST is rejected by authentication.
    const plain = await srv.fetch(
      new Request('http://t/repos', {
        method: 'POST',
        body: JSON.stringify({ name: 'x' }),
      })
    );
    expect(plain.status).toBe(401);

    // The rejected create never ran.
    const list = (await (
      await srv.fetch(new Request('http://t/repos'))
    ).json()) as { repos: unknown[] };
    expect(list.repos).toEqual([]);
    await srv.close();
  });

  test('a mismatch cancels the request body without reading it', async () => {
    const srv = testServer();
    let pulls = 0;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulls += 1;
        throw new Error('the body must not be pulled');
      },
      cancel() {
        cancellations += 1;
      },
    });
    const res = await srv.fetch(
      new Request('http://t/repos', {
        method: 'POST',
        headers: { [PROTOCOL_HEADER]: '2' },
        body,
      })
    );
    expect(res.status).toBe(426);
    expect(pulls).toBe(0);
    expect(cancellations).toBe(1);
    await srv.close();
  });

  test('any value other than the exact protocol number is a mismatch', async () => {
    const srv = testServer();
    for (const value of ['', '0', '01', '1.0', '1, 1', 'one', '2']) {
      const res = await srv.fetch(
        new Request('http://t/version', {
          headers: { [PROTOCOL_HEADER]: value },
        })
      );
      expect(res.status).toBe(426);
      const body = (await res.json()) as { clientProtocol: string };
      expect(body.clientProtocol).toBe(value);
    }
    await srv.close();
  });

  test('a quota rejection still carries the headers', async () => {
    const srv = createServer({
      backend: new MemoryBackend(),
      version: VERSION,
      quotas: { maxRepositories: 1 },
    });
    const a = Identity.create();
    expect((await srv.fetch(signedCreate(a))).status).toBe(201);
    const res = await srv.fetch(signedCreate(a, {}, 'acme/other'));
    expect(res.status).toBe(403);
    expect(res.headers.get(PROTOCOL_HEADER)).toBe('1');
    expect(res.headers.get(SERVER_VERSION_HEADER)).toBe(VERSION);
    await srv.close();
  });
});
