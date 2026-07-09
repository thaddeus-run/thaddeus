import { Workspace } from '@thaddeus.run/fs';
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

  test('pull can cache a remote view under a different local view', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const c = new Client('http://t', a, srv.fetch.bind(srv));
    await c.createRepo('r');

    const { repo } = await c.clone('r', new MemoryBackend());
    const main = Workspace.open(repo.log, repo.store, {
      source: 'main',
      reader: a,
      name: 'main-work',
    });
    main.write('a.txt', new TextEncoder().encode('main'));
    await main.commit(a);
    await repo.log.repoint('main', repo.log.heads('main-work'));
    await c.push('r', repo, repo.log.heads('main'));
    await c.land('r', repo.log.heads('main'), 'main');

    await c.createView('r', 'feature', repo.log.heads('main'));
    const feature = Workspace.open(repo.log, repo.store, {
      source: 'main',
      reader: a,
      name: 'feature-work',
    });
    feature.write('a.txt', new TextEncoder().encode('feature'));
    await feature.commit(a);
    await repo.log.repoint('feature', repo.log.heads('feature-work'));
    await c.push('r', repo, repo.log.heads('feature'));
    const featureLand = await c.land('r', repo.log.heads('feature'), 'feature');
    expect(featureLand.landed).toBe(true);

    const mirrorBackend = new MemoryBackend();
    const { repo: mirror } = await c.clone('r', mirrorBackend);
    expect(mirror.log.hasView('feature')).toBe(false);

    const inspect = 'land/inspect/feature';
    const pulled = await c.pull('r', mirror, mirrorBackend, 'feature', inspect);
    expect([...mirror.log.heads(inspect)]).toEqual([...pulled.heads]);
    expect(mirror.log.hasView('feature')).toBe(false);

    const entry = mirror.log.materialize(inspect, a).get('a.txt');
    expect(entry?.ref).toBeDefined();
    if (entry?.ref != null) {
      const text = new TextDecoder().decode(
        await mirror.store.get(entry.ref, a)
      );
      expect(text).toBe('feature');
    }
  });
});
