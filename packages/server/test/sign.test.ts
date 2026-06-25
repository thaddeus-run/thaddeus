import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { signRequest, verifyRequest } from '../src/sign';

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
      signature: Buffer.from(new Uint8Array(10)).toString('base64'), // not 64 bytes
    };
    expect(verifyRequest('POST', '/repos', body, wrong, nowMs)).toBeNull();
  });
});
