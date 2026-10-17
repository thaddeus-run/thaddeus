import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
} from '@thaddeus.run/server/protocol';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Client, ClientResponseError } from '../src/client';

beforeAll(async () => {
  await ready();
});

// A 426 body shaped like the one the server sends for a protocol mismatch.
function mismatch(serverProtocol: number): Response {
  return Response.json(
    {
      error: `protocol mismatch: this server speaks protocol ${serverProtocol}`,
      serverProtocol,
      clientProtocol: String(PROTOCOL_VERSION),
    },
    { status: 426 }
  );
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('Client wire protocol', () => {
  test('sends x-thaddeus-protocol on every request', async () => {
    const srv = createServer({ backend: new MemoryBackend() });
    const seen: (string | null)[] = [];
    const client = new Client(
      'http://t',
      Identity.create(),
      async (req: Request) => {
        seen.push(req.headers.get(PROTOCOL_HEADER));
        return srv.fetch(req);
      }
    );

    // One signed write (body + signature must survive the header copy) and
    // two unsigned reads.
    await client.createRepo('acme/web');
    await client.listRepos();
    await client.getPolicy('acme/web');

    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((value) => value === String(PROTOCOL_VERSION))).toBe(
      true
    );
    await srv.close();
  });

  test('a 426 names both protocols and which side to update', async () => {
    const newer = new Client('http://t', Identity.create(), () =>
      Promise.resolve(mismatch(PROTOCOL_VERSION + 1))
    );
    const newerError = await rejection(newer.listRepos());
    expect(newerError).toBeInstanceOf(ClientResponseError);
    expect((newerError as ClientResponseError).status).toBe(426);
    expect((newerError as ClientResponseError).message).toBe(
      `the server speaks thaddeus protocol ${PROTOCOL_VERSION + 1} and this CLI speaks ${PROTOCOL_VERSION}; update the CLI`
    );
    expect((newerError as ClientResponseError).details).toMatchObject({
      serverProtocol: PROTOCOL_VERSION + 1,
    });

    const older = new Client('http://t', Identity.create(), () =>
      Promise.resolve(mismatch(PROTOCOL_VERSION - 1))
    );
    const olderError = await rejection(older.listRepos());
    expect(olderError).toBeInstanceOf(ClientResponseError);
    expect((olderError as ClientResponseError).status).toBe(426);
    expect((olderError as ClientResponseError).message).toBe(
      `the server speaks thaddeus protocol ${PROTOCOL_VERSION - 1} and this CLI speaks ${PROTOCOL_VERSION}; the server is older than this CLI, so update the server or install an older CLI`
    );
  });

  test('a 426 without a serverProtocol keeps the server message', async () => {
    const client = new Client('http://t', Identity.create(), () =>
      Promise.resolve(
        Response.json({ error: 'upgrade required by a proxy' }, { status: 426 })
      )
    );
    const error = await rejection(client.listRepos());
    expect(error).toBeInstanceOf(ClientResponseError);
    expect((error as ClientResponseError).status).toBe(426);
    expect((error as ClientResponseError).message).toBe(
      'upgrade required by a proxy'
    );
  });

  test('a server without the header is accepted', async () => {
    // Servers that predate the protocol header answer with no wire headers.
    const client = new Client('http://t', Identity.create(), () =>
      Promise.resolve(
        Response.json({ repos: ['acme/web'], owners: {}, nextCursor: null })
      )
    );
    expect(await client.listRepos()).toEqual(['acme/web']);
  });
});
