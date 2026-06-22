import { beforeAll, describe, expect, test } from 'bun:test';

import { Identity, PublicIdentity, ready } from '../src/index';

beforeAll(async () => {
  await ready();
});

describe('Identity', () => {
  test('create() produces a did:key', () => {
    expect(Identity.create().did.startsWith('did:key:z')).toBe(true);
  });

  test('sign/verify round-trips and rejects tampering', () => {
    const id = Identity.create();
    const msg = new TextEncoder().encode('hello');
    const sig = id.sign(msg);
    expect(id.toPublic().verify(msg, sig)).toBe(true);
    expect(id.toPublic().verify(new TextEncoder().encode('hellp'), sig)).toBe(
      false
    );
  });

  test('seal/unseal round-trips for the recipient only', () => {
    const a = Identity.create();
    const b = Identity.create();
    const secret = new TextEncoder().encode('top-secret');
    const box = a.toPublic().seal(secret);
    expect(a.unseal(box)).toEqual(secret);
    expect(() => b.unseal(box)).toThrow();
  });

  test('PublicIdentity.fromDid reconstructs a verifying key', () => {
    const id = Identity.create();
    const msg = new TextEncoder().encode('m');
    const sig = id.sign(msg);
    expect(PublicIdentity.fromDid(id.did).verify(msg, sig)).toBe(true);
  });
});
