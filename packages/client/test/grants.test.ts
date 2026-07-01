import { signDelegation } from '@thaddeus.run/agent';
import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '../src/client';

beforeAll(async () => {
  await ready();
});

describe('Client grant/revoke/listGrants', () => {
  test('owner grants, lists, and revokes a delegate', async () => {
    const a = Identity.create();
    const b = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const c = new Client('http://t', a, srv.fetch.bind(srv));
    await c.createRepo('r');

    const d = signDelegation(
      { agent: b.did, paths: ['src/**'], maxChanges: 10, maxSpend: 100 },
      a
    );
    const g = await c.grant('r', d);
    expect(g.agent).toBe(b.did);
    expect(g.paths).toEqual(['src/**']);

    const grants = await c.listGrants('r');
    expect(grants).toHaveLength(1);
    expect(grants[0]?.agent).toBe(b.did);

    const r = await c.revoke('r', b.did);
    expect(r.revoked).toBe(true);
    expect(await c.listGrants('r')).toHaveLength(0);
  });
});
