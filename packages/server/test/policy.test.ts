import { signDelegation } from '@thaddeus.run/agent';
import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import { type Provenance, ProvenanceLog } from '@thaddeus.run/provenance';
import {
  type Capability,
  type EncryptedObject,
  MemoryStore,
  scoped,
} from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  encodeBundle,
  encodeDelegation,
  type RepoPolicyRecord,
} from '../src/index';
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
      'content-type': 'application/json',
      'x-thaddeus-did': h.did,
      'x-thaddeus-timestamp': h.timestamp,
      'x-thaddeus-nonce': h.nonce,
      'x-thaddeus-signature': h.signature,
    },
  });
}

function defaultPolicy(): RepoPolicyRecord {
  return {
    version: 1,
    restrictPaths: [],
    standingQueries: [],
    requireVerifiedProvenance: false,
    requirePassingChecks: null,
    release: { creators: 'owner', allow: [] },
  };
}

async function authored(
  author: Identity,
  path: string,
  opts: {
    text?: string;
    delete?: boolean;
    provenanceKind?: string;
    provenanceActor?: Identity;
  } = {}
): Promise<{
  bundle: ReturnType<typeof encodeBundle>;
  heads: string[];
}> {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const ws = Workspace.open(log, store, {
    source: 'main',
    reader: author,
    name: 'w',
  });
  if (opts.delete === true) {
    ws.rm(path);
  } else {
    ws.write(path, enc(opts.text ?? 'x'));
  }
  const ops = await ws.commit(author);
  const prov: Provenance[] = [];
  if (opts.provenanceKind !== undefined) {
    const provLog = new ProvenanceLog(store);
    const actor = opts.provenanceActor ?? author;
    for (const op of ops) {
      prov.push(
        await provLog.record(
          op,
          {
            intent: `${opts.provenanceKind} passed`,
            reasoning: 'policy test',
            actorKind: opts.provenanceKind,
          },
          actor
        )
      );
    }
  }
  const objects: EncryptedObject[] = [];
  const caps: Capability[] = [];
  for (const op of log.ops()) {
    const pid = op.payload?.plaintext_id;
    if (pid === undefined) {
      continue;
    }
    const cur = store.current(pid);
    if (cur !== undefined) {
      objects.push(cur);
      caps.push(...store.caps(pid));
    }
  }
  return {
    bundle: encodeBundle(log.ops(), objects, caps, prov),
    heads: [...log.heads('w')],
  };
}

async function createRepo(
  srv: ReturnType<typeof createServer>,
  repo: string,
  owner: Identity
): Promise<void> {
  const res = await srv.fetch(
    signed('POST', '/repos', createRepoBody(repo, owner), owner)
  );
  expect(res.status).toBe(201);
}

async function setPolicy(
  srv: ReturnType<typeof createServer>,
  repo: string,
  policy: RepoPolicyRecord,
  owner: Identity
): Promise<void> {
  const res = await srv.fetch(
    signed('POST', `/repos/${repo}/policy`, { policy }, owner)
  );
  expect(res.status).toBe(200);
}

async function pushAndLand(
  srv: ReturnType<typeof createServer>,
  repo: string,
  change: Awaited<ReturnType<typeof authored>>,
  signer: Identity,
  owner: Identity = signer
): Promise<LandResult> {
  const pushed = await srv.fetch(
    signed('POST', `/repos/${repo}/push`, change.bundle, signer)
  );
  expect(pushed.status).toBe(200);
  const landed = await srv.fetch(
    signed(
      'POST',
      `/repos/${repo}/land`,
      await landBody(srv.fetch, repo, change.heads, owner),
      owner
    )
  );
  expect(landed.status).toBe(200);
  return (await landed.json()) as LandResult;
}

