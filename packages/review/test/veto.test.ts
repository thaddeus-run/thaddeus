import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { canonicalVeto, signVeto, verifyVeto } from '../src/veto';

beforeAll(async () => {
  await ready();
});

const fields = {
  op: 'op-abc123',
  reason: 'ships a secret in cleartext',
  at: '2026-07-01T00:00:00Z',
};

describe('veto — sign / verify', () => {
  test('a signed veto verifies under the reviewer did', () => {
    const reviewer = Identity.create();
    const v = signVeto(fields, reviewer);
    expect(v.reviewer).toBe(reviewer.did);
    expect(verifyVeto(v)).toBe(true);
  });

  test('a tampered field fails verification (nothing is malleable)', () => {
    const reviewer = Identity.create();
    const v = signVeto(fields, reviewer);
    expect(verifyVeto({ ...v, op: 'op-other' })).toBe(false);
    expect(verifyVeto({ ...v, reason: 'looks fine actually' })).toBe(false);
    expect(verifyVeto({ ...v, at: '2020-01-01T00:00:00Z' })).toBe(false);
  });

  test('a swapped reviewer did fails verification', () => {
    const reviewer = Identity.create();
    const impostor = Identity.create();
    const v = signVeto(fields, reviewer);
    expect(verifyVeto({ ...v, reviewer: impostor.did })).toBe(false);
  });

  test('a wrong-key signature fails verification', () => {
    const reviewer = Identity.create();
    const other = Identity.create();
    const v = signVeto(fields, reviewer);
    expect(verifyVeto({ ...v, sig: other.sign(new Uint8Array([1])) })).toBe(
      false
    );
  });

  test('a non-canonical field throws at sign time and fails verify', () => {
    const reviewer = Identity.create();
    expect(() => signVeto({ ...fields, reason: '' }, reviewer)).toThrow(
      TypeError
    );
    // A record carrying an empty required field can never verify.
    const v = signVeto(fields, reviewer);
    expect(verifyVeto({ ...v, op: '' })).toBe(false);
  });

  test('canonicalVeto is deterministic and domain-tagged', () => {
    const reviewer = Identity.create();
    const a = canonicalVeto(fields, reviewer.did);
    const b = canonicalVeto(fields, reviewer.did);
    expect(a).toEqual(b);
    expect(new TextDecoder().decode(a)).toContain('thaddeus.veto.v1');
  });
});
