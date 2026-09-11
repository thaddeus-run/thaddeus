import { signDelegation } from '@thaddeus.run/agent';
import { Identity, ready } from '@thaddeus.run/identity';
import { FileBackend, MemoryBackend } from '@thaddeus.run/persist';
import {
  encodeRecord,
  type EncryptedObject,
  MemoryStore,
} from '@thaddeus.run/store';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeBundle, encodeDelegation } from '../src/dto';
import { DEFAULT_QUOTAS, type QuotaConfig } from '../src/quotas';
import { createServer, type Server } from '../src/server';
import { signRequest } from '../src/sign';
import { createRepoBody } from './heads';

beforeAll(ready);
const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-quotas-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const initial = Date.parse('2026-09-11T12:00:00Z');

/** Exercises production request authentication, routing, and backend writes. */
function request(
  method: string,
  path: string,
  signer: Identity,
  value?: unknown,
  time = initial
): Request {
  const body = new TextEncoder().encode(
    value === undefined ? '' : JSON.stringify(value)
  );
  const signed = signRequest(
    method,
    path,
    body,
    signer,
    new Date(time).toISOString()
  );
  return new Request(`http://quota.test${path}`, {
    method,
    ...(method === 'DELETE' ? {} : { body }),
    headers: {
      'content-type': 'application/json',
      'x-thaddeus-did': signed.did,
      'x-thaddeus-timestamp': signed.timestamp,
      'x-thaddeus-nonce': signed.nonce,
      'x-thaddeus-signature': signed.signature,
    },
  });
}
const create = (
  server: Server,
  owner: Identity,
  name: string,
  time = initial
): Promise<Response> =>
  server.fetch(
    request('POST', '/repos', owner, createRepoBody(name, owner), time)
  );

/** Makes real encrypted content with capabilities, independent of server state. */
async function object(
  owner: Identity,
  text: string
): Promise<{
  object: EncryptedObject;
  bundle: ReturnType<typeof encodeBundle>;
}> {
  const store = new MemoryStore();
  const ref = await store.put(new TextEncoder().encode(text), owner);
  const encrypted = store.current(ref.plaintext_id)!;
  return {
    object: encrypted,
    bundle: encodeBundle([], [encrypted], [...store.caps(ref.plaintext_id)]),
  };
}
const push = (
  server: Server,
  owner: Identity,
  name: string,
  bundle: ReturnType<typeof encodeBundle>,
  time = initial
): Promise<Response> =>
  server.fetch(
    request(
      'POST',
      `/repos/${encodeURIComponent(name)}/push`,
      owner,
      bundle,
      time
    )
  );

