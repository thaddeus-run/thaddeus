import { describe, expect, test } from 'bun:test';

import { Authority, decodeCredential, DEFAULT_TTL, proveIssue } from '../src';
import {
  HOUR,
  Identity,
  issue,
  member,
  MINUTE,
  policy,
  refused,
  use,
  world,
} from './helpers';

const TENANT = 'acme';

async function acme() {
  const w = await world();
  const admin = Identity.create();
  const alice = Identity.create();
  const agent = Identity.create();
  const worker = Identity.create();
  await w.authority.createTenant(
    TENANT,
    policy(
      [admin],
      [
        member(alice, 'human', [
          { repo: 'app', scopes: ['read', 'edit', 'review'], paths: ['**'] },
        ]),
        member(agent, 'agent', [
          { repo: 'app', scopes: ['read', 'edit'], paths: ['src/**'] },
        ]),
        member(worker, 'worker', [
          {
            repo: 'app',
            scopes: ['read', 'execute', 'integrate'],
            paths: ['**'],
          },
        ]),
      ]
    )
  );
  return { w, admin, alice, agent, worker };
}

describe('issuing credentials', () => {
  test('a member gets a holder-bound credential cut from its policy grants', async () => {
    const { w, agent } = await acme();
    const token = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [{ repo: 'app', scopes: ['read'], paths: ['src/lib/**'] }],
    });
    const claims = decodeCredential(token, w.authority.did);
    expect(claims.subject).toBe(agent.did);
    expect(claims.principal).toBe(agent.did);
    expect(claims.kind).toBe('agent');
    expect(claims.policyVersion).toBe(0);
    // Agents default to 15 minutes.
    expect(claims.expiresAt - claims.issuedAt).toBe(15 * MINUTE);

    const auth = await use(w, agent, token, {
      scope: 'read',
      tenant: TENANT,
      repo: 'app',
      paths: ['src/lib/a.ts'],
    });
    expect(auth.subject).toBe(agent.did);
    expect(auth.allows('src/lib/a.ts')).toBe(true);
    expect(auth.allows('src/lib/deep/b.ts')).toBe(false);
  });

  test('grants beyond the policy are refused, by scope, path and repository', async () => {
    const { w, agent } = await acme();
    for (const grants of [
      [{ repo: 'app', scopes: ['integrate'] as const, paths: ['src/**'] }],
      [{ repo: 'app', scopes: ['read'] as const, paths: ['docs/**'] }],
      [{ repo: 'app', scopes: ['read'] as const, paths: ['**'] }],
      [{ repo: 'other', scopes: ['read'] as const, paths: ['src/**'] }],
    ]) {
      await refused(
        issue(w, agent, { tenant: TENANT, kind: 'agent', grants }),
        'policy_denied'
      );
    }
  });

  test('scopes are separate: edit does not read, read does not integrate', async () => {
    const { w, agent, worker } = await acme();
    const editor = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [{ repo: 'app', scopes: ['edit'], paths: ['src/**'] }],
    });
    await refused(
      use(w, agent, editor, {
        scope: 'read',
        tenant: TENANT,
        repo: 'app',
        paths: ['src/a.ts'],
      }),
      'scope_denied'
    );
    const reader = await issue(w, worker, {
      tenant: TENANT,
      kind: 'worker',
      grants: [{ repo: 'app', scopes: ['read'], paths: ['**'] }],
    });
    for (const scope of ['edit', 'execute', 'review', 'integrate'] as const) {
      await refused(
        use(w, worker, reader, {
          scope,
          tenant: TENANT,
          repo: 'app',
          paths: ['src/a.ts'],
        }),
        'scope_denied'
      );
    }
  });

  test('path restrictions hold for exact paths and whole-repository requests', async () => {
    const { w, agent } = await acme();
    const token = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [{ repo: 'app', scopes: ['read'], paths: ['src/**'] }],
    });
    for (const paths of [
      ['docs/a.md'],
      ['**'],
      ['src'],
      ['src/a.ts', 'README'],
    ]) {
      await refused(
        use(w, agent, token, {
          scope: 'read',
          tenant: TENANT,
          repo: 'app',
          paths,
        }),
        'scope_denied'
      );
    }
    // The holder's own client refuses to sign an escaping path.
    await refused(
      () =>
        use(w, agent, token, {
          scope: 'read',
          tenant: TENANT,
          repo: 'app',
          paths: ['src/../secrets'],
        }),
      'malformed'
    );
  });

  test('lifetimes stay under the ceiling for the subject kind', async () => {
    const { w, agent, alice } = await acme();
    const grants = [
      { repo: 'app', scopes: ['read'] as const, paths: ['src/**'] },
    ];
    await refused(
      issue(w, agent, {
        tenant: TENANT,
        kind: 'agent',
        grants,
        ttlMs: 2 * HOUR,
      }),
      'malformed'
    );
    const hour = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants,
      ttlMs: HOUR,
    });
    expect(decodeCredential(hour, w.authority.did).expiresAt).toBe(
      w.clock.now() + HOUR
    );
    const session = await issue(w, alice, {
      tenant: TENANT,
      kind: 'human',
      grants,
      ttlMs: 12 * HOUR,
    });
    expect(decodeCredential(session, w.authority.did).expiresAt).toBe(
      w.clock.now() + 12 * HOUR
    );
    await refused(
      issue(w, alice, {
        tenant: TENANT,
        kind: 'human',
        grants,
        ttlMs: 13 * HOUR,
      }),
      'malformed'
    );
  });

  test('a credential expires: usable 1 ms before, refused at expiry', async () => {
    const { w, agent } = await acme();
    const token = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [{ repo: 'app', scopes: ['read'], paths: ['src/**'] }],
    });
    const action = {
      scope: 'read' as const,
      tenant: TENANT,
      repo: 'app',
      paths: ['src/a.ts'],
    };
    w.clock.advance(15 * MINUTE - 1);
    await use(w, agent, token, action);
    w.clock.advance(1);
    await refused(use(w, agent, token, action), 'expired');
  });

  test('a human issues a narrower agent session to an agent key it runs', async () => {
    const { w, alice } = await acme();
    const helper = Identity.create();
    const token = await issue(w, alice, {
      tenant: TENANT,
      subject: helper.did,
      kind: 'agent',
      grants: [{ repo: 'app', scopes: ['edit'], paths: ['docs/**'] }],
    });
    const claims = decodeCredential(token, w.authority.did);
    expect(claims.principal).toBe(alice.did);
    expect(claims.subject).toBe(helper.did);
    const auth = await use(w, helper, token, {
      scope: 'edit',
      tenant: TENANT,
      repo: 'app',
      paths: ['docs/guide.md'],
    });
    expect(auth.principal).toBe(alice.did);
    expect(auth.kind).toBe('agent');

    // Only the agent key can use it, even the human who issued it cannot.
    await refused(
      use(w, alice, token, {
        scope: 'edit',
        tenant: TENANT,
        repo: 'app',
        paths: ['docs/guide.md'],
      }),
      'bad_proof'
    );
    // A delegated session can be an agent session only, and never wider.
    for (const kind of ['human', 'worker'] as const) {
      await refused(
        issue(w, alice, {
          tenant: TENANT,
          subject: helper.did,
          kind,
          grants: [{ repo: 'app', scopes: ['read'], paths: ['**'] }],
        }),
        'policy_denied'
      );
    }
    await refused(
      issue(w, alice, {
        tenant: TENANT,
        subject: helper.did,
        kind: 'agent',
        grants: [{ repo: 'app', scopes: ['integrate'], paths: ['**'] }],
      }),
      'policy_denied'
    );
  });

  test('a member cannot claim another kind for itself', async () => {
    const { w, agent } = await acme();
    await refused(
      issue(w, agent, {
        tenant: TENANT,
        kind: 'human',
        grants: [{ repo: 'app', scopes: ['read'], paths: ['src/**'] }],
      }),
      'policy_denied'
    );
  });

  test('strangers, forged requests, forged tokens and other services are refused', async () => {
    const { w, agent } = await acme();
    const stranger = Identity.create();
    await refused(
      issue(w, stranger, {
        tenant: TENANT,
        kind: 'agent',
        grants: [{ repo: 'app', scopes: ['read'], paths: ['src/**'] }],
      }),
      'not_a_member'
    );

    // A request naming the agent as principal but signed by the stranger.
    const request = {
      service: w.authority.did,
      tenant: TENANT,
      principal: agent.did,
      subject: stranger.did,
      kind: 'agent' as const,
      grants: [{ repo: 'app', scopes: ['read' as const], paths: ['src/**'] }],
    };
    await refused(
      w.authority.issue(
        request,
        proveIssue(stranger, request, { now: w.clock.now() })
      ),
      'bad_proof'
    );

    const token = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [{ repo: 'app', scopes: ['read'], paths: ['src/**'] }],
    });
    // Widen the grant inside the token without the service's signature.
    const [prefix, body, sig] = token.split('.');
    const claims = JSON.parse(Buffer.from(body ?? '', 'base64url').toString());
    claims.grants[0].paths = ['**'];
    const forged = `${prefix}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
    await refused(
      use(w, agent, forged, {
        scope: 'read',
        tenant: TENANT,
        repo: 'app',
        paths: ['secrets'],
      }),
      'bad_credential'
    );

    // Another service over the same state does not honor this one's tokens.
    const other = await Authority.open({
      backend: w.backend,
      signer: Identity.create(),
      now: w.clock.now,
    });
    await refused(
      other.authorize(
        token,
        { scope: 'read', tenant: TENANT, repo: 'app', paths: ['src/a.ts'] },
        { timestamp: w.clock.now(), nonce: 'n', signature: 'AA' }
      ),
      'bad_credential'
    );
  });

  test('issuance and refusals are audited', async () => {
    const { w, agent } = await acme();
    await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: [{ repo: 'app', scopes: ['read'], paths: ['src/**'] }],
    });
    await refused(
      issue(w, agent, {
        tenant: TENANT,
        kind: 'agent',
        grants: [{ repo: 'app', scopes: ['integrate'], paths: ['src/**'] }],
      }),
      'policy_denied'
    );
    const log = await w.authority.audit(TENANT);
    const issues = log.filter((r) => r.event === 'credential.issue');
    expect(issues.map((r) => [r.outcome, r.subject, r.code])).toEqual([
      ['allow', agent.did, undefined],
      ['deny', agent.did, 'policy_denied'],
    ]);
    expect(issues[0]?.credential).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('what the authority hands out', () => {
  test('policies and lifetime ceilings cannot be edited in place', async () => {
    const { w, agent } = await acme();
    const current = w.authority.policy(TENANT);
    const grant = current.members.find((m) => m.subject === agent.did)
      ?.grants[0];
    if (grant === undefined) throw new Error('expected the agent grant');
    expect(() => {
      (grant.paths as string[]).push('**');
    }).toThrow(TypeError);
    expect(() => {
      (current.admins as string[]).push(agent.did);
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_TTL.agent as { maxMs: number }).maxMs = 1000 * HOUR;
    }).toThrow(TypeError);
    // The authority still decides with the policy it stored.
    await refused(
      issue(w, agent, {
        tenant: TENANT,
        kind: 'agent',
        grants: [{ repo: 'app', scopes: ['read'], paths: ['**'] }],
      }),
      'policy_denied'
    );
  });
});
