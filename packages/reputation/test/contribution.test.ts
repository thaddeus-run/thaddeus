import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  attestWithSigner,
  canonicalContribution,
  type ContributionFields,
  signClaim,
  signContribution,
  verifyContribution,
} from '../src/contribution';

beforeAll(async () => {
  await ready();
});

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected promise to reject');
}

const FIELDS: ContributionFields = {
  repo: 'forgejo.example/acme/web',
  ref: 'op-abc123',
  kind: 'merge',
  at: '2026-06-24T00:00:00.000Z',
};

describe('Contribution — sign & verify', () => {
  test('a freshly signed contribution is authentic and attested', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const c = signContribution(FIELDS, subject, host);
    expect(verifyContribution(c)).toEqual({ authentic: true, attested: true });
  });

  test('an asynchronous signer produces the same verified contribution', async () => {
    const subject = Identity.create();
    const host = Identity.create();
    const claim = signClaim(FIELDS, subject);
    const contribution = await attestWithSigner(claim, {
      did: host.did,
      sign: (message) => Promise.resolve(host.sign(message)),
    });
    expect(verifyContribution(contribution)).toEqual({
      authentic: true,
      attested: true,
    });
  });

  test('an asynchronous signer response is verified locally', async () => {
    const subject = Identity.create();
    const host = Identity.create();
    expect(
      await rejectionMessage(
        attestWithSigner(signClaim(FIELDS, subject), {
          did: host.did,
          sign: () => Promise.resolve(new Uint8Array(64)),
        })
      )
    ).toContain('invalid signature');
  });

  test('subject and host dids are derived from the signing identities', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const c = signContribution(FIELDS, subject, host);
    expect(c.subject).toBe(subject.did);
    expect(c.host).toBe(host.did);
    expect(c.repo).toBe(FIELDS.repo);
    expect(c.ref).toBe(FIELDS.ref);
    expect(c.kind).toBe('merge');
  });

  test('tampering a shared field breaks both signatures', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const c = signContribution(FIELDS, subject, host);
    expect(verifyContribution({ ...c, ref: 'op-evil' })).toEqual({
      authentic: false,
      attested: false,
    });
  });

  test('tampering subject breaks authentic; tampering host breaks attested', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const other = Identity.create();
    const c = signContribution(FIELDS, subject, host);
    // Re-pointing `subject` to another did invalidates subj_sig (host_sig also
    // covers subject (its six-field core includes it), so attested breaks too).
    expect(verifyContribution({ ...c, subject: other.did }).authentic).toBe(
      false
    );
    const hostTampered = verifyContribution({ ...c, host: other.did });
    expect(hostTampered.attested).toBe(false);
    // The portability guarantee: the subject's claim is independent of host, so
    // swapping host leaves authentic intact (subj_sig omits host).
    expect(hostTampered.authentic).toBe(true);
  });

  test('a host_sig from the wrong key is not attested, but stays authentic', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const stray = Identity.create();
    const bytes = canonicalContribution({
      ...FIELDS,
      subject: subject.did,
      host: host.did,
    });
    const wrongHost = {
      ...signContribution(FIELDS, subject, host),
      host_sig: stray.sign(bytes),
    };
    expect(verifyContribution(wrongHost)).toEqual({
      authentic: true,
      attested: false,
    });
  });

  test('a malformed did fails soft on that side only, never throws', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const c = signContribution(FIELDS, subject, host);
    const bad = { ...c, host: 'did:key:notvalid' };
    expect(verifyContribution(bad).attested).toBe(false);
    expect(verifyContribution(bad).authentic).toBe(true); // subject side still checks
  });

  test('a non-canonical (empty) host breaks only attested, not authentic', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const c = signContribution(FIELDS, subject, host);
    // An empty host makes the host core non-canonical; the subject core omits
    // host, so the subject's claim must remain verifiable (per-side fail-soft).
    expect(verifyContribution({ ...c, host: '' })).toEqual({
      authentic: true,
      attested: false,
    });
  });

  test('signContribution rejects a non-canonical kind', () => {
    const subject = Identity.create();
    const host = Identity.create();
    expect(() =>
      signContribution(
        { ...FIELDS, kind: 'bogus' as ContributionFields['kind'] },
        subject,
        host
      )
    ).toThrow();
  });
});