for (const kind of ['memory', 'file'] as const) {
  describe(`quota routes (${kind})`, () => {
    const backend = (): MemoryBackend | FileBackend =>
      kind === 'memory'
        ? new MemoryBackend()
        : new FileBackend(mkdtempSync(join(tmp, 'data-')));
    for (const alreadyWritten of [false, true]) {
      test(`cold reads recover legacy recalls with durable accounting (object written: ${alreadyWritten})`, async () => {
        const owner = Identity.create();
        const b = backend();
        const config = {
          backend: b,
          now: () => new Date(initial).toISOString(),
          quotas: { maxObjects: 1, objectCreationLimit: 1 },
        };
        expect(
          (await create(createServer(config), owner, 'recall')).status
        ).toBe(201);
        const store = new MemoryStore();
        const ref = await store.put(
          new TextEncoder().encode('recovered'),
          owner
        );
        const encrypted = store.current(ref.plaintext_id)!;
        const caps = [...store.caps(ref.plaintext_id)];
        if (alreadyWritten)
          await b.put(
            `repo/recall/obj/${encrypted.id}`,
            encodeRecord(encrypted)
          );
        await b.put(
          `repo/recall/recall/${ref.plaintext_id}`,
          encodeRecord({
            phase: 'prepared',
            recall: { object: encrypted, caps, pending: [] },
          })
        );
        for (const key of await b.list('quota/v1/')) await b.delete(key);
        for (let restart = 0; restart < 2; restart++) {
          const server = createServer(config);
          const response = await server.fetch(
            new Request('http://quota.test/repos/recall/views/main')
          );
          expect(response.status).toBe(200);
          expect(await b.get(`repo/recall/obj/${encrypted.id}`)).toBeDefined();
          expect(
            await b.get(`repo/recall/recall/${ref.plaintext_id}`)
          ).toBeUndefined();
          expect(
            (
              await push(
                server,
                owner,
                'recall',
                encodeBundle([], [encrypted], caps)
              )
            ).status
          ).toBe(200);
          const denied = await push(
            server,
            owner,
            'recall',
            (await object(owner, 'extra')).bundle
          );
          expect(denied.status).toBe(403);
          expect(await denied.json()).toMatchObject({
            code: 'object_quota_exceeded',
          });
        }
      });
    }
    test('repository boundary, concurrency, independent identity, restart and deletion', async () => {
      const owner = Identity.create();
      const other = Identity.create();
      const b = backend();
      const config = {
        backend: b,
        now: () => new Date(initial).toISOString(),
        quotas: { maxRepositories: 2 },
      };
      let server = createServer(config);
      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, i) => create(server, owner, `repo-${i}`))
      );
      expect(responses.filter((r) => r.status === 201)).toHaveLength(2);
      expect(responses.filter((r) => r.status === 403)).toHaveLength(6);
      expect(await responses.find((r) => r.status === 403)!.json()).toEqual({
        code: 'repository_quota_exceeded',
        error: 'repository_quota_exceeded',
      });
      expect((await create(server, other, 'independent')).status).toBe(201);
      server = createServer(config);
      expect((await create(server, owner, 'after-restart')).status).toBe(403);
      expect(
        (await server.fetch(request('DELETE', '/repos/repo-0', other))).status
      ).toBe(403);
      expect(
        (await server.fetch(request('DELETE', '/repos/repo-0', owner))).status
      ).toBe(200);
      expect((await create(server, owner, 'after-delete')).status).toBe(201);
      expect(await b.list('repo/repo-0/')).toEqual([]);
    });

    test('repository window persists; deletion does not refund creation; exact expiry resets', async () => {
      const owner = Identity.create();
      const b = backend();
      let time = initial;
      const config = {
        backend: b,
        now: () => new Date(time).toISOString(),
        quotas: { repositoryCreationLimit: 1, creationWindowMs: 1500 },
      };
      let server = createServer(config);
      expect((await create(server, owner, 'one', time)).status).toBe(201);
      expect(
        (
          await server.fetch(
            request('DELETE', '/repos/one', owner, undefined, time)
          )
        ).status
      ).toBe(200);
      server = createServer(config);
      time += 1499;
      const rejected = await create(server, owner, 'two', time);
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get('retry-after')).toBe('1');
      expect(await rejected.json()).toMatchObject({
        code: 'repository_creation_rate_limited',
      });
      time++;
      expect((await create(server, owner, 'two', time)).status).toBe(201);
    });

    test('object count and bytes aggregate across repositories; duplicate uploads are free', async () => {
      const owner = Identity.create();
      const b = backend();
      const first = await object(owner, 'first');
      const second = await object(owner, 'second');
      const config = {
        backend: b,
        now: () => new Date(initial).toISOString(),
        quotas: {
          maxObjects: 1,
          maxObjectBytes: encodeRecord(first.object).byteLength,
        },
      };
      let server = createServer(config);
      expect((await create(server, owner, 'a')).status).toBe(201);
      expect((await create(server, owner, 'b')).status).toBe(201);
      expect((await push(server, owner, 'a', first.bundle)).status).toBe(200);
      expect((await push(server, owner, 'a', first.bundle)).status).toBe(200);
      const rejected = await push(server, owner, 'b', second.bundle);
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({
        code: 'object_quota_exceeded',
      });
      expect(await b.list('repo/b/obj/')).toEqual([]);
      server = createServer(config);
      expect((await push(server, owner, 'b', second.bundle)).status).toBe(403);
      expect(
        (await server.fetch(request('DELETE', '/repos/a', owner))).status
      ).toBe(200);
      expect((await push(server, owner, 'b', first.bundle)).status).toBe(200);
    });

    test('one byte below the object size rejects before any upload write', async () => {
      const owner = Identity.create();
      const b = backend();
      const item = await object(owner, 'sized');
      const server = createServer({
        backend: b,
        now: () => new Date(initial).toISOString(),
        quotas: { maxObjectBytes: encodeRecord(item.object).byteLength - 1 },
      });
      await create(server, owner, 'sized');
      const before = await b.list('repo/sized/');
      const response = await push(server, owner, 'sized', item.bundle);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: 'object_bytes_quota_exceeded',
      });
      expect([...(await b.list('repo/sized/'))].sort()).toEqual(
        [...before].sort()
      );
    });

    test('concurrent objects cannot exceed the limit; object rate survives restart', async () => {
      const owner = Identity.create();
      const b = backend();
      let time = initial;
      const config = {
        backend: b,
        now: () => new Date(time).toISOString(),
        quotas: { objectCreationLimit: 1, creationWindowMs: 1000 },
      };
      let server = createServer(config);
      await create(server, owner, 'a');
      await create(server, owner, 'b');
      const a = await object(owner, 'a');
      const c = await object(owner, 'c');
      const results = await Promise.all([
        push(server, owner, 'a', a.bundle),
        push(server, owner, 'b', c.bundle),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 429]);
      expect(await results.find((r) => r.status === 429)!.json()).toMatchObject(
        { code: 'object_creation_rate_limited' }
      );
      server = createServer(config);
      expect((await push(server, owner, 'b', c.bundle)).status).toBe(429);
      time += 1000;
      expect((await push(server, owner, 'b', c.bundle, time)).status).toBe(200);
    });

    test('a rejected bundle rolls back its earlier objects and hot cache', async () => {
      const owner = Identity.create();
      const b = backend();
      const server = createServer({
        backend: b,
        now: () => new Date(initial).toISOString(),
        quotas: { maxObjects: 1 },
      });
      await create(server, owner, 'a');
      const a = await object(owner, 'a');
      const c = await object(owner, 'c');
      const response = await push(server, owner, 'a', {
        ...a.bundle,
        objects: [...a.bundle.objects, ...c.bundle.objects],
        caps: [...a.bundle.caps, ...c.bundle.caps],
      });
      expect(response.status).toBe(403);
      expect(await b.list('repo/a/obj/')).toEqual([]);
      expect((await push(server, owner, 'a', c.bundle)).status).toBe(200);
      expect(await b.list('repo/a/obj/')).toEqual([
        `repo/a/obj/${c.object.id}`,
      ]);
    });
  });
}

