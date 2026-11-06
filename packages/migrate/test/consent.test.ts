import { Identity } from '@thaddeus.run/identity';
import { describe, expect, test } from 'bun:test';

import {
  CONSENT_DOMAIN,
  decodeConsent,
  MAX_CONSENT_MS,
  signConsent,
  TRANSFER,
} from '../src';
import { refused } from './helpers';

const ID = (c: string) => c.repeat(64);
const input = (service: string) => ({
  service,
  tenant: 'acme',
  repo: 'web',
  source: { server: 'https://keyless.example', repo: 'acme/web' },
  views: [
    { view: 'release', version: 0, head: ID('b'), revisions: [ID('1')] },
    { view: 'main', version: 1, head: ID('a'), revisions: [ID('2'), ID('3')] },
  ],
  now: Date.UTC(2026, 10, 6),
});

// Re-signs an edited payload, so a test can check the field rules alone.
function resign(owner: Identity, payload: unknown): string {
  const text = JSON.stringify(payload);
  const sig = owner.sign(
    new TextEncoder().encode(`${CONSENT_DOMAIN}\n${text}`)
  );
  return `thm1.${Buffer.from(text).toString('base64url')}.${Buffer.from(sig).toString('base64url')}`;
}

describe('consent tokens', () => {
  test('round-trip the owner, target, pinned history and transfer mode', () => {
    const owner = Identity.create();
    const service = Identity.create().did;
    const consent = decodeConsent(signConsent(owner, input(service)));
    expect(consent.source.owner).toBe(owner.did);
    expect(consent.service).toBe(service);
    expect(consent.transfer).toBe(TRANSFER);
    // Views are signed in a fixed order whatever order they were given in.
    expect(consent.views.map((v) => v.view)).toEqual(['main', 'release']);
    expect(consent.expiresAt - consent.issuedAt).toBe(24 * 60 * 60 * 1000);
    expect(Object.isFrozen(consent)).toBe(true);
  });

  test('a changed payload or a signature by anyone else is refused', async () => {
    const owner = Identity.create();
    const token = signConsent(owner, input(Identity.create().did));
    const [prefix, payload, sig] = token.split('.');
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const edited = Buffer.from(
      JSON.stringify({ ...body, repo: 'api' })
    ).toString('base64url');
    await refused(
      () => decodeConsent(`${prefix}.${edited}.${sig}`),
      'invalid_consent'
    );
    // Someone else signing a consent that names the owner.
    await refused(
      () => decodeConsent(resign(Identity.create(), body)),
      'invalid_consent'
    );
    await refused(() => decodeConsent('thm2.a.b'), 'invalid_consent');
    await refused(
      () => decodeConsent(`${prefix}.${payload}`),
      'invalid_consent'
    );
  });

  test('unknown fields, a newer version and malformed views are refused', async () => {
    const owner = Identity.create();
    const token = signConsent(owner, input(Identity.create().did));
    const body = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString()
    );
    await refused(
      () => decodeConsent(resign(owner, { ...body, extra: 1 })),
      'invalid_consent'
    );
    await refused(
      () => decodeConsent(resign(owner, { ...body, v: 2 })),
      'unsupported_format'
    );
    await refused(
      () =>
        decodeConsent(resign(owner, { ...body, transfer: 'service-decrypts' })),
      'invalid_consent'
    );
    await refused(
      () =>
        decodeConsent(
          resign(owner, { ...body, views: [...body.views].reverse() })
        ),
      'invalid_consent'
    );
    const short = body.views.map((v: { revisions: string[] }, i: number) =>
      i === 0 ? { ...v, revisions: v.revisions.slice(1) } : v
    );
    await refused(
      () => decodeConsent(resign(owner, { ...body, views: short })),
      'invalid_consent'
    );
    await refused(
      () => decodeConsent(resign(owner, { ...body, views: [] })),
      'invalid_consent'
    );
    await refused(
      () => decodeConsent(resign(owner, { ...body, tenant: 'Acme' })),
      'invalid_consent'
    );
  });

  test('a consent lasts at most a week', async () => {
    const owner = Identity.create();
    const service = Identity.create().did;
    expect(() =>
      signConsent(owner, { ...input(service), lifetimeMs: MAX_CONSENT_MS + 1 })
    ).toThrow();
    const longest = decodeConsent(
      signConsent(owner, { ...input(service), lifetimeMs: MAX_CONSENT_MS })
    );
    expect(longest.expiresAt - longest.issuedAt).toBe(MAX_CONSENT_MS);
    await refused(
      () => signConsent(owner, { ...input(service), lifetimeMs: 0 }),
      'invalid_consent'
    );
  });
});
