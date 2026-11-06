import { describe, expect, test } from 'bun:test';

import {
  bytes,
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
  text,
  use,
  world,
} from './helpers';

const TENANT = 'acme';
const GRANTS = [
  { repo: 'app', scopes: ['read', 'edit', 'execute'] as const, paths: ['**'] },
];
const EXECUTE = {
  scope: 'execute' as const,
  tenant: TENANT,
  repo: 'app',
  paths: ['**'],
};

async function setup(backend?: ReturnType<typeof fileBackend>) {
  const w = await world(backend === undefined ? {} : { backend });
  const admin = Identity.create();
  const agent = Identity.create();
  await w.authority.createTenant(
    TENANT,
    policy([admin], [member(agent, 'agent', [...GRANTS])])
  );
  const token = await issue(w, agent, {
    tenant: TENANT,
    kind: 'agent',
    grants: [...GRANTS],
  });
  return { w, admin, agent, token };
}

describe('queued work', () => {
  test('a ticket redeems once into an authorization for the queued action', async () => {
    const { w, agent, token } = await setup();
    const ticket = await w.authority.queue(await use(w, agent, token, EXECUTE));
    w.clock.advance(MINUTE);
    const auth = await w.authority.redeem(ticket);
    expect(auth.scope).toBe('execute');
    expect(auth.subject).toBe(agent.did);
    expect(auth.ticket).toMatch(/^[0-9a-f]{32}$/);
    await refused(w.authority.redeem(ticket), 'ticket_used');
  });

  test('work queued under a credential revoked before it starts is refused', async () => {
    const { w, admin, agent, token } = await setup();
    const ticket = await w.authority.queue(await use(w, agent, token, EXECUTE));
    await revoke(w, TENANT, admin, { did: agent.did });
    await refused(w.authority.redeem(ticket), 'revoked');
  });

  test('work whose credential expires while queued is refused', async () => {
    const { w, agent, token } = await setup();
    const ticket = await w.authority.queue(await use(w, agent, token, EXECUTE));
    w.clock.advance(15 * MINUTE);
    await refused(w.authority.redeem(ticket), 'expired');
  });

  test('work the policy stopped granting while queued is refused', async () => {
    const { w, admin, agent, token } = await setup();
    const ticket = await w.authority.queue(await use(w, agent, token, EXECUTE));
    await changePolicy(
      w,
      TENANT,
      admin,
      0,
      policy(
        [admin],
        [
          member(agent, 'agent', [
            { repo: 'app', scopes: ['read'], paths: ['**'] },
          ]),
        ]
      )
    );
    await refused(w.authority.redeem(ticket), 'policy_denied');
    const log = await w.authority.audit(TENANT);
    const redeems = log.filter((r) => r.event === 'ticket.redeem');
    expect(redeems.map((r) => [r.outcome, r.code])).toEqual([
      ['deny', 'policy_denied'],
    ]);
  });

  test('a tampered ticket is refused', async () => {
    const { w, agent, token } = await setup();
    const ticket = await w.authority.queue(await use(w, agent, token, EXECUTE));
    const [prefix, body, sig] = ticket.split('.');
    const claims = JSON.parse(Buffer.from(body ?? '', 'base64url').toString());
    claims.scope = 'edit';
    const forged = `${prefix}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
    await refused(w.authority.redeem(forged), 'bad_ticket');
  });

  test('a queued edit still goes through key custody when it runs', async () => {
    const { w, agent, token } = await setup();
    const edit = await use(w, agent, token, {
      scope: 'edit',
      tenant: TENANT,
      repo: 'app',
      paths: ['src/a.ts'],
    });
    const ticket = await w.authority.queue(edit);
    const running = await w.authority.redeem(ticket);
    const sealed = await w.custody.seal(running, 'src/a.ts', bytes('queued'));
    const read = await use(w, agent, token, {
      scope: 'read',
      tenant: TENANT,
      repo: 'app',
      paths: ['src/a.ts'],
    });
    expect(text(await w.custody.open(read, 'src/a.ts', sealed))).toBe('queued');
  });

  test('a redeemed ticket stays redeemed after a restart', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const { w, agent, token } = await setup(fileBackend(dir));
      const ticket = await w.authority.queue(
        await use(w, agent, token, EXECUTE)
      );
      const pending = await w.authority.queue(
        await use(w, agent, token, EXECUTE)
      );
      await w.authority.redeem(ticket);
      const restarted = await w.reopen(fileBackend(dir));
      await refused(restarted.authority.redeem(ticket), 'ticket_used');
      // Work still waiting when the process stopped runs after it restarts.
      await restarted.authority.redeem(pending);
    } finally {
      cleanup();
    }
  });
});