test('invalid quota configurations fail closed', () => {
  for (const key of Object.keys(DEFAULT_QUOTAS)) {
    for (const value of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER,
      null,
      '1',
    ]) {
      expect(() =>
        createServer({
          backend: new MemoryBackend(),
          quotas: { [key]: value } as QuotaConfig,
        })
      ).toThrow();
    }
  }
  expect(() =>
    createServer({
      backend: new MemoryBackend(),
      quotas: null as unknown as QuotaConfig,
    })
  ).toThrow();
});

test('FileBackend instances share atomic owner reservations', async () => {
  const root = mkdtempSync(join(tmp, 'shared-'));
  const owner = Identity.create();
  const servers = Array.from({ length: 4 }, () =>
    createServer({
      backend: new FileBackend(root),
      now: () => new Date(initial).toISOString(),
      quotas: { maxRepositories: 1 },
    })
  );
  const results = await Promise.all(
    servers.map((server, i) => create(server, owner, `shared-${i}`))
  );
  expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403, 403]);
});

test('failed object persistence rolls back data, counters and rate reservations', async () => {
  class FailingBackend extends MemoryBackend {
    fail = false;
    override async put(key: string, bytes: Uint8Array): Promise<void> {
      if (this.fail && key.startsWith('repo/a/obj/')) {
        this.fail = false;
        throw new Error('private storage detail');
      }
      await super.put(key, bytes);
    }
  }
  const b = new FailingBackend();
  const owner = Identity.create();
  const server = createServer({
    backend: b,
    now: () => new Date(initial).toISOString(),
    quotas: { maxObjects: 1, objectCreationLimit: 1 },
  });
  await create(server, owner, 'a');
  const item = await object(owner, 'retry');
  b.fail = true;
  const response = await push(server, owner, 'a', item.bundle);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private');
  expect(await b.list('repo/a/obj/')).toEqual([]);
  expect((await push(server, owner, 'a', item.bundle)).status).toBe(200);
});

test('legacy flat data is adopted, overwritten into shards and remains quota charged', async () => {
  const root = mkdtempSync(join(tmp, 'legacy-'));
  const owner = Identity.create();
  writeFileSync(
    join(root, encodeURIComponent('repo/legacy/meta/repo')),
    encodeRecord({ owner: owner.did })
  );
  const b = new FileBackend(root);
  const server = createServer({
    backend: b,
    now: () => new Date(initial).toISOString(),
    quotas: { maxRepositories: 1 },
  });
  expect((await create(server, owner, 'over')).status).toBe(403);
  expect(
    (await server.fetch(new Request('http://quota.test/repos'))).status
  ).toBe(200);
  await b.put('repo/legacy/meta/repo', encodeRecord({ owner: owner.did }));
  expect(readdirSync(root)).not.toContain(
    encodeURIComponent('repo/legacy/meta/repo')
  );
  expect(readdirSync(join(root, '.records-v1')).length).toBeGreaterThan(0);
  expect(await b.list('repo/legacy/meta/')).toEqual(['repo/legacy/meta/repo']);
  expect(
    (await server.fetch(request('DELETE', '/repos/legacy', owner))).status
  ).toBe(200);
  expect((await create(server, owner, 'over')).status).toBe(201);
});

