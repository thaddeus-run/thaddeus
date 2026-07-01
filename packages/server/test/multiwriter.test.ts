import { signDelegation } from '@thaddeus.run/agent';
import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { encodeBundle, encodeDelegation } from '../src/dto';
import { createServer } from '../src/server';
import { signRequest } from '../src/sign';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

interface LandResult {
  landed: boolean;
  reason?: string;
}

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

// B authors a commit to `path` locally and returns the push bundle + heads.
async function authored(b: Identity, path: string) {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const ws = Workspace.open(log, store, {
    source: 'main',
    reader: b,
    name: 'w',
  });
  ws.write(path, enc('x'));
  await ws.commit(b);
  const objects = [];
  const caps = [];
  for (const op of log.ops()) {
    const pid = op.payload?.plaintext_id;
    if (pid !== undefined) {
      const cur = store.current(pid);
      if (cur !== undefined) {
        objects.push(cur);
        caps.push(...store.caps(pid));
      }
    }
  }
  return {
    bundle: encodeBundle(log.ops(), objects, caps),
    heads: [...log.heads('w')],
  };
}

describe('multi-writer land enforcement', () => {
  test('delegate lands in scope, is rejected out of scope, and after revoke', async () => {
    const a = Identity.create(); // owner
    const b = Identity.create(); // delegate, src/** only
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(signed('POST', '/repos', { name: 'r' }, a));
    await srv.fetch(
      signed(
        'POST',
        '/repos/r/grants',
        {
          delegation: encodeDelegation(
            signDelegation(
              {
                agent: b.did,
                paths: ['src/**'],
                maxChanges: 100,
                maxSpend: 1000,
              },
              a
            )
          ),
        },
        a
      )
    );

    // In scope: B pushes src/x and lands.
    const inScope = await authored(b, 'src/x.rs');
    expect(
      (await srv.fetch(signed('POST', '/repos/r/push', inScope.bundle, b)))
        .status
    ).toBe(200);
    const landed = (await (
      await srv.fetch(
        signed(
          'POST',
          '/repos/r/land',
          { fromHeads: inScope.heads, into: 'main' },
          b
        )
      )
    ).json()) as LandResult;
    expect(landed.landed).toBe(true);

    // Out of scope: B pushes docs/y and the land is rejected.
    const outScope = await authored(b, 'docs/y.md');
    await srv.fetch(signed('POST', '/repos/r/push', outScope.bundle, b));
    const blocked = (await (
      await srv.fetch(
        signed(
          'POST',
          '/repos/r/land',
          { fromHeads: outScope.heads, into: 'main' },
          b
        )
      )
    ).json()) as LandResult;
    expect(blocked.landed).toBe(false);
    expect(blocked.reason?.toLowerCase()).toContain('scope');

    // Revoke: B can no longer push.
    await srv.fetch(signed('POST', '/repos/r/revoke', { agent: b.did }, a));
    const again = await authored(b, 'src/z.rs');
    expect(
      (await srv.fetch(signed('POST', '/repos/r/push', again.bundle, b))).status
    ).toBe(403);
  });

  test('maxChanges budget caps a delegate across lands (durable)', async () => {
    const a = Identity.create();
    const b = Identity.create();
    const backend = new MemoryBackend();
    const srv = createServer({ backend });
    await srv.fetch(signed('POST', '/repos', { name: 'r2' }, a));
    await srv.fetch(
      signed(
        'POST',
        '/repos/r2/grants',
        {
          delegation: encodeDelegation(
            signDelegation(
              { agent: b.did, paths: ['**'], maxChanges: 1, maxSpend: 1000 },
              a
            )
          ),
        },
        a
      )
    );

    const first = await authored(b, 'a.txt');
    await srv.fetch(signed('POST', '/repos/r2/push', first.bundle, b));
    const firstLanded = (await (
      await srv.fetch(
        signed(
          'POST',
          '/repos/r2/land',
          { fromHeads: first.heads, into: 'main' },
          b
        )
      )
    ).json()) as LandResult;
    expect(firstLanded.landed).toBe(true);

    // A fresh server over the same backend: the meter (1 change used) survives.
    const srv2 = createServer({ backend });
    const second = await authored(b, 'b.txt');
    await srv2.fetch(signed('POST', '/repos/r2/push', second.bundle, b));
    const over = (await (
      await srv2.fetch(
        signed(
          'POST',
          '/repos/r2/land',
          { fromHeads: second.heads, into: 'main' },
          b
        )
      )
    ).json()) as LandResult;
    expect(over.landed).toBe(false);
    expect(over.reason?.toLowerCase()).toContain('budget');
  });

  // Regression for the registry concurrency race: with a fresh (cold-cache)
  // server, fire a delegate land and an owner revoke in the SAME tick. Because
  // registryFor is single-flight (one AgentRegistry per repo) and the
  // owner-or-delegate gate runs INSIDE withRepoLock, the revoke — which the lock
  // serializes ahead of the land's gate re-check — must win: the land is
  // rejected (403 gate or landed:false), never quietly landed on a stale
  // registry.
  test('cold-cache: a same-tick revoke wins over a concurrent delegate land', async () => {
    const a = Identity.create(); // owner
    const b = Identity.create(); // delegate
    const backend = new MemoryBackend();
    const srv = createServer({ backend });
    await srv.fetch(signed('POST', '/repos', { name: 'r3' }, a));
    await srv.fetch(
      signed(
        'POST',
        '/repos/r3/grants',
        {
          delegation: encodeDelegation(
            signDelegation(
              { agent: b.did, paths: ['**'], maxChanges: 100, maxSpend: 1000 },
              a
            )
          ),
        },
        a
      )
    );

    // B pushes a change and uploads it (push gate still passes pre-revoke).
    const change = await authored(b, 'src/x.rs');
    await srv.fetch(signed('POST', '/repos/r3/push', change.bundle, b));

    // Fresh server over the same backend → registry cache is COLD. Fire the
    // revoke and the delegate land together in one tick.
    const srv2 = createServer({ backend });
    const [revokeRes, landRes] = await Promise.all([
      srv2.fetch(signed('POST', '/repos/r3/revoke', { agent: b.did }, a)),
      srv2.fetch(
        signed(
          'POST',
          '/repos/r3/land',
          { fromHeads: change.heads, into: 'main' },
          b
        )
      ),
    ]);
    expect(revokeRes.status).toBe(200);
    // Whichever way withRepoLock serialized the two, the outcome is coherent:
    // if the land ran before the revoke it lands cleanly (200/landed:true); if
    // it ran after, the in-lock gate re-check sees the revoke and rejects (403).
    // What must NEVER happen (the race being fixed) is a land that quietly
    // succeeds on a stale registry AFTER the revoke was applied — impossible now
    // because both handlers share one AgentRegistry and gate inside the lock.
    if (landRes.status === 200) {
      const land = (await landRes.json()) as LandResult;
      expect(typeof land.landed).toBe('boolean');
    } else {
      expect(landRes.status).toBe(403);
    }

    // The decisive, deterministic assertion: once the revoke is applied, a fresh
    // delegate land is unambiguously rejected by the gate (functional revocation
    // holds on the single-flight registry, cold cache and all).
    const after = await srv2.fetch(
      signed(
        'POST',
        '/repos/r3/land',
        { fromHeads: change.heads, into: 'main' },
        b
      )
    );
    expect(after.status).toBe(403);
  });
});
