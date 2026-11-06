import { describe, expect, test } from 'bun:test';

import {
  changePolicy,
  fileBackend,
  Identity,
  issue,
  member,
  MINUTE,
  policy,
  refused,
  revoke,
  tempDir,
  use,
  world,
} from './helpers';

const TENANT = 'acme';
const READ = {
  scope: 'read' as const,
  tenant: TENANT,
  repo: 'app',
  paths: ['src/a.ts'],
};
const GRANTS = [{ repo: 'app', scopes: ['read'] as const, paths: ['**'] }];

async function setup(backend?: ReturnType<typeof fileBackend>) {
  const w = await world(backend === undefined ? {} : { backend });
  const admin = Identity.create();
  const alice = Identity.create();
  const agent = Identity.create();
  await w.authority.createTenant(
    TENANT,
    policy(
      [admin],
      [member(alice, 'human', [...GRANTS]), member(agent, 'agent', [...GRANTS])]
    )
  );
  return { w, admin, alice, agent };
}

describe('revocation', () => {
  test('a holder revokes one credential; its other credentials keep working', async () => {
    const { w, agent } = await setup();
    const one = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [...GRANTS],
    });
    const two = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [...GRANTS],
    });
    await revoke(w, TENANT, agent, { credential: one });
    await refused(use(w, agent, one, READ), 'revoked');
    await use(w, agent, two, READ);
  });

  test('an admin revokes every credential of a DID; later ones work', async () => {
    const { w, admin, agent } = await setup();
    const before = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [...GRANTS],
    });
    await revoke(w, TENANT, admin, { did: agent.did });
    await refused(use(w, agent, before, READ), 'revoked');
    w.clock.advance(1);
    const after = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [...GRANTS],
    });
    await use(w, agent, after, READ);
  });

  test('revoking a human revokes the agent sessions issued through them', async () => {
    const { w, admin, alice } = await setup();
    const helper = Identity.create();
    const session = await issue(w, alice, {
      tenant: TENANT,
      subject: helper.did,
      kind: 'agent',
      grants: [...GRANTS],
    });
    await use(w, helper, session, READ);
    await revoke(w, TENANT, admin, { did: alice.did });
    await refused(use(w, helper, session, READ), 'revoked');
  });

  test('only an admin, the principal or the holder may revoke', async () => {
    const { w, alice, agent } = await setup();
    const token = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [...GRANTS],
    });
    await refused(
      revoke(w, TENANT, alice, { credential: token }),
      'not_an_admin'
    );
    await refused(revoke(w, TENANT, alice, { did: agent.did }), 'not_an_admin');
    await use(w, agent, token, READ);
    const log = await w.authority.audit(TENANT);
    expect(
      log.filter((r) => r.event === 'credential.revoke').map((r) => r.outcome)
    ).toEqual(['deny', 'deny']);
  });

  test('removing a member from the policy refuses its live credential at once', async () => {
    const { w, admin, alice, agent } = await setup();
    const token = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [...GRANTS],
    });
    await use(w, agent, token, READ);
    await changePolicy(
      w,
      TENANT,
      admin,
      0,
      policy([admin], [member(alice, 'human', [...GRANTS])])
    );
    await refused(use(w, agent, token, READ), 'policy_denied');
  });

  test('narrowing the policy narrows live credentials to match', async () => {
    const { w, admin, alice, agent } = await setup();
    const token = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [...GRANTS],
    });
    await changePolicy(
      w,
      TENANT,
      admin,
      0,
      policy(
        [admin],
        [
          member(alice, 'human', [...GRANTS]),
          member(agent, 'agent', [
            { repo: 'app', scopes: ['read'], paths: ['docs/**'] },
          ]),
        ]
      )
    );
    await refused(use(w, agent, token, READ), 'policy_denied');
    await use(w, agent, token, { ...READ, paths: ['docs/a.md'] });
  });

  test('revocations survive a restart', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const { w, admin, alice, agent } = await setup(fileBackend(dir));
      const revoked = await issue(w, agent, {
        tenant: TENANT,
        kind: 'agent',
        grants: [...GRANTS],
      });
      const kept = await issue(w, alice, {
        tenant: TENANT,
        kind: 'human',
        grants: [...GRANTS],
      });
      await revoke(w, TENANT, admin, { credential: revoked });
      w.clock.advance(MINUTE);

      const restarted = await w.reopen(fileBackend(dir));
      await refused(use(restarted, agent, revoked, READ), 'revoked');
      await use(restarted, alice, kept, READ);
    } finally {
      cleanup();
    }
  });
});
