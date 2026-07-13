import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '../src/client';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('Client.push / land — round-trip', () => {
  test('edit → push → land → fresh clone decrypts the content', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const fetchImpl = srv.fetch.bind(srv);
    const c = new Client('http://t', a, fetchImpl);
    await c.createRepo('r');

    // Author A clones (empty), commits locally, pushes, lands.
    const { repo } = await c.clone('r', new MemoryBackend());
    const ws = Workspace.open(repo.log, repo.store, {
      source: 'main',
      reader: a,
      name: 'work',
    });
    ws.write('src/auth.rs', enc('fn refresh() {}'));
    await ws.commit(a);
    const heads = [...repo.log.heads('work')];
    const pushed = await c.push('r', repo, heads);
    expect(pushed.accepted.ops).toBeGreaterThan(0);
    expect(pushed.rejected).toHaveLength(0);
    const landed = await c.land('r', repo, heads, 'main');
    expect(landed.landed).toBe(true);

    // A second clone (fresh backend) materializes + decrypts.
    const { repo: repo2 } = await c.clone('r', new MemoryBackend());
    const ref = repo2.log.materialize('main', a).get('src/auth.rs')?.ref;
    expect(ref).toBeDefined();
    if (ref != null) {
      expect(dec(await repo2.store.get(ref, a))).toBe('fn refresh() {}');
    }

    // Re-push is idempotent.
    const again = await c.push('r', repo, heads);
    expect(again.rejected).toHaveLength(0);
  });
});
