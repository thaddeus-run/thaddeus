import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { signHead } from '@thaddeus.run/log';
import type { Backend } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Platform } from '../src/platform';
import { blockOnConflict } from '../src/policy';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

function memoryBackend(): Backend {
  const m = new Map<string, Uint8Array>();
  return {
    put: async (k, b) => void m.set(k, new Uint8Array(b)),
    get: async (k) => {
      const v = m.get(k);
      return v === undefined ? undefined : new Uint8Array(v);
    },
    list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
    delete: async (k) => void m.delete(k),
  };
}

describe('Platform — durable repos', () => {
  test('a repo survives a restart: commit → land → discard → reopen', async () => {
    const backend = memoryBackend();
    const dev = Identity.create();

    const a = await new Platform().createDurable('acme/web', backend);
    const ws = Workspace.open(a.log, a.store, {
      source: 'main',
      reader: dev,
      name: 'feat',
    });
    ws.write('src/auth.rs', enc('fn refresh() {}'));
    await ws.commit(dev);
    const result = await a.land({
      from: 'feat',
      into: 'main',
      author: dev,
      policy: blockOnConflict,
    });
    expect(result.landed).toBe(true);

    // "restart": discard `a`; reopen from the same backend.
    const b = await new Platform().openDurable('acme/web', backend);
    expect(b.log.materialize('main').has('src/auth.rs')).toBe(true);
    const ref = b.log.materialize('main', dev).get('src/auth.rs')?.ref;
    expect(ref).toBeDefined();
    expect(ref).not.toBeNull();
    if (ref != null) {
      expect(dec(await b.store.get(ref, dev))).toBe('fn refresh() {}');
    }
  });

  test('two durable repos in one backend stay isolated', async () => {
    const backend = memoryBackend();
    const dev = Identity.create();
    const a = await new Platform().createDurable('a', backend);
    const wsa = Workspace.open(a.log, a.store, {
      source: 'main',
      reader: dev,
      name: 'f',
    });
    wsa.write('a.rs', enc('a'));
    await wsa.commit(dev);
    await a.land({ from: 'f', author: dev, policy: blockOnConflict });

    const b = await new Platform().openDurable('b', backend); // never written
    expect(b.log.materialize('main').size).toBe(0);
  });

  test('signed land persists the exact successor and policy denial leaves it unchanged', async () => {
    const backend = memoryBackend();
    const owner = Identity.create();
    const repo = await new Platform().createDurable('signed', backend);
    const genesis = signHead(
      {
        repo: 'signed',
        view: 'main',
        version: 0,
        previous: null,
        heads: [],
      },
      owner
    );
    await repo.headRecords.bootstrap(genesis);

    const ws = Workspace.open(repo.log, repo.store, {
      source: 'main',
      reader: owner,
      name: 'feature',
    });
    ws.write('signed.rs', enc('fn signed() {}'));
    await ws.commit(owner);
    const next = signHead(
      {
        repo: 'signed',
        view: 'main',
        version: 1,
        previous: genesis.id,
        heads: [...repo.log.heads('feature')].sort(),
      },
      owner
    );
    expect(
      await repo.land({
        from: 'feature',
        author: owner,
        headRecord: next,
      })
    ).toMatchObject({ landed: true, heads: [...next.heads] });

    const deniedWorkspace = Workspace.open(repo.log, repo.store, {
      source: 'main',
      reader: owner,
      name: 'denied',
    });
    deniedWorkspace.write('denied.rs', enc('fn denied() {}'));
    await deniedWorkspace.commit(owner);
    const deniedHead = signHead(
      {
        repo: 'signed',
        view: 'main',
        version: 2,
        previous: next.id,
        heads: [
          ...new Set([...repo.log.heads('main'), ...repo.log.heads('denied')]),
        ].sort(),
      },
      owner
    );
    const denied = await repo.land({
      from: 'denied',
      author: owner,
      headRecord: deniedHead,
      policy: () => ({ allow: false, reason: 'not today' }),
    });
    expect(denied).toMatchObject({ landed: false, reason: 'not today' });
    expect(repo.headRecords.current('main')?.id).toBe(next.id);

    const reopened = await new Platform().openDurable('signed', backend);
    expect(reopened.headRecords.current('main')?.id).toBe(next.id);
    expect(reopened.headRecords.history('main')).toHaveLength(2);
  });

  test('signed authority survives a repoint failure without hiding unpublished work', async () => {
    const inner = memoryBackend();
    let failMainRepoint = false;
    const backend: Backend = {
      put: (key, bytes) => {
        if (failMainRepoint && key === 'repo/fault/view/main') {
          failMainRepoint = false;
          return Promise.reject(new Error('simulated projection failure'));
        }
        return inner.put(key, bytes);
      },
      get: (key) => inner.get(key),
      list: (prefix) => inner.list(prefix),
      delete: (key) => inner.delete(key),
    };
    const owner = Identity.create();
    const repo = await new Platform().createDurable('fault', backend);
    const genesis = signHead(
      {
        repo: 'fault',
        view: 'main',
        version: 0,
        previous: null,
        heads: [],
      },
      owner
    );
    await repo.headRecords.bootstrap(genesis);
    const workspace = Workspace.open(repo.log, repo.store, {
      source: 'main',
      reader: owner,
      name: 'feature',
    });
    workspace.write('committed.rs', enc('committed'));
    await workspace.commit(owner);
    const next = signHead(
      {
        repo: 'fault',
        view: 'main',
        version: 1,
        previous: genesis.id,
        heads: [...repo.log.heads('feature')].sort(),
      },
      owner
    );

    failMainRepoint = true;
    expect(
      await repo.land({ from: 'feature', author: owner, headRecord: next })
    ).toMatchObject({ landed: true, heads: [...next.heads] });
    expect(repo.log.heads('main')).toEqual(next.heads);

    const repaired = await new Platform().openDurable('fault', backend);
    expect(repaired.headRecords.current('main')?.id).toBe(next.id);
    expect(repaired.log.heads('main')).toEqual(next.heads);

    const local = Workspace.open(repaired.log, repaired.store, {
      source: 'main',
      reader: owner,
      name: 'main',
    });
    local.write('unpublished.rs', enc('local'));
    await local.commit(owner);
    const unpublishedHeads = [...repaired.log.heads('main')];
    const reopened = await new Platform().openDurable('fault', backend);
    expect(reopened.log.heads('main')).toEqual(unpublishedHeads);
    expect(reopened.headRecords.current('main')?.id).toBe(next.id);
  });
});
