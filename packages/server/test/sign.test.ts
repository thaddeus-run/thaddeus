import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  ReplayNonceCache,
  REQUEST_SKEW_MS,
  signRequest,
  verifyRequest,
} from '../src/sign';

beforeAll(async () => {
  await ready();
});

const body = new TextEncoder().encode('{"name":"acme/web"}');
const NOW = '2026-06-25T12:00:00.000Z';
const nowMs = Date.parse(NOW);

describe('request signing', () => {
  test('a freshly signed request verifies to its signer DID', () => {
    const a = Identity.create();
    const h = signRequest('POST', '/repos', body, a, NOW);
    expect(verifyRequest('POST', '/repos', body, h, nowMs)).toBe(a.did);
  });

  test('a tampered body fails verification', () => {
    const a = Identity.create();
    const h = signRequest('POST', '/repos', body, a, NOW);
    const tampered = new TextEncoder().encode('{"name":"evil"}');
    expect(verifyRequest('POST', '/repos', tampered, h, nowMs)).toBeNull();
  });

  test('a tampered nonce fails verification', () => {
    const a = Identity.create();
    const h = signRequest('POST', '/repos', body, a, NOW, 'signed-nonce');
    expect(
      verifyRequest(
        'POST',
        '/repos',
        body,
        { ...h, nonce: 'substituted-nonce' },
        nowMs
      )
    ).toBeNull();
  });

  test('an expired timestamp fails', () => {
    const a = Identity.create();
    const h = signRequest('POST', '/repos', body, a, NOW);
    expect(
      verifyRequest('POST', '/repos', body, h, nowMs + 6 * 60 * 1000)
    ).toBeNull();
  });

  test('missing headers fail', () => {
    expect(verifyRequest('POST', '/repos', body, null, nowMs)).toBeNull();
  });

  test('a wrong-length signature returns null (does not throw)', () => {
    const a = Identity.create();
    const wrong = {
      did: a.did,
      timestamp: NOW,
      nonce: crypto.randomUUID(),
      signature: Buffer.from(new Uint8Array(10)).toString('base64'), // not 64 bytes
    };
    expect(verifyRequest('POST', '/repos', body, wrong, nowMs)).toBeNull();
  });

  test('a valid nonce is accepted once within the freshness window', () => {
    const a = Identity.create();
    const h = signRequest('POST', '/repos', body, a, NOW, 'nonce-once');
    const cache = new ReplayNonceCache();
    expect(verifyRequest('POST', '/repos', body, h, nowMs, cache)).toBe(a.did);
    expect(verifyRequest('POST', '/repos', body, h, nowMs, cache)).toBeNull();
    expect(cache.size).toBe(1);
  });

  test('invalid signatures do not poison a nonce', () => {
    const a = Identity.create();
    const h = signRequest('POST', '/repos', body, a, NOW, 'not-poisoned');
    const cache = new ReplayNonceCache();
    const bad = {
      ...h,
      signature: Buffer.from(new Uint8Array(64)).toString('base64'),
    };
    expect(verifyRequest('POST', '/repos', body, bad, nowMs, cache)).toBeNull();
    expect(cache.size).toBe(0);
    expect(verifyRequest('POST', '/repos', body, h, nowMs, cache)).toBe(a.did);
  });

  test('distinct nonces allow identical requests at the same timestamp', () => {
    const a = Identity.create();
    const first = signRequest('POST', '/repos', body, a, NOW, 'first');
    const second = signRequest('POST', '/repos', body, a, NOW, 'second');
    const cache = new ReplayNonceCache();
    expect(verifyRequest('POST', '/repos', body, first, nowMs, cache)).toBe(
      a.did
    );
    expect(verifyRequest('POST', '/repos', body, second, nowMs, cache)).toBe(
      a.did
    );
  });

  test('the same nonce is independent for different signers', () => {
    const a = Identity.create();
    const b = Identity.create();
    const cache = new ReplayNonceCache();
    const first = signRequest('POST', '/repos', body, a, NOW, 'shared');
    const second = signRequest('POST', '/repos', body, b, NOW, 'shared');
    expect(verifyRequest('POST', '/repos', body, first, nowMs, cache)).toBe(
      a.did
    );
    expect(verifyRequest('POST', '/repos', body, second, nowMs, cache)).toBe(
      b.did
    );
  });

  test('prunes expirations in time order regardless of insertion order', () => {
    const cache = new ReplayNonceCache(2);
    expect(cache.consume('did:key:zFirst', 'later', 200, 0)).toBe(true);
    expect(cache.consume('did:key:zSecond', 'earlier', 100, 0)).toBe(true);
    expect(cache.consume('did:key:zThird', 'new', 300, 101)).toBe(true);
    expect(cache.size).toBe(2);
    expect(cache.consume('did:key:zFirst', 'later', 200, 101)).toBe(false);
  });

  test('retains a nonce at the exact expiry boundary', () => {
    const cache = new ReplayNonceCache(1);
    expect(cache.consume('did:key:zSigner', 'nonce', 100, 0)).toBe(true);
    expect(cache.consume('did:key:zOther', 'new', 200, 100)).toBe(false);
    expect(cache.consume('did:key:zOther', 'new', 200, 101)).toBe(true);
  });

  test('capacity fails closed until the oldest nonce expires', () => {
    const a = Identity.create();
    const cache = new ReplayNonceCache(1);
    const first = signRequest('POST', '/repos', body, a, NOW, 'first');
    const atBoundary = new Date(nowMs + REQUEST_SKEW_MS).toISOString();
    const second = signRequest('POST', '/repos', body, a, atBoundary, 'second');
    expect(verifyRequest('POST', '/repos', body, first, nowMs, cache)).toBe(
      a.did
    );
    expect(
      verifyRequest('POST', '/repos', body, second, nowMs, cache)
    ).toBeNull();

    const afterExpiry = nowMs + REQUEST_SKEW_MS + 1;
    const third = signRequest(
      'POST',
      '/repos',
      body,
      a,
      new Date(afterExpiry).toISOString(),
      'third'
    );
    expect(
      verifyRequest('POST', '/repos', body, third, afterExpiry, cache)
    ).toBe(a.did);
    expect(cache.size).toBe(1);
  });

  test('rejects missing/oversized nonces and invalid cache capacities', () => {
    const a = Identity.create();
    const missing = signRequest('POST', '/repos', body, a, NOW, '');
    const oversized = signRequest(
      'POST',
      '/repos',
      body,
      a,
      NOW,
      'x'.repeat(129)
    );
    expect(verifyRequest('POST', '/repos', body, missing, nowMs)).toBeNull();
    expect(verifyRequest('POST', '/repos', body, oversized, nowMs)).toBeNull();
    expect(() => new ReplayNonceCache(0)).toThrow(RangeError);
  });
});
