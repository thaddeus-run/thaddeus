import { decodeRecord } from '@thaddeus.run/store';
import { describe, expect, test } from 'bun:test';

import {
  type AdvanceInput,
  describeAttribution,
  type HeadContent,
  type ServiceHeadRecord,
  signActorClaim,
  verifyHeadRecord,
} from '../src';
import {
  fileBackend,
  Identity,
  issue,
  member,
  policy,
  refused,
  tempDir,
  use,
  world,
} from './helpers';

const TENANT = 'acme';

async function setup(backend?: ReturnType<typeof fileBackend>) {
  const w = await world(backend === undefined ? {} : { backend });
  const admin = Identity.create();
  const agent = Identity.create();
  const worker = Identity.create();
  await w.authority.createTenant(
    TENANT,
    policy(
      [admin],
      [
        member(agent, 'agent', [
          { repo: 'app', scopes: ['edit', 'read'], paths: ['src/**'] },
        ]),
        member(worker, 'worker', [
          { repo: 'app', scopes: ['integrate'], paths: ['src/**'] },
        ]),
      ]
    )
  );
  const workerToken = await issue(w, worker, {
    tenant: TENANT,
    kind: 'worker',
    grants: [{ repo: 'app', scopes: ['integrate'], paths: ['src/**'] }],
  });
  const integrate = (paths: string[] = ['src/a.ts']) =>
    use(w, worker, workerToken, {
      scope: 'integrate',
      tenant: TENANT,
      repo: 'app',
      paths,
    });
  return { w, admin, agent, worker, workerToken, integrate };
}

