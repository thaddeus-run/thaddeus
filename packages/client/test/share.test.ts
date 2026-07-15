import { signDelegation } from '@thaddeus.run/agent';
import { Workspace } from '@thaddeus.run/fs';
import { Identity, PublicIdentity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import type { Repo } from '@thaddeus.run/platform';
import { createServer, encodeDelegation } from '@thaddeus.run/server';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '../src/client';
import { reachablePids, reshareObjects } from '../src/share';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
type FetchImpl = (req: Request) => Promise<Response>;

// An owner with one landed file at `a.txt`. Returns the owner's client + repo.
async function seeded(
  owner: Identity,
  fetchImpl: FetchImpl
): Promise<{ client: Client; repo: Repo; heads: string[] }> {
  const client = new Client('http://t', owner, fetchImpl);
  await client.createRepo('r');
  const { repo } = await client.clone('r', new MemoryBackend());
  const ws = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: owner,
    name: 'w',
  });
  ws.write('a.txt', enc('hello'));
  await ws.commit(owner);
  const heads = [...repo.log.heads('w')];
  await client.push('r', repo, heads);
  await client.land('r', repo, heads, 'main');
  return { client, repo, heads };
}

// The bytes `reader` can decrypt at `path` on main, or null if denied/absent.
async function readAsMember(
  repo: Repo,
  reader: Identity,
  path: string
): Promise<string | null> {
  for (const [p, entry] of repo.log.materialize('main', reader)) {
    if (p === path && entry.ref !== null) {
      const bytes = await repo.store.get(entry.ref, reader);
      return new TextDecoder().decode(bytes);
    }
  }
  return null;
}

describe('Client.members', () => {
  test('owner + non-revoked delegates', async () => {
    const a = Identity.create();
    const b = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const c = new Client('http://t', a, srv.fetch.bind(srv));
    await c.createRepo('r');
    const { repo } = await c.clone('r', new MemoryBackend());

    expect(await c.members('r', repo)).toEqual([a.did]);

    await c.grant(
      'r',
      signDelegation(
        { agent: b.did, paths: ['**'], maxChanges: 10, maxSpend: 10 },
        a
      )
    );
    expect((await c.members('r', repo)).sort()).toEqual([a.did, b.did].sort());

    await c.revoke('r', b.did);
    expect(await c.members('r', repo)).toEqual([a.did]); // revoked member drops out
  });

  test('trusts only grants signed by the locally pinned owner', async () => {
    const owner = Identity.create();
    const delegate = Identity.create();
    const attacker = Identity.create();
    const substituted = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const trusted = new Client('http://t', owner, srv.fetch.bind(srv));
    await trusted.createRepo('r');
    const { repo } = await trusted.clone('r', new MemoryBackend());
    const fields = {
      paths: ['**'],
      maxChanges: 10,
      maxSpend: 10,
    } as const;
    const valid = signDelegation({ ...fields, agent: delegate.did }, owner);
    const forged = signDelegation(
      { ...fields, agent: substituted.did },
      attacker
    );
    const malformed = signDelegation({ ...fields, agent: 'not-a-did' }, owner);
    const hostile = new Client('http://t', owner, () =>
      Promise.resolve(
        Response.json({
          grants: [
            encodeDelegation(forged),
            encodeDelegation(malformed),
            encodeDelegation(valid),
          ],
          nextCursor: null,
        })
      )
    );

    expect(await hostile.members('r', repo)).toEqual(
      [owner.did, delegate.did].sort()
    );
  });
});

describe('reshareObjects', () => {
  test('shares a read capability, is idempotent, and lets the member decrypt', async () => {
    const a = Identity.create();
    const b = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const fetchImpl = srv.fetch.bind(srv);
    const { client, repo, heads } = await seeded(a, fetchImpl);

    // Before sharing, b holds no capability.
    const bClient = new Client('http://t', b, fetchImpl);
    const before = await bClient.clone('r', new MemoryBackend());
    // b holds no capability, so the read must fail. Assert it explicitly: an
    // un-awaited `.rejects` never runs, and awaiting it trips `await-thenable`.
    let denied: unknown;
    try {
      await readAsMember(before.repo, b, 'a.txt');
    } catch (err) {
      denied = err;
    }
    expect(String(denied)).toContain('access denied');

    const pids = reachablePids(repo, heads);
    const shared = await reshareObjects(
      repo,
      pids,
      [PublicIdentity.fromDid(b.did)],
      a
    );
    expect(shared).toBe(1);
    // Idempotent: b already holds a cap, so a second pass grants nothing.
    expect(
      await reshareObjects(repo, pids, [PublicIdentity.fromDid(b.did)], a)
    ).toBe(0);

    await client.push('r', repo, heads);
    const after = await bClient.clone('r', new MemoryBackend());
    expect(await readAsMember(after.repo, b, 'a.txt')).toBe('hello');
  });

  test('skips objects the granter cannot decrypt (no throw)', async () => {
    const a = Identity.create();
    const c = Identity.create();
    const d = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const fetchImpl = srv.fetch.bind(srv);
    const { heads } = await seeded(a, fetchImpl);

    // c clones: it has the ciphertext but no capability of its own.
    const cClient = new Client('http://t', c, fetchImpl);
    const { repo: cRepo } = await cClient.clone('r', new MemoryBackend());
    const granted = await reshareObjects(
      cRepo,
      reachablePids(cRepo, heads),
      [PublicIdentity.fromDid(d.did)],
      c
    );
    expect(granted).toBe(0); // nothing to re-wrap; must not throw
  });
});

describe('server cap-union', () => {
  test('a stale push does not drop a capability granted meanwhile', async () => {
    const a = Identity.create();
    const b = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const fetchImpl = srv.fetch.bind(srv);
    const { client, repo, heads } = await seeded(a, fetchImpl);

    // A clone taken BEFORE the grant — its store holds only a's capability.
    const stale = await client.clone('r', new MemoryBackend());

    // Grant b a read cap and publish it.
    await reshareObjects(
      repo,
      reachablePids(repo, heads),
      [PublicIdentity.fromDid(b.did)],
      a
    );
    await client.push('r', repo, heads);

    // The stale copy pushes the same (unchanged) object with only a's cap.
    // Without the server-side union this would overwrite and erase b's cap.
    await client.push('r', stale.repo, [...stale.heads]);

    const bClient = new Client('http://t', b, fetchImpl);
    const { repo: bRepo } = await bClient.clone('r', new MemoryBackend());
    expect(await readAsMember(bRepo, b, 'a.txt')).toBe('hello');
  });
});
