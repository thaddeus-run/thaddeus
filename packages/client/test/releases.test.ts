import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { signRelease } from '@thaddeus.run/platform';
import { createServer, encodeRelease } from '@thaddeus.run/server';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '../src/client';

beforeAll(async () => {
  await ready();
});

async function errorMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected promise to reject');
}

describe('Client releases', () => {
  test('create, list, and get decode signed release records', async () => {
    const owner = Identity.create();
    const server = createServer({ backend: new MemoryBackend() });
    const client = new Client('http://t', owner, server.fetch.bind(server));
    await client.createRepo('r');
    const release = signRelease(
      {
        repo: 'r',
        tag: 'v1',
        view: 'main',
        at: '2026-07-09T12:00:00.000Z',
        heads: [],
        commits: [],
        notes: 'Empty seed release',
        artifacts: [],
      },
      owner
    );

    expect(await client.createRelease('r', release)).toEqual(release);
    expect(await client.listReleases('r')).toEqual([release]);
    expect(await client.getRelease('r', 'v1')).toEqual(release);
    expect(await errorMessage(client.createRelease('r', release))).toContain(
      'release tag v1 already exists'
    );
  });

  test('rejects a validly signed release returned for another repo', async () => {
    const owner = Identity.create();
    const wrongRepo = signRelease(
      {
        repo: 'other',
        tag: 'v1',
        view: 'main',
        at: '2026-07-09T12:00:00.000Z',
        heads: [],
        commits: [],
        notes: null,
        artifacts: [],
      },
      owner
    );
    const wire = encodeRelease(wrongRepo);
    const client = new Client('http://t', owner, (req) =>
      Promise.resolve(
        req.url.endsWith('/v1')
          ? Response.json({ release: wire })
          : Response.json({ releases: [wire] })
      )
    );

    expect(await client.listReleases('r')).toEqual([]);
    expect(await errorMessage(client.getRelease('r', 'v1'))).toContain(
      'invalid release record'
    );
  });
});
