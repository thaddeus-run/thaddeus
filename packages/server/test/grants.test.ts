import { signDelegation } from '@thaddeus.run/agent';
import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { beforeAll, describe, expect, test } from 'bun:test';

import { decodeDelegation, encodeDelegation } from '../src/dto';
import { createServer } from '../src/server';
import { signRequest } from '../src/sign';

beforeAll(async () => {
  await ready();
});

function signed(
  method: string,
  path: string,
  bodyObj: unknown,
  signer: Identity
): Request {
  const body = new TextEncoder().encode(JSON.stringify(bodyObj));
  const h = signRequest(method, path, body, signer, new Date().toISOString());
  return new Request(`http://t${path}`, {
    method,
    body,
    headers: {
      'x-thaddeus-did': h.did,
      'x-thaddeus-timestamp': h.timestamp,
      'x-thaddeus-signature': h.signature,
    },
  });
}

describe('grants', () => {
  test('owner grants + lists; non-owner and wrong-operator are rejected; durable', async () => {
    const a = Identity.create(); // owner
    const b = Identity.create(); // grantee
    const backend = new MemoryBackend();
    const srv = createServer({ backend });
    await srv.fetch(signed('POST', '/repos', { name: 'r' }, a));

    const deleg = signDelegation(
      { agent: b.did, paths: ['src/**'], maxChanges: 100, maxSpend: 1000 },
      a
    );

    // Non-owner grant → 403.
    const stranger = Identity.create();
    const f1 = await srv.fetch(
      signed(
        'POST',
        '/repos/r/grants',
        { delegation: encodeDelegation(deleg) },
        stranger
      )
    );
    expect(f1.status).toBe(403);

    // Delegation whose operator ≠ owner → 403 (signed by owner request, but the deleg was issued by someone else).
    const foreign = signDelegation(
      { agent: b.did, paths: ['**'], maxChanges: 1, maxSpend: 1 },
      stranger
    );
    const f2 = await srv.fetch(
      signed(
        'POST',
        '/repos/r/grants',
        { delegation: encodeDelegation(foreign) },
        a
      )
    );
    expect(f2.status).toBe(403);

    // Owner grant → 200; GET /grants lists it.
    const ok = await srv.fetch(
      signed(
        'POST',
        '/repos/r/grants',
        { delegation: encodeDelegation(deleg) },
        a
      )
    );
    expect(ok.status).toBe(200);
    const list = (await (
      await srv.fetch(new Request('http://t/repos/r/grants'))
    ).json()) as { grants: string[] };
    expect(list.grants).toHaveLength(1);
    expect(decodeDelegation(list.grants[0]).agent).toBe(b.did);

    // Revoke → grants list drops it.
    await srv.fetch(signed('POST', '/repos/r/revoke', { agent: b.did }, a));
    const after = (await (
      await srv.fetch(new Request('http://t/repos/r/grants'))
    ).json()) as { grants: string[] };
    expect(after.grants).toHaveLength(0);

    // Durable: a fresh server over the same backend still has the (revoked) state.
    const srv2 = createServer({ backend });
    const reloaded = (await (
      await srv2.fetch(new Request('http://t/repos/r/grants'))
    ).json()) as { grants: string[] };
    expect(reloaded.grants).toHaveLength(0); // still revoked after reload
  });
});
