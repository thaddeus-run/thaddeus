import { ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { publicDid, publicIdentity } from '../src/membrane';

beforeAll(async () => {
  await ready();
});

describe('public identity', () => {
  test('is stable and world-constructible', () => {
    expect(publicIdentity().did).toBe(publicDid());
    expect(publicDid().startsWith('did:key:z')).toBe(true);
    // Memoized: same instance every call.
    expect(publicIdentity()).toBe(publicIdentity());
  });
});
