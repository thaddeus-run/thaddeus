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

  test('clone makes a single /pull request (no /views call)', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const paths: string[] = [];
    // Wrap the server fetch to record request paths.
    const recordingFetch = (req: Request): Promise<Response> => {
      paths.push(new URL(req.url).pathname);
      return srv.fetch(req);
    };
    const c = new Client('http://t', a, recordingFetch);
    await c.createRepo('r');
    paths.length = 0; // ignore the create
    const { heads } = await c.clone('r', new MemoryBackend());
    expect([...heads]).toEqual([]);
    const gets = paths.filter(
      (p) => p.includes('/pull') || p.includes('/views')
    );
    expect(gets).toEqual(['/repos/r/pull']); // exactly one read, the pull
  });
});
