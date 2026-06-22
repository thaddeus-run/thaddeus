import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  issueCapability,
  unwrapKey,
  verifyCapability,
} from '../src/capability';
import { newContentKey } from '../src/object';

beforeAll(async () => {
  await ready();
});

describe('capability', () => {
  test('grantee can unwrap the content key; signature verifies', () => {
    const alice = Identity.create();
    const bob = Identity.create();
    const key = newContentKey();
    const cap = issueCapability({
      object: 'pid',
      contentKey: key,
      grantee: bob.toPublic(),
      grantedBy: alice,
    });
    expect(verifyCapability(cap)).toBe(true);
    expect(unwrapKey(cap, bob)).toEqual(key);
  });

  test('a tampered grantee fails signature verification', () => {
    const alice = Identity.create();
    const bob = Identity.create();
    const cap = issueCapability({
      object: 'pid',
      contentKey: newContentKey(),
      grantee: bob.toPublic(),
      grantedBy: alice,
    });
    const forged = { ...cap, grantee: Identity.create().did };
    expect(verifyCapability(forged)).toBe(false);
  });
});
