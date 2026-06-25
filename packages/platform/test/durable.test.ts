import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
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
});
