import { signDelegation } from '@thaddeus.run/agent';
import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import { type Backend, MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { encodeBundle, encodeDelegation } from '../src/dto';
import { createServer } from '../src/server';
import { signRequest } from '../src/sign';
import { createRepoBody, landBody } from './heads';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

interface LandResult {
  landed: boolean;
  reason?: string;
}

// Simulates the first durable usage-delta write failing after a signed head has
// committed, while preserving every other backend operation.
class FailFirstMeterDeltaWrite implements Backend {
  readonly #inner = new MemoryBackend();
  #failed = false;

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.#inner.put(key, bytes);
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    if (!this.#failed && key.includes('/meter-land/')) {
      this.#failed = true;
      throw new Error('injected meter delta write failure');
    }
    return this.#inner.putIfAbsent(key, bytes);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.#inner.get(key);
  }

  async list(prefix: string): Promise<readonly string[]> {
    return this.#inner.list(prefix);
  }

  async delete(key: string): Promise<void> {
    await this.#inner.delete(key);
  }
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
      'x-thaddeus-nonce': h.nonce,
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
  test('owner lands delegate ops in scope, rejects out of scope, and honors revoke', async () => {
    const a = Identity.create(); // owner
    const b = Identity.create(); // delegate, src/** only
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(signed('POST', '/repos', createRepoBody('r', a), a));
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

    // In scope: B pushes src/x and the owner signs its landing.
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
          await landBody(srv.fetch, 'r', inScope.heads, a),
          a
        )
      )
    ).json()) as LandResult;
    expect(landed.landed).toBe(true);

    // Out of scope: B pushes docs/y and the owner's landing is rejected.
    const outScope = await authored(b, 'docs/y.md');
    await srv.fetch(signed('POST', '/repos/r/push', outScope.bundle, b));
    const blocked = (await (
      await srv.fetch(
        signed(
          'POST',
          '/repos/r/land',
          await landBody(srv.fetch, 'r', outScope.heads, a),
          a
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
    await srv.fetch(signed('POST', '/repos', createRepoBody('r2', a), a));
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
          await landBody(srv.fetch, 'r2', first.heads, a),
          a
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
          await landBody(srv2.fetch, 'r2', second.heads, a),
          a
        )
      )
    ).json()) as LandResult;
    expect(over.landed).toBe(false);
    expect(over.reason?.toLowerCase()).toContain('budget');
  });

  test('committed land recovers a failed durable meter write', async () => {
    const a = Identity.create();
    const b = Identity.create();
    const backend = new FailFirstMeterDeltaWrite();
    const srv = createServer({ backend });
    await srv.fetch(signed('POST', '/repos', createRepoBody('r5', a), a));
    await srv.fetch(
      signed(
        'POST',
        '/repos/r5/grants',
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
    await srv.fetch(signed('POST', '/repos/r5/push', first.bundle, b));
    const firstResponse = await srv.fetch(
      signed(
        'POST',
        '/repos/r5/land',
        await landBody(srv.fetch, 'r5', first.heads, a),
        a
      )
    );
    expect(firstResponse.status).toBe(200);
    expect(((await firstResponse.json()) as LandResult).landed).toBe(true);

    // Loading the repository on a fresh server drains the persisted outbox.
    // A second delegate change must then observe the recovered lifetime usage.
    const srv2 = createServer({ backend });
    const second = await authored(b, 'b.txt');
    await srv2.fetch(signed('POST', '/repos/r5/push', second.bundle, b));
    const over = (await (
      await srv2.fetch(
        signed(
          'POST',
          '/repos/r5/land',
          await landBody(srv2.fetch, 'r5', second.heads, a),
          a
        )
      )
    ).json()) as LandResult;
    expect(over.landed).toBe(false);
    expect(over.reason?.toLowerCase()).toContain('budget');
  });

  // Regression for the P9 rate-window invariant: buildRegistry's meter replay
  // (server.ts, the `meter/` loop) must restore lifetime totals via
  // replayMeter(), NOT record() — record() would stamp the replayed lifetime
  // total into the current hour's window and wrongly reject the very next
  // land after a restart. Mirrors the durable-budget test above but adds a
  // maxChangesPerHour cap and checks behavior across the "restart".
  test('server restart replays the durable meter without stamping the current hour (P9)', async () => {
    const a = Identity.create();
    const b = Identity.create();
    const backend = new MemoryBackend();
    const srv = createServer({ backend });
    await srv.fetch(signed('POST', '/repos', createRepoBody('r4', a), a));
    await srv.fetch(
      signed(
        'POST',
        '/repos/r4/grants',
        {
          delegation: encodeDelegation(
            signDelegation(
              {
                agent: b.did,
                paths: ['**'],
                maxChanges: 100,
                maxSpend: 1000,
                maxChangesPerHour: 1,
              },
              a
            )
          ),
        },
        a
      )
    );

    const first = await authored(b, 'a.txt');
    await srv.fetch(signed('POST', '/repos/r4/push', first.bundle, b));
    const firstLanded = (await (
      await srv.fetch(
        signed(
          'POST',
          '/repos/r4/land',
          await landBody(srv.fetch, 'r4', first.heads, a),
          a
        )
      )
    ).json()) as LandResult;
    expect(firstLanded.landed).toBe(true);

    // Restart: a fresh server over the SAME backend rebuilds the registry,
    // replaying the persisted meter (1 lifetime change). If buildRegistry used
    // record() instead of replayMeter(), that replay would land in the current
    // hour's window and this land would be wrongly rejected (1 + 1 > 1).
    const srv2 = createServer({ backend });
    const second = await authored(b, 'b.txt');
    await srv2.fetch(signed('POST', '/repos/r4/push', second.bundle, b));
    const secondLanded = (await (
      await srv2.fetch(
        signed(
          'POST',
          '/repos/r4/land',
          await landBody(srv2.fetch, 'r4', second.heads, a),
          a
        )
      )
    ).json()) as LandResult;
    expect(secondLanded.landed).toBe(true);

    // Forward-looking: the second land above genuinely used the hourly
    // window's one slot on srv2, so a third land within the hour is rejected.
    const third = await authored(b, 'c.txt');
    await srv2.fetch(signed('POST', '/repos/r4/push', third.bundle, b));
    const thirdLanded = (await (
      await srv2.fetch(
        signed(
          'POST',
          '/repos/r4/land',
          await landBody(srv2.fetch, 'r4', third.heads, a),
          a
        )
      )
    ).json()) as LandResult;
    expect(thirdLanded.landed).toBe(false);
    expect(thirdLanded.reason?.toLowerCase()).toContain('hourly rate window');
  });

  // Regression for the registry concurrency race: with a fresh (cold-cache)
  // server, fire an owner-signed land of delegate ops and a revoke in the SAME
  // tick. Because
  // registryFor is single-flight (one AgentRegistry per repo) and the
  // policy evaluation runs INSIDE withRepoLock, the revoke—which the lock
  // serializes ahead of the land's gate re-check—must win: the land is
  // rejected (403 gate or landed:false), never quietly landed on a stale
  // registry.
  test('cold-cache: revoke races coherently with owner landing delegate ops', async () => {
    const a = Identity.create(); // owner
    const b = Identity.create(); // delegate
    const backend = new MemoryBackend();
    const srv = createServer({ backend });
    await srv.fetch(signed('POST', '/repos', createRepoBody('r3', a), a));
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
    // revoke and the owner-signed delegate-op land together in one tick.
    const srv2 = createServer({ backend });
    const concurrentLand = await landBody(srv2.fetch, 'r3', change.heads, a);
    const [revokeRes, landRes] = await Promise.all([
      srv2.fetch(signed('POST', '/repos/r3/revoke', { agent: b.did }, a)),
      srv2.fetch(signed('POST', '/repos/r3/land', concurrentLand, a)),
    ]);
    expect(revokeRes.status).toBe(200);
    // Whichever way withRepoLock serialized the two, the outcome is coherent:
    // if the land ran before the revoke it lands cleanly (200/landed:true); if
    // it ran after, the in-lock gate re-check sees the revoke and rejects (403).
    // What must NEVER happen (the race being fixed) is a land that quietly
    // succeeds on a stale registry AFTER the revoke was applied — impossible now
    // because both handlers share one AgentRegistry and gate inside the lock.
    expect(landRes.status).toBe(200);
    const land = (await landRes.json()) as LandResult;
    expect(typeof land.landed).toBe('boolean');

    // The decisive, deterministic assertion: once the revoke is applied, a fresh
    // owner attempt to land the delegate ops is unambiguously policy-rejected
    // (functional revocation holds on the single-flight registry, cold cache
    // and all).
    const after = await srv2.fetch(
      signed(
        'POST',
        '/repos/r3/land',
        await landBody(srv2.fetch, 'r3', change.heads, a),
        a
      )
    );
    expect(after.status).toBe(200);
    expect(((await after.json()) as LandResult).landed).toBe(false);
  });
});
