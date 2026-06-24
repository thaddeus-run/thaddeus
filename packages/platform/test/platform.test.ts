import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Platform } from '../src/platform';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('Platform — scopes', () => {
  test('createRepo seeds an empty main and is idempotent on name', () => {
    const platform = new Platform();
    const a = platform.createRepo('acme/web');
    expect(a.name).toBe('acme/web');
    expect(a.heads('main')).toEqual([]);
    expect(platform.createRepo('acme/web')).toBe(a); // same instance, no re-alloc
  });

  test('open auto-vivifies an absent repo (bare-push trick); repos() lists sorted', () => {
    const platform = new Platform();
    platform.createRepo('acme/web');
    const v = platform.open('acme/agent-run-8f2a'); // never created
    expect(v.name).toBe('acme/agent-run-8f2a');
    expect(platform.repos()).toEqual(['acme/agent-run-8f2a', 'acme/web']);
  });

  test('repos own isolated logs: an op in one is absent from another', async () => {
    const platform = new Platform();
    const a = platform.createRepo('a');
    const b = platform.createRepo('b');
    const author = Identity.create();
    const op = await a.log.write('main', 'x.rs', enc('x'), author);

    expect(a.log.verify(op.id)).toBe(true);
    expect(b.log.verify(op.id)).toBe(false); // distinct log, never saw it
    expect(a.store).not.toBe(b.store); // distinct stores
  });
});
