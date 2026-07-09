import { signDelegation } from '@thaddeus.run/agent';
import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import {
  type Release,
  type ReleaseFields,
  signRelease,
} from '@thaddeus.run/platform';
import { signClaim } from '@thaddeus.run/reputation';
import { type Capability, MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  decodeRelease,
  encodeBundle,
  encodeClaim,
  encodeDelegation,
  encodeRelease,
} from '../src/dto';
import { createServer } from '../src/server';
import { signRequest } from '../src/sign';

beforeAll(async () => {
  await ready();
});

const enc = (value: string): Uint8Array => new TextEncoder().encode(value);

function signed(
  method: string,
  path: string,
  bodyObj: unknown,
  signer: Identity
): Request {
  const body = enc(JSON.stringify(bodyObj));
  const headers = signRequest(
    method,
    path,
    body,
    signer,
    new Date().toISOString()
  );
  return new Request(`http://t${path}`, {
    method,
    body,
    headers: {
      'content-type': 'application/json',
      'x-thaddeus-did': headers.did,
      'x-thaddeus-timestamp': headers.timestamp,
      'x-thaddeus-signature': headers.signature,
    },
  });
}

async function createRepoWithHistory(
  srv: ReturnType<typeof createServer>,
  owner: Identity,
  name = 'r'
): Promise<{ heads: string[]; commits: string[] }> {
  expect(
    (await srv.fetch(signed('POST', '/repos', { name }, owner))).status
  ).toBe(201);

  const store = new MemoryStore();
  const log = new OpLog(store);
  const workspace = Workspace.open(log, store, {
    source: 'main',
    reader: owner,
    name: 'work',
  });
  workspace.write('README.md', enc('release me'));
  await workspace.commit(owner);

  const objects = [];
  const caps: Capability[] = [];
  for (const op of log.ops()) {
    const plaintextId = op.payload?.plaintext_id;
    if (plaintextId === undefined) continue;
    const object = store.current(plaintextId);
    if (object !== undefined) {
      objects.push(object);
      caps.push(...store.caps(plaintextId));
    }
  }
  expect(
    (
      await srv.fetch(
        signed(
          'POST',
          `/repos/${name}/push`,
          encodeBundle(log.ops(), objects, caps),
          owner
        )
      )
    ).status
  ).toBe(200);
  const heads = [...log.heads('work')];
  const landed = await srv.fetch(
    signed(
      'POST',
      `/repos/${name}/land`,
      { fromHeads: heads, into: 'main' },
      owner
    )
  );
  expect(landed.status).toBe(200);
  expect((await landed.json()) as { landed: boolean }).toEqual(
    expect.objectContaining({ landed: true })
  );
  return { heads, commits: log.ops().map((op) => op.id) };
}

function releaseFields(
  snapshot: { heads: string[]; commits: string[] },
  tag: string,
  overrides: Partial<ReleaseFields> = {}
): ReleaseFields {
  return {
    repo: 'r',
    tag,
    view: 'main',
    at: '2026-07-09T12:00:00.000Z',
    heads: snapshot.heads,
    commits: snapshot.commits,
    notes: 'Release notes',
    artifacts: [
      {
        name: 'app.tar.gz',
        uri: 'https://cdn.example/app.tar.gz',
        sha256:
          '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        size: 5,
        mediaType: 'application/gzip',
      },
    ],
    ...overrides,
  };
}

async function createRelease(
  srv: ReturnType<typeof createServer>,
  release: Release,
  signer: Identity,
  claim?: string
): Promise<Response> {
  return srv.fetch(
    signed(
      'POST',
      '/repos/r/releases',
      {
        release: encodeRelease(release),
        ...(claim === undefined ? {} : { claim }),
      },
      signer
    )
  );
}

