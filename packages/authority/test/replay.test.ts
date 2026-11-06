import { describe, expect, test } from 'bun:test';

import { decodeCredential, proveAction, proveIssue } from '../src';
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

async function setup(options: Parameters<typeof world>[0] = {}) {
  const w = await world(options);
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
  return { w, agent, token };
}

describe('replay', () => {
  test('a proof is single-use', async () => {
    const { w, agent, token } = await setup();
    const proof = proveAction(agent, token, READ, { now: w.clock.now() });
    await w.authority.authorize(token, READ, proof);
    await refused(w.authority.authorize(token, READ, proof), 'replayed');
  });

  test('a proof for one action does not authorize another', async () => {
    const { w, agent, token } = await setup();
    const proof = proveAction(agent, token, READ, { now: w.clock.now() });
    await refused(
      w.authority.authorize(token, { ...READ, paths: ['src/b.ts'] }, proof),
      'bad_proof'
    );
    await refused(
      w.authority.authorize(token, { ...READ, digest: 'POST /other' }, proof),
      'bad_proof'
    );
  });

  test('a proof is bound to its credential', async () => {
    const { w, agent, token } = await setup();
    const second = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [...GRANTS],
    });
    const proof = proveAction(agent, token, READ, { now: w.clock.now() });
    await refused(w.authority.authorize(second, READ, proof), 'bad_proof');
  });

  test('a stolen credential is useless without the holder key', async () => {
    const { w, token } = await setup();
    const thief = Identity.create();
    await refused(use(w, thief, token, READ), 'bad_proof');
  });

  test('proofs outside the five-minute window are refused', async () => {
    const { w, agent, token } = await setup();
    const old = proveAction(agent, token, READ, {
      now: w.clock.now() - 5 * MINUTE - 1,
    });
    await refused(w.authority.authorize(token, READ, old), 'stale_proof');
    const future = proveAction(agent, token, READ, {
      now: w.clock.now() + 5 * MINUTE + 1,
    });
    await refused(w.authority.authorize(token, READ, future), 'stale_proof');
  });

  test('an issuance request is single-use', async () => {
    const { w, agent } = await setup();
    const request = {
      service: w.authority.did,
      tenant: TENANT,
      principal: agent.did,
      subject: agent.did,
      kind: 'agent' as const,
      grants: [...GRANTS],
    };
    const proof = proveIssue(agent, request, { now: w.clock.now() });
    await w.authority.issue(request, proof);
    await refused(w.authority.issue(request, proof), 'replayed');
  });

  test('a used proof stays used after a restart', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const { w, agent, token } = await setup({ backend: fileBackend(dir) });
      const proof = proveAction(agent, token, READ, { now: w.clock.now() });
      await w.authority.authorize(token, READ, proof);
      w.clock.advance(MINUTE);
      const restarted = await w.reopen(fileBackend(dir));
      await refused(
        restarted.authority.authorize(token, READ, proof),
        'replayed'
      );
    } finally {
      cleanup();
    }
  });

  test('a signed request for another service is refused here', async () => {
    const { w, agent } = await setup();
    const request = {
      service: Identity.create().did,
      tenant: TENANT,
      principal: agent.did,
      subject: agent.did,
      kind: 'agent' as const,
      grants: [...GRANTS],
    };
    const proof = proveIssue(agent, request, { now: w.clock.now() });
    await refused(() => w.authority.issue(request, proof), 'wrong_service');
    // Relabelling it for this service breaks the signature.
    await refused(
      () => w.authority.issue({ ...request, service: w.authority.did }, proof),
      'bad_proof'
    );
  });

  test('a stranger spends no nonces and writes nothing in the tenant', async () => {
    const { w, agent } = await setup({ nonceCapacity: 2 });
    const before = (await w.authority.audit(TENANT)).length;
    const stranger = Identity.create();
    for (let i = 0; i < 3; i++) {
      await refused(
        issue(w, stranger, {
          tenant: TENANT,
          kind: 'agent',
          grants: [...GRANTS],
        }),
        'not_a_member'
      );
    }
    await refused(
      () => revoke(w, TENANT, stranger, { did: stranger.did }),
      'not_a_member'
    );
    await refused(
      () => changePolicy(w, TENANT, stranger, 0, policy([stranger], [])),
      'not_a_member'
    );
    expect(await w.authority.audit(TENANT)).toHaveLength(before);
    expect(await w.backend.list('authority/revocation/')).toEqual([]);
    // The tenant's own member still gets through: no nonce was spent.
    await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [...GRANTS],
    });
  });

  test('refused uses of a genuine token are audited in its tenant', async () => {
    const { w, agent, token } = await setup();
    const now = { now: w.clock.now() };
    const proof = () => proveAction(agent, token, READ, now);
    await refused(
      w.authority.authorize(
        token,
        READ,
        proveAction(Identity.create(), token, READ, now)
      ),
      'bad_proof'
    );
    await refused(
      w.authority.authorize(token, { ...READ, tenant: 'elsewhere' }, proof()),
      'wrong_tenant'
    );
    await refused(
      w.authority.authorize(token, { ...READ, paths: ['../a.ts'] }, proof()),
      'malformed'
    );
    const denials = (await w.authority.audit(TENANT)).filter(
      (r) => r.event === 'authorize'
    );
    const { id } = decodeCredential(token, w.authority.did);
    expect(denials.map((r) => [r.outcome, r.code, r.credential])).toEqual([
      ['deny', 'bad_proof', id],
      ['deny', 'wrong_tenant', id],
      ['deny', 'malformed', id],
    ]);
    // A token another service issued names no tenant to audit in here.
    const elsewhere = await setup();
    await refused(
      w.authority.authorize(elsewhere.token, READ, proof()),
      'bad_credential'
    );
    expect(
      (await w.authority.audit(TENANT)).filter((r) => r.event === 'authorize')
    ).toHaveLength(3);
  });
});
