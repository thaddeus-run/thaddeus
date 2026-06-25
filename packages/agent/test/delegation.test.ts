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
      signDelegation({ ...FIELDS, maxSpend: -1 }, operator)
    ).toThrow();
    expect(() => signDelegation({ ...FIELDS, agent: '' }, operator)).toThrow();
  });
});
