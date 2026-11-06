import { describe, expect, test } from 'bun:test';

import { Authority, AuthorityError, type TenantPolicy } from '../src';
import {
  changePolicy,
  Identity,
  issue,
  member,
  policy,
  refused,
  revoke,
  use,
  world,
} from './helpers';

const TENANT = 'acme';

async function setup() {
  const w = await world();
  const admin1 = Identity.create();
  const admin2 = Identity.create();
  const worker = Identity.create();
  const integrate = [
    { repo: 'app', scopes: ['integrate'] as const, paths: ['**'] },
  ];
  await w.authority.createTenant(
    TENANT,
    policy([admin1, admin2], [member(worker, 'worker', [...integrate])])
  );
  const token = await issue(w, worker, {
    tenant: TENANT,
    kind: 'worker',
    grants: [...integrate],
  });
  const authorize = () =>
    use(w, worker, token, {
      scope: 'integrate',
      tenant: TENANT,
      repo: 'app',
      paths: ['src/a.ts'],
    });
  // A policy that keeps both admins and drops the worker's integrate grant.
  const withoutWorker = policy([admin1, admin2], []);
  return { w, admin1, admin2, worker, token, authorize, withoutWorker };
}

async function settle<T>(
  promises: Promise<T>[]
): Promise<{ won: T[]; lost: string[] }> {
  const results = await Promise.allSettled(promises);
  const won: T[] = [];
  const lost: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') won.push(result.value);
    else lost.push((result.reason as AuthorityError).code);
  }
  return { won, lost };
}

describe('concurrent policy changes', () => {
  test('two admins changing the same version: one wins, one gets conflict', async () => {
    const { w, admin1, admin2, withoutWorker } = await setup();
    const { won, lost } = await settle([
      changePolicy(w, TENANT, admin1, 0, withoutWorker),
      changePolicy(w, TENANT, admin2, 0, policy([admin2], [])),
    ]);
    expect(won).toHaveLength(1);
    expect(lost).toEqual(['conflict']);
    expect(w.authority.policy(TENANT).version).toBe(1);
  });

  test('two authorities over one backend cannot both write the next version', async () => {
    const { w, admin1, admin2, withoutWorker } = await setup();
    const second = await Authority.open({
      backend: w.backend,
      signer: w.service,
      now: w.clock.now,
    });
    const other = { ...w, authority: second };
    const { won, lost } = await settle([
      changePolicy(w, TENANT, admin1, 0, withoutWorker),
      changePolicy(other, TENANT, admin2, 0, policy([admin2], [])),
    ]);
    expect(won).toHaveLength(1);
    expect(lost).toEqual(['conflict']);
    const versions = await w.backend.list('authority/policy/acme/');
    expect(versions).toHaveLength(2);
    // The stored version 1 is whichever change won.
    const reopened = await Authority.open({
      backend: w.backend,
      signer: w.service,
      now: w.clock.now,
    });
    expect(reopened.policy(TENANT)).toEqual(won[0] as TenantPolicy);
  });

  test('an advancement queued before a policy change commits under the old version', async () => {
    const { w, admin1, authorize, withoutWorker } = await setup();
    const auth = await authorize();
    const advancing = w.authority.advance(auth, {
      view: 'main',
      expectedVersion: null,
      revision: 'r1',
    });
    const changing = changePolicy(w, TENANT, admin1, 0, withoutWorker);
    const record = await advancing;
    await changing;
    expect(record.policyVersion).toBe(0);
    // From here on the same authorization advances nothing.
    await refused(
      w.authority.advance(auth, {
        view: 'main',
        expectedVersion: 0,
        revision: 'r2',
      }),
      'policy_denied'
    );
  });

  test('a policy change queued before an advancement refuses it', async () => {
    const { w, admin1, authorize, withoutWorker } = await setup();
    const auth = await authorize();
    const changing = changePolicy(w, TENANT, admin1, 0, withoutWorker);
    const advancing = w.authority.advance(auth, {
      view: 'main',
      expectedVersion: null,
      revision: 'r1',
    });
    await changing;
    await refused(advancing, 'policy_denied');
    expect(await w.authority.head(TENANT, 'app', 'main')).toBeNull();
  });

  test('a revocation that returns has outwaited every advancement in flight', async () => {
    const { w, admin1, worker, authorize } = await setup();
    const auth = await authorize();
    let advanced = false;
    const advancing = w.authority
      .advance(auth, { view: 'main', expectedVersion: null, revision: 'r1' })
      .then(() => {
        advanced = true;
      });
    await revoke(w, TENANT, admin1, { did: worker.did });
    expect(advanced).toBe(true);
    await advancing;
    await refused(
      w.authority.advance(auth, {
        view: 'main',
        expectedVersion: 0,
        revision: 'r2',
      }),
      'revoked'
    );
  });

  test('two advancements from the same version: one wins, one gets stale_head', async () => {
    const { w, authorize } = await setup();
    const [a, b] = [await authorize(), await authorize()];
    const { won, lost } = await settle([
      w.authority.advance(a, {
        view: 'main',
        expectedVersion: null,
        revision: 'ra',
      }),
      w.authority.advance(b, {
        view: 'main',
        expectedVersion: null,
        revision: 'rb',
      }),
    ]);
    expect(won).toHaveLength(1);
    expect(lost).toEqual(['stale_head']);
  });

  test('two authorities advancing one view cannot fork it', async () => {
    const { w, worker, token } = await setup();
    const second = await Authority.open({
      backend: w.backend,
      signer: w.service,
      now: w.clock.now,
    });
    const other = { ...w, authority: second };
    const action = {
      scope: 'integrate' as const,
      tenant: TENANT,
      repo: 'app',
      paths: ['src/a.ts'],
    };
    const a = await use(w, worker, token, action);
    const b = await use(other, worker, token, action);
    const { won, lost } = await settle([
      w.authority.advance(a, {
        view: 'main',
        expectedVersion: null,
        revision: 'ra',
      }),
      second.advance(b, {
        view: 'main',
        expectedVersion: null,
        revision: 'rb',
      }),
    ]);
    expect(won).toHaveLength(1);
    expect(lost).toEqual(['stale_head']);
    expect(await w.backend.list('authority/head/')).toHaveLength(1);
  });
});
