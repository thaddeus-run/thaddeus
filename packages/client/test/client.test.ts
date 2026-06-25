import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '../src/client';

beforeAll(async () => {
  await ready();
});

// A server whose fetch we hand straight to the Client (no port).
function server() {
  const srv = createServer({ backend: new MemoryBackend() });
  return srv.fetch.bind(srv);
}

describe('Client — createRepo / listRepos', () => {
  test('signed create sets the owner; list shows it', async () => {
    const a = Identity.create();
    const c = new Client('http://t', a, server());
    const created = await c.createRepo('acme/web');
    expect(created).toEqual({ name: 'acme/web', owner: a.did });
    expect([...(await c.listRepos())]).toEqual(['acme/web']);
  });

  test('a server error becomes a thrown Error with the message', async () => {
    const a = Identity.create();
    const fetchImpl = server();
    const c = new Client('http://t', a, fetchImpl);
    await c.createRepo('dup');
    const c2 = new Client('http://t', a, fetchImpl);
    // Re-create the same name → 409 → throws.
    let msg = '';
    try {
      await c2.createRepo('dup');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('already exists');
  });
});