describe('repo policy', () => {
  test('policy is owner-selectable over the wire and durable', async () => {
    const owner = Identity.create();
    const other = Identity.create();
    const backend = new MemoryBackend();
    const srv = createServer({ backend });
    await createRepo(srv, 'r', owner);

    const initial = (await (
      await srv.fetch(new Request('http://t/repos/r/policy'))
    ).json()) as { policy: RepoPolicyRecord };
    expect(initial.policy).toEqual(defaultPolicy());

    const policy: RepoPolicyRecord = {
      ...defaultPolicy(),
      requireVerifiedProvenance: true,
    };
    const denied = await srv.fetch(
      signed('POST', '/repos/r/policy', { policy }, other)
    );
    expect(denied.status).toBe(403);

    await setPolicy(srv, 'r', policy, owner);
    const srv2 = createServer({ backend });
    const reloaded = (await (
      await srv2.fetch(new Request('http://t/repos/r/policy'))
    ).json()) as { policy: RepoPolicyRecord };
    expect(reloaded.policy.requireVerifiedProvenance).toBe(true);
  });

  test('policy rejects unsupported wildcard path globs', async () => {
    const owner = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await createRepo(srv, 'r', owner);

    for (const policy of [
      {
        ...defaultPolicy(),
        standingQueries: [
          {
            kind: 'forbidPaths' as const,
            paths: ['*.env'],
            name: 'no env files',
          },
        ],
      },
      {
        ...defaultPolicy(),
        restrictPaths: [
          {
            protect: ['src/*.ts'],
            allow: [owner.did],
            name: 'no wildcard auth edits',
          },
        ],
      },
    ]) {
      const res = await srv.fetch(
        signed('POST', '/repos/r/policy', { policy }, owner)
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('supports only exact paths');
    }
  });

  test('policy rejects empty restrictPaths allow lists', async () => {
    const owner = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await createRepo(srv, 'r', owner);

    const res = await srv.fetch(
      signed(
        'POST',
        '/repos/r/policy',
        {
          policy: {
            ...defaultPolicy(),
            restrictPaths: [
              {
                protect: ['src/**'],
                allow: [],
                name: 'no lockout',
              },
            ],
          },
        },
        owner
      )
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('restrictPaths.allow must not be empty');
  });

  test('corrupt stored policy fails closed for reads and land', async () => {
    const owner = Identity.create();
    const backend = new MemoryBackend();
    const srv = createServer({ backend });
    await createRepo(srv, 'r', owner);
    await scoped(backend, 'repo/r/').put('meta/policy', enc('not json'));

    const read = await srv.fetch(new Request('http://t/repos/r/policy'));
    expect(read.status).toBe(500);
    expect(await read.text()).toContain('stored repo policy is invalid');

    const change = await authored(owner, 'ok.txt');
    const pushed = await srv.fetch(
      signed('POST', '/repos/r/push', change.bundle, owner)
    );
    expect(pushed.status).toBe(200);
    const landed = await srv.fetch(
      signed(
        'POST',
        '/repos/r/land',
        await landBody(srv.fetch, 'r', change.heads, owner),
        owner
      )
    );
    expect(landed.status).toBe(500);
    expect(await landed.text()).toContain('stored repo policy is invalid');
  });

  test('restrictPaths blocks untrusted protected edits without restart', async () => {
    const owner = Identity.create();
    const delegate = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await createRepo(srv, 'r', owner);
    await srv.fetch(
      signed(
        'POST',
        '/repos/r/grants',
        {
          delegation: encodeDelegation(
            signDelegation(
              {
                agent: delegate.did,
                paths: ['**'],
                maxChanges: 100,
                maxSpend: 100,
              },
              owner
            )
          ),
        },
        owner
      )
    );
    await setPolicy(
      srv,
      'r',
      {
        ...defaultPolicy(),
        restrictPaths: [
          {
            protect: ['src/auth/**'],
            allow: [owner.did],
            name: 'no untrusted auth edits',
          },
        ],
      },
      owner
    );

    const blocked = await pushAndLand(
      srv,
      'r',
      await authored(delegate, 'src/auth/login.rs'),
      delegate,
      owner
    );
    expect(blocked.landed).toBe(false);
    expect(blocked.reason).toContain('no untrusted auth edits');

    const allowed = await pushAndLand(
      srv,
      'r',
      await authored(delegate, 'docs/readme.md'),
      delegate,
      owner
    );
    expect(allowed.landed).toBe(true);
  });

  test('verified provenance and checker gates are policy-controlled', async () => {
    const owner = Identity.create();
    const ci = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await createRepo(srv, 'r', owner);
    await setPolicy(
      srv,
      'r',
      { ...defaultPolicy(), requireVerifiedProvenance: true },
      owner
    );

    const noWhy = await pushAndLand(
      srv,
      'r',
      await authored(owner, 'a.txt'),
      owner
    );
    expect(noWhy.landed).toBe(false);
    expect(noWhy.reason).toContain('verified provenance');

    const withWhy = await pushAndLand(
      srv,
      'r',
      await authored(owner, 'b.txt', { provenanceKind: 'human' }),
      owner
    );
    expect(withWhy.landed).toBe(true);

    await setPolicy(
      srv,
      'r',
      {
        ...defaultPolicy(),
        requirePassingChecks: { checkerKinds: ['ci'] },
      },
      owner
    );
    const humanWhy = await pushAndLand(
      srv,
      'r',
      await authored(owner, 'c.txt', { provenanceKind: 'human' }),
      owner
    );
    expect(humanWhy.landed).toBe(false);
    expect(humanWhy.reason).toContain('verified check from ci');

    const checked = await pushAndLand(
      srv,
      'r',
      await authored(owner, 'd.txt', {
        provenanceKind: 'ci',
        provenanceActor: ci,
      }),
      owner
    );
    expect(checked.landed).toBe(true);
  });

  test('typed standing queries can forbid deletes and path globs', async () => {
    const owner = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await createRepo(srv, 'r', owner);
    await setPolicy(
      srv,
      'r',
      {
        ...defaultPolicy(),
        standingQueries: [
          { kind: 'forbidDeletes', name: 'no deletes' },
          {
            kind: 'forbidPaths',
            paths: ['secrets/**'],
            name: 'no secrets',
          },
        ],
      },
      owner
    );

    const deleted = await pushAndLand(
      srv,
      'r',
      await authored(owner, 'old.txt', { delete: true }),
      owner
    );
    expect(deleted.landed).toBe(false);
    expect(deleted.reason).toContain('no deletes');

    const secret = await pushAndLand(
      srv,
      'r',
      await authored(owner, 'secrets/token.txt'),
      owner
    );
    expect(secret.landed).toBe(false);
    expect(secret.reason).toContain('no secrets');
  });
});
