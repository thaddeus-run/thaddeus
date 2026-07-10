import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer, encodeCapability } from '@thaddeus.run/server';
import {
  issueCapability,
  MemoryStore,
  newContentKey,
  publicIdentity,
} from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '../src/client';

beforeAll(async () => {
  await ready();
});

describe('Client timed reveal', () => {
  test('ignores a pending schedule forged by an untrusted server', async () => {
    const owner = Identity.create();
    const attacker = Identity.create();
    const store = new MemoryStore();
    const ref = await store.put(new TextEncoder().encode('private'), owner);
    const forged = issueCapability({
      object: ref.plaintext_id,
      contentKey: newContentKey(),
      grantee: publicIdentity().toPublic(),
      grantedBy: attacker,
      notBefore: '2026-07-10T00:00:00.000Z',
    });
    const client = new Client('http://t', owner, () =>
      Promise.resolve(
        Response.json({ capabilities: [encodeCapability(forged)] })
      )
    );

    expect(
      await client.syncPendingReveals('r', store, [ref.plaintext_id])
    ).toBe(0);
    expect(store.pendingReveals(ref.plaintext_id)).toHaveLength(0);
  });

  test('treats a pre-P7 pending endpoint as an empty schedule set', async () => {
    const owner = Identity.create();
    const store = new MemoryStore();
    const ref = await store.put(new TextEncoder().encode('private'), owner);
    const client = new Client('http://t', owner, () =>
      Promise.resolve(new Response('not found', { status: 404 }))
    );

    expect(
      await client.syncPendingReveals('r', store, [ref.plaintext_id])
    ).toBe(0);
  });

  test('schedules and manually triggers a committed object', async () => {
    const owner = Identity.create();
    const server = createServer({ backend: new MemoryBackend() });
    const client = new Client('http://t', owner, server.fetch.bind(server));
    await client.createRepo('r');

    const { repo } = await client.clone('r', new MemoryBackend());
    const workspace = Workspace.open(repo.log, repo.store, {
      source: 'main',
      reader: owner,
      name: 'feat',
    });
    workspace.write('announcement.md', new TextEncoder().encode('later'));
    await workspace.commit(owner);
    const heads = [...repo.log.heads('feat')];
    await client.push('r', repo, heads);
    await client.land('r', heads);
    const ref = repo.log.materialize('feat', owner).get('announcement.md')!.ref;
    if (ref === null) throw new Error('expected committed file ref');
    const at = '2099-01-01T00:00:00.000Z';

    expect(await client.scheduleReveal('r', repo.store, ref, at)).toMatchObject(
      {
        object: ref.plaintext_id,
        at,
        scheduled: true,
        released: false,
        public: false,
      }
    );
    expect(await client.reveal('r', repo.store, ref)).toMatchObject({
      object: ref.plaintext_id,
      released: false,
      public: false,
    });
  });

  test('preserves a scheduled reveal through recall key rotation', async () => {
    let clock = new Date().toISOString();
    const owner = Identity.create();
    const delegate = Identity.create();
    const server = createServer({
      backend: new MemoryBackend(),
      now: () => clock,
    });
    const client = new Client('http://t', owner, server.fetch.bind(server));
    await client.createRepo('r');
    const { repo } = await client.clone('r', new MemoryBackend());
    const workspace = Workspace.open(repo.log, repo.store, {
      source: 'main',
      reader: owner,
      name: 'feat',
    });
    workspace.write('launch.md', new TextEncoder().encode('rotated reveal'));
    await workspace.commit(owner);
    const heads = [...repo.log.heads('feat')];
    await client.push('r', repo, heads);
    await client.land('r', heads);
    const ref = repo.log.materialize('feat', owner).get('launch.md')!.ref;
    if (ref === null) throw new Error('expected committed file ref');
    const at = new Date(Date.parse(clock) + 60_000).toISOString();
    await client.scheduleReveal('r', repo.store, ref, at);

    // Revoke from a different owner clone. Pending capabilities never travel
    // through public pull, so the owner syncs them over the authenticated path
    // before rotating the key.
    let promotedDuringSync = false;
    const otherClient = new Client('http://t', owner, async (request) => {
      if (
        !promotedDuringSync &&
        new URL(request.url).pathname === '/repos/r/reveals/pending'
      ) {
        promotedDuringSync = true;
        clock = at;
        expect(await server.revealDue()).toBe(1);
      }
      return server.fetch(request);
    });
    const { repo: other } = await otherClient.clone('r', new MemoryBackend());
    const otherRef = other.log.materialize('main', owner).get('launch.md')!.ref;
    if (otherRef === null) throw new Error('expected cloned file ref');
    expect(other.store.pendingReveals(otherRef.plaintext_id)).toHaveLength(0);
    expect(
      await otherClient.syncPendingReveals('r', other.store, [
        otherRef.plaintext_id,
      ])
    ).toBe(1);
    await other.store.grant(otherRef, delegate.toPublic(), owner);
    await other.store.revoke(otherRef, delegate.toPublic(), owner);
    await otherClient.revoke('r', delegate.did, {
      repo: other,
      heads: [...other.log.heads('main')],
    });

    expect(promotedDuringSync).toBe(true);
    expect(await server.revealDue()).toBe(1);
    const outsider = Identity.create();
    const outsiderClient = new Client(
      'http://t',
      outsider,
      server.fetch.bind(server)
    );
    const { repo: clone } = await outsiderClient.clone(
      'r',
      new MemoryBackend()
    );
    const publicRef = clone.log
      .materialize('main', outsider)
      .get('launch.md')!.ref;
    if (publicRef === null) throw new Error('expected public file ref');
    expect(
      new TextDecoder().decode(await clone.store.get(publicRef, outsider, at))
    ).toBe('rotated reveal');
  });
});