test('metrics contain fixed labels and no identity, object or repo labels', async () => {
  const owner = Identity.create();
  const server = createServer({
    backend: new MemoryBackend(),
    now: () => new Date(initial).toISOString(),
    quotas: { maxRepositories: 1 },
  });
  await create(server, owner, 'private-name');
  await create(server, owner, 'private-over');
  const metrics = await (
    await server.fetch(new Request('http://quota.test/metrics'))
  ).text();
  expect(metrics).toContain(
    'thaddeus_quota_outcomes_total{outcome="repository_quota_exceeded"} 1'
  );
  expect(metrics).not.toContain(owner.did);
  expect(metrics).not.toContain('private-name');
});

test('delegate object creation consumes the repository owner budget', async () => {
  const owner = Identity.create();
  const agent = Identity.create();
  const b = new MemoryBackend();
  const server = createServer({
    backend: b,
    now: () => new Date(initial).toISOString(),
    quotas: { maxObjects: 1 },
  });
  await create(server, owner, 'delegated');
  const delegation = signDelegation(
    { agent: agent.did, paths: ['**'], maxChanges: 100, maxSpend: 100 },
    owner
  );
  expect(
    (
      await server.fetch(
        request('POST', '/repos/delegated/grants', owner, {
          delegation: encodeDelegation(delegation),
        })
      )
    ).status
  ).toBe(200);
  const first = await object(agent, 'agent-content');
  const second = await object(owner, 'owner-content');
  expect((await push(server, agent, 'delegated', first.bundle)).status).toBe(
    200
  );
  expect((await push(server, owner, 'delegated', second.bundle)).status).toBe(
    403
  );
  await create(server, agent, 'independent-agent');
  expect(
    (await push(server, agent, 'independent-agent', second.bundle)).status
  ).toBe(200);
});

test('interrupted commit is replayed on restart and retains its owner quota', async () => {
  class InterruptedBackend extends MemoryBackend {
    interrupted = false;
    override async put(key: string, bytes: Uint8Array): Promise<void> {
      if (this.interrupted && key.startsWith('repo/a/obj/')) {
        throw new Error('storage went offline');
      }
      if (
        this.interrupted &&
        key === 'quota/v1/journal' &&
        (await this.get(key)) !== undefined
      ) {
        throw new Error('cannot publish rollback while offline');
      }
      await super.put(key, bytes);
    }
  }
  const b = new InterruptedBackend();
  const owner = Identity.create();
  const config = {
    backend: b,
    now: () => new Date(initial).toISOString(),
    quotas: { maxObjects: 1 },
  };
  const first = createServer(config);
  await create(first, owner, 'a');
  const item = await object(owner, 'interrupted');
  b.interrupted = true;
  expect((await push(first, owner, 'a', item.bundle)).status).toBe(503);
  expect(await b.get('quota/v1/journal')).toBeDefined();
  b.interrupted = false;
  const restarted = createServer(config);
  expect(
    (await restarted.fetch(new Request('http://quota.test/repos'))).status
  ).toBe(200);
  expect(await b.get('quota/v1/journal')).toBeUndefined();
  expect(await b.get(`repo/a/obj/${item.object.id}`)).toBeDefined();
  const another = await object(owner, 'another');
  expect((await push(restarted, owner, 'a', another.bundle)).status).toBe(403);
  expect(
    (await restarted.fetch(request('DELETE', '/repos/a', owner))).status
  ).toBe(200);
  await create(restarted, owner, 'b');
  expect((await push(restarted, owner, 'b', another.bundle)).status).toBe(200);
});

test('failed genesis reclaims the repository reservation and creation window', async () => {
  class FailingBackend extends MemoryBackend {
    fail = true;
    override async put(key: string, bytes: Uint8Array): Promise<void> {
      if (this.fail && key.startsWith('repo/')) {
        this.fail = false;
        throw new Error('write failed');
      }
      await super.put(key, bytes);
    }
  }
  const b = new FailingBackend();
  const owner = Identity.create();
  const server = createServer({
    backend: b,
    now: () => new Date(initial).toISOString(),
    quotas: { maxRepositories: 1, repositoryCreationLimit: 1 },
  });
  expect((await create(server, owner, 'failed')).status).toBe(503);
  expect(await b.list('repo/')).toEqual([]);
  expect((await create(server, owner, 'retry')).status).toBe(201);
});

