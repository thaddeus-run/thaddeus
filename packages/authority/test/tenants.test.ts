import { describe, expect, test } from 'bun:test';

import {
  bytes,
  Identity,
  issue,
  member,
  policy,
  refused,
  revoke,
  text,
  use,
  world,
} from './helpers';

// Two tenants that both have a repository called `app`, and one identity that
// is a member of both.
async function twoTenants() {
  const w = await world();
  const adminA = Identity.create();
  const adminB = Identity.create();
  const shared = Identity.create();
  const grant = [
    { repo: 'app', scopes: ['read', 'edit'] as const, paths: ['**'] },
  ];
  await w.authority.createTenant(
    'tenant-a',
    policy([adminA], [member(shared, 'agent', [...grant])])
  );
  await w.authority.createTenant(
    'tenant-b',
    policy([adminB], [member(shared, 'agent', [...grant])])
  );
  const tokenA = await issue(w, shared, {
    tenant: 'tenant-a',
    kind: 'agent',
    grants: [...grant],
  });
  const tokenB = await issue(w, shared, {
    tenant: 'tenant-b',
    kind: 'agent',
    grants: [...grant],
  });
  return { w, adminA, adminB, shared, tokenA, tokenB };
}

describe('tenant isolation', () => {
  test('a credential never authorizes an action in another tenant', async () => {
    const { w, shared, tokenA } = await twoTenants();
    await refused(
      use(w, shared, tokenA, {
        scope: 'read',
        tenant: 'tenant-b',
        repo: 'app',
        paths: ['src/a.ts'],
      }),
      'wrong_tenant'
    );
  });

  test('same-named repositories keep separate content keys', async () => {
    const { w, shared, tokenA, tokenB } = await twoTenants();
    const editA = await use(w, shared, tokenA, {
      scope: 'edit',
      tenant: 'tenant-a',
      repo: 'app',
      paths: ['src/a.ts'],
    });
    const sealed = await w.custody.seal(
      editA,
      'src/a.ts',
      bytes('tenant a code')
    );

    const readA = await use(w, shared, tokenA, {
      scope: 'read',
      tenant: 'tenant-a',
      repo: 'app',
      paths: ['src/a.ts'],
    });
    expect(text(await w.custody.open(readA, 'src/a.ts', sealed))).toBe(
      'tenant a code'
    );

    // Tenant B's read of the same repository name and path cannot open it.
    const readB = await use(w, shared, tokenB, {
      scope: 'read',
      tenant: 'tenant-b',
      repo: 'app',
      paths: ['src/a.ts'],
    });
    await refused(w.custody.open(readB, 'src/a.ts', sealed), 'decrypt_failed');
  });

  test('revocation and policy in one tenant leave the other alone', async () => {
    const { w, adminA, shared, tokenA, tokenB } = await twoTenants();
    await revoke(w, 'tenant-a', adminA, { did: shared.did });
    const action = (tenant: string) => ({
      scope: 'read' as const,
      tenant,
      repo: 'app',
      paths: ['src/a.ts'],
    });
    await refused(use(w, shared, tokenA, action('tenant-a')), 'revoked');
    await use(w, shared, tokenB, action('tenant-b'));

    // Tenant A's admin is a stranger in tenant B, refused without writing to
    // B's audit.
    const before = (await w.authority.audit('tenant-b')).length;
    await refused(
      revoke(w, 'tenant-b', adminA, { did: shared.did }),
      'not_a_member'
    );
    expect(await w.authority.audit('tenant-b')).toHaveLength(before);
    // Nor revoke a tenant B credential by naming tenant A.
    await refused(
      revoke(w, 'tenant-a', adminA, { credential: tokenB }),
      'wrong_tenant'
    );
    await use(w, shared, tokenB, action('tenant-b'));
  });

  test('each tenant has its own audit log', async () => {
    const { w } = await twoTenants();
    const a = await w.authority.audit('tenant-a');
    const b = await w.authority.audit('tenant-b');
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((r) => r.tenant === 'tenant-a')).toBe(true);
    expect(b.every((r) => r.tenant === 'tenant-b')).toBe(true);
  });

  test('a tenant name can be created once', async () => {
    const { w, adminA } = await twoTenants();
    await refused(
      w.authority.createTenant('tenant-a', policy([adminA], [])),
      'tenant_exists'
    );
    await refused(
      () => w.authority.createTenant('Tenant A', policy([adminA], [])),
      'malformed'
    );
  });
});
