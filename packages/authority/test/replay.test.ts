import { describe, test } from 'bun:test';

import { proveAction, proveIssue } from '../src';
import {
  fileBackend,
  Identity,
  issue,
  member,
  MINUTE,
  policy,
  refused,
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
      const { w, agent, token } = await setup(fileBackend(dir));
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
});