test('legacy adoption stops at its inspection budget before allocating a repository', async () => {
  class EndlessBackend extends MemoryBackend {
    inspected = 0;
    override async openScan(prefix: string) {
      if (prefix !== 'repo/') return super.openScan(prefix);
      return {
        read: (budget: number) => {
          this.inspected += budget;
          return Promise.resolve({ keys: [], done: false });
        },
        close: () => Promise.resolve(),
      };
    }
  }
  const b = new EndlessBackend();
  const owner = Identity.create();
  const server = createServer({
    backend: b,
    now: () => new Date(initial).toISOString(),
  });
  expect((await create(server, owner, 'bounded')).status).toBe(503);
  expect(b.inspected).toBe(100_000);
  expect(await b.get('repo/bounded/meta/repo')).toBeUndefined();
});

test('malformed quota records fail closed and do not disclose durable keys', async () => {
  const b = new MemoryBackend();
  const owner = Identity.create();
  const server = createServer({
    backend: b,
    now: () => new Date(initial).toISOString(),
  });
  await create(server, owner, 'before-corruption');
  const keys = await b.list('quota/v1/owner/');
  await b.put(keys[0], encodeRecord({ repositories: -1 }));
  const response = await create(server, owner, 'after-corruption');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    code: 'quota_storage_unavailable',
    error: 'quota_storage_unavailable',
  });
  expect(await b.get('repo/after-corruption/meta/repo')).toBeUndefined();
});

test('an exhausted owner is rejected before cold repository object enumeration', async () => {
  class GuardedBackend extends MemoryBackend {
    guard = false;
    override async list(prefix: string): Promise<readonly string[]> {
      if (this.guard && prefix === 'repo/a/obj/')
        throw new Error('cold object allocation must not start');
      return super.list(prefix);
    }
  }
  const b = new GuardedBackend();
  const owner = Identity.create();
  const config = {
    backend: b,
    now: () => new Date(initial).toISOString(),
    quotas: { maxObjects: 1 },
  };
  const server = createServer(config);
  await create(server, owner, 'a');
  await push(server, owner, 'a', (await object(owner, 'first')).bundle);
  b.guard = true;
  const cold = createServer(config);
  const response = await push(
    cold,
    owner,
    'a',
    (await object(owner, 'over')).bundle
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: 'object_quota_exceeded',
  });
});

test('deleting a name prefix preserves another identity’s nested repository and accounting', async () => {
  const b = new MemoryBackend();
  const owner = Identity.create();
  const other = Identity.create();
  const server = createServer({
    backend: b,
    now: () => new Date(initial).toISOString(),
    quotas: { maxRepositories: 1, maxObjects: 1 },
  });
  await create(server, owner, 'parent');
  await create(server, other, 'parent/child');
  await push(
    server,
    other,
    'parent/child',
    (await object(other, 'child')).bundle
  );
  const childKeys = [...(await b.list('repo/parent/child/'))].sort();
  expect(
    (await server.fetch(request('DELETE', '/repos/parent', owner))).status
  ).toBe(200);
  expect([...(await b.list('repo/parent/child/'))].sort()).toEqual(childKeys);
  expect((await create(server, owner, 'replacement')).status).toBe(201);
  expect((await create(server, other, 'still-over')).status).toBe(403);
});

test('authorization-only requests cannot retain an unbounded registry cache', async () => {
  class ObservedBackend extends MemoryBackend {
    firstLoads = 0;
    override async list(prefix: string): Promise<readonly string[]> {
      if (prefix === 'repo/cache-0/grant/') this.firstLoads++;
      return super.list(prefix);
    }
  }
  const b = new ObservedBackend();
  const owner = Identity.create();
  const stranger = Identity.create();
  const server = createServer({
    backend: b,
    now: () => new Date(initial).toISOString(),
    quotas: { maxRepositories: 200, repositoryCreationLimit: 200 },
  });
  for (let i = 0; i < 130; i++)
    expect((await create(server, owner, `cache-${i}`)).status).toBe(201);
  const empty = encodeBundle([], [], []);
  for (let i = 0; i < 130; i++)
    expect((await push(server, stranger, `cache-${i}`, empty)).status).toBe(
      403
    );
  expect(b.firstLoads).toBe(1);
  expect((await push(server, stranger, 'cache-0', empty)).status).toBe(403);
  expect(b.firstLoads).toBe(2);
});
