import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '../src/client';

beforeAll(async () => {
  await ready();
});

describe('Client.clone', () => {
  test('clone of an empty repo returns empty heads and an empty repo', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const c = new Client('http://t', a, srv.fetch.bind(srv));
    await c.createRepo('r');
    const { repo, heads } = await c.clone('r', new MemoryBackend());
    expect([...heads]).toEqual([]);
    expect(repo.log.materialize('main').size).toBe(0);
  });
});