describe('server releases', () => {
  test('owner creates immutable releases and public reads return newest first', async () => {
    const owner = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const snapshot = await createRepoWithHistory(srv, owner);
    const v1 = signRelease(releaseFields(snapshot, 'v1'), owner);
    const v2 = signRelease(
      releaseFields(snapshot, 'v2', { at: '2026-07-09T13:00:00.000Z' }),
      owner
    );

    expect((await createRelease(srv, v1, owner)).status).toBe(201);
    expect((await createRelease(srv, v2, owner)).status).toBe(201);
    const duplicate = await createRelease(srv, v1, owner);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.text()).toContain('release tag v1 already exists');

    const listed = (await (
      await srv.fetch(new Request('http://t/repos/r/releases'))
    ).json()) as { releases: string[] };
    expect(listed.releases.map((wire) => decodeRelease(wire).tag)).toEqual([
      'v2',
      'v1',
    ]);

    const detail = (await (
      await srv.fetch(new Request('http://t/repos/r/releases/v1'))
    ).json()) as { release: string };
    expect(decodeRelease(detail.release)).toEqual(v1);
  });

  test('unknown and stale views return clear errors', async () => {
    const owner = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const snapshot = await createRepoWithHistory(srv, owner);

    const unknown = signRelease(
      releaseFields(snapshot, 'unknown', { view: 'missing' }),
      owner
    );
    const unknownRes = await createRelease(srv, unknown, owner);
    expect(unknownRes.status).toBe(404);
    expect(await unknownRes.text()).toContain('no branch missing');

    const stale = signRelease(
      releaseFields(snapshot, 'stale', { heads: [], commits: [] }),
      owner
    );
    const staleRes = await createRelease(srv, stale, owner);
    expect(staleRes.status).toBe(409);
    expect(await staleRes.text()).toContain('view main changed');
  });

  test('release creator policy supports delegates, revocation, and allow lists', async () => {
    const owner = Identity.create();
    const delegate = Identity.create();
    const listed = Identity.create();
    const denied = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const snapshot = await createRepoWithHistory(srv, owner);

    expect(
      (
        await createRelease(
          srv,
          signRelease(releaseFields(snapshot, 'denied'), denied),
          denied
        )
      ).status
    ).toBe(403);

    const delegation = signDelegation(
      {
        agent: delegate.did,
        paths: ['**'],
        maxChanges: 100,
        maxSpend: 0,
      },
      owner
    );
    expect(
      (
        await srv.fetch(
          signed(
            'POST',
            '/repos/r/grants',
            { delegation: encodeDelegation(delegation) },
            owner
          )
        )
      ).status
    ).toBe(200);
    expect(
      (
        await srv.fetch(
          signed(
            'POST',
            '/repos/r/policy',
            {
              policy: {
                version: 1,
                release: { creators: 'delegates', allow: [] },
              },
            },
            owner
          )
        )
      ).status
    ).toBe(200);
    expect(
      (
        await createRelease(
          srv,
          signRelease(releaseFields(snapshot, 'delegate'), delegate),
          delegate
        )
      ).status
    ).toBe(201);

    expect(
      (
        await srv.fetch(
          signed('POST', '/repos/r/revoke', { agent: delegate.did }, owner)
        )
      ).status
    ).toBe(200);
    expect(
      (
        await createRelease(
          srv,
          signRelease(releaseFields(snapshot, 'revoked'), delegate),
          delegate
        )
      ).status
    ).toBe(403);

    expect(
      (
        await srv.fetch(
          signed(
            'POST',
            '/repos/r/policy',
            {
              policy: {
                version: 1,
                release: { creators: 'allowList', allow: [listed.did] },
              },
            },
            owner
          )
        )
      ).status
    ).toBe(200);
    expect(
      (
        await createRelease(
          srv,
          signRelease(releaseFields(snapshot, 'listed'), listed),
          listed
        )
      ).status
    ).toBe(201);
  });

  test('an attesting host records a valid release contribution', async () => {
    const owner = Identity.create();
    const host = Identity.create();
    const srv = createServer({ backend: new MemoryBackend(), host });
    const snapshot = await createRepoWithHistory(srv, owner);
    const release = signRelease(releaseFields(snapshot, 'attested'), owner);
    const claim = signClaim(
      {
        repo: 'r',
        ref: release.id,
        kind: 'release',
        at: release.at,
      },
      owner
    );

    expect(
      (await createRelease(srv, release, owner, encodeClaim(claim))).status
    ).toBe(201);
    const profile = (await (
      await srv.fetch(
        new Request(`http://t/reputation/${encodeURIComponent(owner.did)}`)
      )
    ).json()) as { byKind: Record<string, number> };
    expect(profile.byKind.release).toBe(1);
  });
});
