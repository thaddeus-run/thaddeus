import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  type DelegationFields,
  signDelegation,
  verifyDelegation,
} from '../src/delegation';

beforeAll(async () => {
  await ready();
});

const FIELDS: DelegationFields = {
  agent: 'did:key:zAgentPlaceholder',
  paths: ['src/**'],
  maxChanges: 5,
  maxSpend: 100,
};

describe('Delegation — sign & verify', () => {
  test('a freshly signed delegation verifies, with the operator did derived', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const d = signDelegation({ ...FIELDS, agent: agent.did }, operator);
    expect(verifyDelegation(d)).toBe(true);
    expect(d.operator).toBe(operator.did);
    expect(d.agent).toBe(agent.did);
    expect(d.paths).toEqual(['src/**']);
  });

  test('tampering any covered field breaks the signature', () => {
    const operator = Identity.create();
    const other = Identity.create();
    const d = signDelegation(FIELDS, operator);
    expect(verifyDelegation({ ...d, agent: 'did:key:zEvil' })).toBe(false);
    expect(verifyDelegation({ ...d, paths: ['**'] })).toBe(false);
    expect(verifyDelegation({ ...d, maxChanges: 999 })).toBe(false);
    expect(verifyDelegation({ ...d, maxSpend: 999 })).toBe(false);
    expect(verifyDelegation({ ...d, operator: other.did })).toBe(false);
  });

  test('a malformed operator did fails soft (false), never throws', () => {
    const operator = Identity.create();
    const d = signDelegation(FIELDS, operator);
    expect(verifyDelegation({ ...d, operator: 'did:key:notvalid' })).toBe(
      false
    );
  });

  test('signDelegation rejects non-canonical fields', () => {
    const operator = Identity.create();
    expect(() => signDelegation({ ...FIELDS, paths: [] }, operator)).toThrow();
    expect(() =>
      signDelegation({ ...FIELDS, maxChanges: -1 }, operator)
    ).toThrow();
    expect(() =>
      signDelegation({ ...FIELDS, maxChanges: 2.5 }, operator)
    ).toThrow();
    expect(() =>
      signDelegation({ ...FIELDS, maxSpend: -1 }, operator)
    ).toThrow();
    expect(() => signDelegation({ ...FIELDS, agent: '' }, operator)).toThrow();
  });

  describe('maxChangesPerHour (P9 rate window)', () => {
    const fields = (agent: Identity) =>
      ({
        agent: agent.did,
        paths: ['src/**'],
        maxChanges: 5,
        maxSpend: 100,
      }) as const;

    test('a pre-P9 record and a new no-cap grant sign the identical v1 tuple', () => {
      const operator = Identity.create();
      const agent = Identity.create();
      const f = fields(agent);
      // Reproduce the legacy canonical bytes exactly as the old code built them.
      const legacyBytes = new TextEncoder().encode(
        JSON.stringify([
          'thaddeus.delegation.v1',
          operator.did,
          f.agent,
          [...f.paths],
          f.maxChanges,
          f.maxSpend,
        ])
      );
      const legacy = {
        ...f,
        operator: operator.did,
        sig: operator.sign(legacyBytes),
      };
      expect(verifyDelegation(legacy)).toBe(true); // old grant still verifies
      // A new grant without the field verifies against the SAME bytes.
      const fresh = signDelegation(f, operator);
      expect(verifyDelegation({ ...fresh, sig: legacy.sig })).toBe(true);
      // Explicit null is byte-identical to absent.
      const explicit = signDelegation(
        { ...f, maxChangesPerHour: null },
        operator
      );
      expect(verifyDelegation({ ...explicit, sig: legacy.sig })).toBe(true);
    });

    test('a rate-capped grant verifies and rejects tampering with the cap', () => {
      const operator = Identity.create();
      const agent = Identity.create();
      const d = signDelegation(
        { ...fields(agent), maxChangesPerHour: 3 },
        operator
      );
      expect(d.maxChangesPerHour).toBe(3);
      expect(verifyDelegation(d)).toBe(true);
      expect(verifyDelegation({ ...d, maxChangesPerHour: 4 })).toBe(false);
      expect(verifyDelegation({ ...d, maxChangesPerHour: null })).toBe(false);
    });

    test('canonicalization rejects a negative or fractional cap; zero is legal', () => {
      const operator = Identity.create();
      const agent = Identity.create();
      expect(() =>
        signDelegation({ ...fields(agent), maxChangesPerHour: -1 }, operator)
      ).toThrow(TypeError);
      expect(() =>
        signDelegation({ ...fields(agent), maxChangesPerHour: 1.5 }, operator)
      ).toThrow(TypeError);
      expect(
        verifyDelegation(
          signDelegation({ ...fields(agent), maxChangesPerHour: 0 }, operator)
        )
      ).toBe(true);
    });

    // Security pin: canonicalDelegation is presence-keyed, not truthiness-keyed
    // (see the `== null` check, not `?`/truthy, in canonicalDelegation). A cap
    // of exactly 0 must sign DIFFERENT bytes than an absent/null cap, so a
    // record can never be replayed as "no rate limit" by simply dropping the
    // field. A future `rate ? [...v1, rate] : v1` regression would make this
    // fail because 0 is falsy.
    test('a zero rate cap does not verify once the field is stripped (cap 0 != no cap)', () => {
      const operator = Identity.create();
      const agent = Identity.create();
      const zero = signDelegation(
        { ...fields(agent), maxChangesPerHour: 0 },
        operator
      );
      const { maxChangesPerHour: _dropped, ...rest } = zero;
      expect(verifyDelegation({ ...rest, maxChangesPerHour: null })).toBe(
        false
      );
    });
  });
});