describe('service-authorized history advancement', () => {
  test('the service signs a chained record of who asked for each advancement', async () => {
    const { w, worker, integrate } = await setup();
    const first = await w.authority.advance(await integrate(), {
      view: 'main',
      expectedVersion: null,
      revision: 'rev-1',
      changedPaths: ['src/a.ts'],
    });
    const second = await w.authority.advance(await integrate(['src/b.ts']), {
      view: 'main',
      expectedVersion: 0,
      revision: 'rev-2',
      changedPaths: ['src/b.ts'],
    });
    expect([first.version, second.version]).toEqual([0, 1]);
    expect(second.previous).toBe(first.id);
    expect(second.paths).toEqual(['src/b.ts']);
    verifyHeadRecord(first, w.authority.did);
    verifyHeadRecord(second, w.authority.did);
    expect(second.requestedBy).toMatchObject({
      principal: worker.did,
      subject: worker.did,
      kind: 'worker',
    });
    expect(await w.authority.head(TENANT, 'app', 'main')).toEqual(second);
    // The record the authority keeps as the tip cannot be edited in place.
    expect(() => {
      (second.paths as string[]).push('src/c.ts');
    }).toThrow(TypeError);
  });

  test('a service record is never presented as an actor signature', async () => {
    const { w, worker, integrate } = await setup();
    const record = await w.authority.advance(await integrate(), {
      view: 'main',
      expectedVersion: null,
      revision: 'rev-1',
      changedPaths: ['src/a.ts'],
    });
    const attribution = describeAttribution(record);
    expect(attribution.recordedBy).toBe(w.authority.did);
    expect(attribution.requestedBy.subject).toBe(worker.did);
    expect(attribution.signedBy).toEqual([]);
  });

  test('actors who sign the exact content are listed as signers', async () => {
    const { w, agent, integrate } = await setup();
    const content: HeadContent = {
      tenant: TENANT,
      repo: 'app',
      view: 'main',
      version: 0,
      previous: null,
      revision: 'rev-1',
      paths: ['src/a.ts'],
    };
    const record = await w.authority.advance(await integrate(), {
      view: 'main',
      expectedVersion: null,
      revision: 'rev-1',
      changedPaths: ['src/a.ts'],
      actorClaims: [signActorClaim(agent, content)],
    });
    expect(describeAttribution(record).signedBy).toEqual([agent.did]);
    verifyHeadRecord(record, w.authority.did);
  });

  test('a claim over different content is refused, not recorded', async () => {
    const { w, agent, integrate } = await setup();
    const claim = signActorClaim(agent, {
      tenant: TENANT,
      repo: 'app',
      view: 'main',
      version: 0,
      previous: null,
      revision: 'something-else',
      paths: ['src/a.ts'],
    });
    await refused(
      w.authority.advance(await integrate(), {
        view: 'main',
        expectedVersion: null,
        revision: 'rev-1',
        changedPaths: ['src/a.ts'],
        actorClaims: [claim],
      }),
      'invalid_claim'
    );
    expect(await w.authority.head(TENANT, 'app', 'main')).toBeNull();
  });

  test('relabelling a record breaks its service signature', async () => {
    const { w, agent, integrate } = await setup();
    const record = await w.authority.advance(await integrate(), {
      view: 'main',
      expectedVersion: null,
      revision: 'rev-1',
      changedPaths: ['src/a.ts'],
    });
    const relabelled = {
      ...record,
      requestedBy: {
        ...record.requestedBy,
        subject: agent.did,
        kind: 'agent' as const,
      },
    };
    await refused(
      () => verifyHeadRecord(relabelled, w.authority.did),
      'invalid_claim'
    );
    await refused(
      () => verifyHeadRecord(record, Identity.create().did),
      'invalid_claim'
    );
  });

  test('only an integrate authorization over the changed paths advances history', async () => {
    const { w, agent, integrate } = await setup();
    const agentToken = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [{ repo: 'app', scopes: ['edit'], paths: ['src/**'] }],
    });
    const edit = await use(w, agent, agentToken, {
      scope: 'edit',
      tenant: TENANT,
      repo: 'app',
      paths: ['src/a.ts'],
    });
    await refused(
      () =>
        w.authority.advance(edit, {
          view: 'main',
          expectedVersion: null,
          revision: 'r',
          changedPaths: ['src/a.ts'],
        }),
      'scope_denied'
    );
    await refused(integrate(['docs/a.md']), 'scope_denied');
  });

  test('every changed path must be inside the authorization', async () => {
    const { w, integrate } = await setup();
    const input = (changedPaths: string[]): AdvanceInput => ({
      view: 'main',
      expectedVersion: null,
      revision: 'rev-1',
      changedPaths,
    });
    // Authorized for src/a.ts, but the revision also changes other files.
    for (const changed of [['src/b.ts'], ['src/a.ts', 'docs/a.md']]) {
      await refused(
        w.authority.advance(await integrate(), input(changed)),
        'scope_denied'
      );
    }
    const auth = await integrate();
    await refused(
      () => w.authority.advance(auth, input(['../a.ts'])),
      'malformed'
    );
    expect(await w.authority.head(TENANT, 'app', 'main')).toBeNull();

    const record = await w.authority.advance(
      await integrate(['src/**']),
      input(['src/b.ts', 'src/a.ts', 'src/a.ts'])
    );
    expect(record.paths).toEqual(['src/a.ts', 'src/b.ts']);
    const denials = (await w.authority.audit(TENANT)).filter(
      (r) => r.event === 'history.advance' && r.outcome === 'deny'
    );
    expect(denials.map((r) => r.paths)).toEqual([
      ['src/b.ts'],
      ['docs/a.md', 'src/a.ts'],
    ]);
  });

  test('a genuine record copied under another view is not its head', async () => {
    const { w, integrate } = await setup();
    const input = (view: string): AdvanceInput => ({
      view,
      expectedVersion: null,
      revision: 'rev-1',
      changedPaths: ['src/a.ts'],
    });
    await w.authority.advance(await integrate(), input('main'));
    await w.authority.advance(await integrate(), input('other'));
    let mainBytes: Uint8Array | undefined;
    let otherBytes: Uint8Array | undefined;
    let otherKey: string | undefined;
    for (const key of await w.backend.list('authority/head/')) {
      const raw = await w.backend.get(key);
      if (raw === undefined) continue;
      const { view } = decodeRecord(raw) as ServiceHeadRecord;
      if (view === 'main') mainBytes = raw;
      else [otherKey, otherBytes] = [key, raw];
    }
    if (
      mainBytes === undefined ||
      otherBytes === undefined ||
      otherKey === undefined
    ) {
      throw new Error('expected one record per view');
    }
    // Someone with write access to storage plants a genuine record where it
    // does not belong: main's record in other's place, or other's first
    // record as its second. The signatures are real; the places are not.
    const next = otherKey.replace(/\d{12}$/, '000000000001');
    const plants: [string, Uint8Array][] = [
      [otherKey, mainBytes],
      [next, otherBytes],
    ];
    for (const [key, planted] of plants) {
      await w.backend.put(key, planted);
      const restarted = await w.reopen();
      await refused(
        restarted.authority.head(TENANT, 'app', 'other'),
        'invalid_claim'
      );
      expect(
        (await restarted.authority.head(TENANT, 'app', 'main'))?.view
      ).toBe('main');
      await w.backend.put(otherKey, otherBytes);
      await w.backend.delete(next);
    }
  });

  test('a stale expected version is refused', async () => {
    const { w, integrate } = await setup();
    await w.authority.advance(await integrate(), {
      view: 'main',
      expectedVersion: null,
      revision: 'rev-1',
      changedPaths: ['src/a.ts'],
    });
    for (const expectedVersion of [null, 1]) {
      await refused(
        w.authority.advance(await integrate(), {
          view: 'main',
          expectedVersion,
          revision: 'rev-2',
          changedPaths: ['src/a.ts'],
        }),
        'stale_head'
      );
    }
  });

  test('the chain and its audit survive a restart', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const { w, integrate } = await setup(fileBackend(dir));
      const first = await w.authority.advance(await integrate(), {
        view: 'main',
        expectedVersion: null,
        revision: 'rev-1',
        changedPaths: ['src/a.ts'],
      });
      const restarted = await w.reopen(fileBackend(dir));
      expect(await restarted.authority.head(TENANT, 'app', 'main')).toEqual(
        first
      );
      const advances = (await restarted.authority.audit(TENANT)).filter(
        (r) => r.event === 'history.advance'
      );
      expect(advances.map((r) => r.outcome)).toEqual(['allow']);
    } finally {
      cleanup();
    }
  });
});
