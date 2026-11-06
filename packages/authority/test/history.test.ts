import { describe, expect, test } from 'bun:test';

import {
  describeAttribution,
  type HeadContent,
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
    });
    const second = await w.authority.advance(await integrate(['src/b.ts']), {
      view: 'main',
      expectedVersion: 0,
      revision: 'rev-2',
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
  });

  test('a service record is never presented as an actor signature', async () => {
    const { w, worker, integrate } = await setup();
    const record = await w.authority.advance(await integrate(), {
      view: 'main',
      expectedVersion: null,
      revision: 'rev-1',
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
        }),
      'scope_denied'
    );
    await refused(integrate(['docs/a.md']), 'scope_denied');
  });

  test('a stale expected version is refused', async () => {
    const { w, integrate } = await setup();
    await w.authority.advance(await integrate(), {
      view: 'main',
      expectedVersion: null,
      revision: 'rev-1',
    });
    for (const expectedVersion of [null, 1]) {
      await refused(
        w.authority.advance(await integrate(), {
          view: 'main',
          expectedVersion,
          revision: 'rev-2',
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
