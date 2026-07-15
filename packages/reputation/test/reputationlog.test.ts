import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  type Contribution,
  type ContributionFields,
  signContribution,
} from '../src/contribution';
import { ReputationLog } from '../src/reputationlog';

beforeAll(async () => {
  await ready();
});

const fields = (
  over: Partial<ContributionFields> = {}
): ContributionFields => ({
  repo: 'acme/web',
  ref: 'op-1',
  kind: 'merge',
  at: '2026-06-24T00:00:00.000Z',
  ...over,
});

describe('ReputationLog — aggregate, verify, profile', () => {
  test('an absent subject does not inspect unrelated global records', () => {
    const subject = Identity.create();
    const other = Identity.create();
    const host = Identity.create();
    const contribution = signContribution(fields(), subject, host);
    const log = new ReputationLog();
    log.append(contribution);
    Object.defineProperty(contribution, 'subject', {
      get: () => {
        throw new Error('unrelated contribution was inspected');
      },
    });

    expect([...log.iterateArchiveContributions(other.did)]).toEqual([]);
  });

  test('cross-instance honoring: a contribution verifies on a fresh log', () => {
    const alice = Identity.create();
    const instanceA = Identity.create();
    const c = signContribution(fields(), alice, instanceA);

    // instanceB shares NO state with the minter — only the dids in the record.
    const instanceB = new ReputationLog();
    instanceB.append(c);
    expect(instanceB.verify(c)).toEqual({ authentic: true, attested: true });
    expect(instanceB.forSubject(alice.did)).toHaveLength(1);
  });

  test('append keeps invalid records and is idempotent on full content', () => {
    const alice = Identity.create();
    const host = Identity.create();
    const stray = Identity.create();
    const c = signContribution(fields(), alice, host);
    // Non-authentic: subj_sig replaced with a stray key's signature.
    const forged: Contribution = {
      ...c,
      subj_sig: stray.sign(new Uint8Array([1])),
    };

    const log = new ReputationLog();
    log.append(forged);
    log.append(forged); // identical → no duplicate
    expect(log.forSubject(alice.did)).toHaveLength(1); // kept, not rejected
  });

  test('profile partitions attested / claimed / dropped and counts byKind', () => {
    const alice = Identity.create();
    const host = Identity.create();
    const stray = Identity.create();

    // (1) attested: both sigs valid, kind merge.
    const attested = signContribution(fields({ ref: 'op-a' }), alice, host);
    // (2) claimed: authentic (subj_sig intact), but host_sig is from the wrong
    // key, so it does not verify under the record's `host` did.
    const base = signContribution(fields({ ref: 'op-b' }), alice, host);
    const claimed: Contribution = {
      ...base,
      host_sig: stray.sign(new Uint8Array([9])),
    };
    // (3) dropped: not authentic (subj_sig from the wrong key).
    const dropped: Contribution = {
      ...signContribution(fields({ ref: 'op-c', kind: 'review' }), alice, host),
      subj_sig: stray.sign(new Uint8Array([7])),
    };

    const log = new ReputationLog();
    log.append(attested);
    log.append(claimed);
    log.append(dropped);

    const p = log.profile(alice.did, new Set([host.did]));
    expect(p.attested.map((c) => c.ref)).toEqual(['op-a']);
    expect(p.untrusted).toEqual([]);
    expect(p.claimed.map((c) => c.ref)).toEqual(['op-b']);
    expect(p.byKind.merge).toBe(1);
    expect(p.byKind.review).toBe(0);
    expect(p.byKind.release).toBe(0);
  });

  test('an explicit trust set separates valid foreign attestations', () => {
    const alice = Identity.create();
    const trusted = Identity.create();
    const foreign = Identity.create();
    const log = new ReputationLog();
    log.append(signContribution(fields({ ref: 'trusted' }), alice, trusted));
    log.append(signContribution(fields({ ref: 'foreign' }), alice, foreign));

    const filtered = log.profile(alice.did, new Set([trusted.did]));
    expect(filtered.attested.map((c) => c.ref)).toEqual(['trusted']);
    expect(filtered.untrusted.map((c) => c.ref)).toEqual(['foreign']);
    expect(filtered.byKind.merge).toBe(1);
    expect(log.profile(alice.did, new Set()).attested).toHaveLength(0);
  });

  test('counts one event across timestamps and trusted hosts', () => {
    const alice = Identity.create();
    const firstHost = Identity.create();
    const secondHost = Identity.create();
    const first = signContribution(fields(), alice, firstHost);
    const second = signContribution(
      fields({ at: '2026-06-25T00:00:00.000Z' }),
      alice,
      secondHost
    );
    const log = new ReputationLog();
    log.append(first);
    log.append(second);

    const profile = log.profile(
      alice.did,
      new Set([firstHost.did, secondHost.did])
    );
    expect(profile.attested).toHaveLength(2);
    expect(profile.counted).toHaveLength(1);
    expect(profile.byKind.merge).toBe(1);

    const reversed = new ReputationLog();
    reversed.append(second);
    reversed.append(first);
    expect(
      reversed.profile(alice.did, new Set([firstHost.did, secondHost.did]))
        .counted
    ).toEqual(profile.counted);
  });

  test('removing a rotated host DID immediately makes its proofs untrusted', () => {
    const alice = Identity.create();
    const outgoingHost = Identity.create();
    const log = new ReputationLog();
    log.append(signContribution(fields(), alice, outgoingHost));

    expect(
      log.profile(alice.did, new Set([outgoingHost.did])).counted
    ).toHaveLength(1);
    const removed = log.profile(alice.did, new Set());
    expect(removed.counted).toHaveLength(0);
    expect(removed.attested).toHaveLength(0);
    expect(removed.untrusted).toHaveLength(1);
  });

  test('forSubject returns a deterministic order regardless of append order', () => {
    const alice = Identity.create();
    const host = Identity.create();
    const c1 = signContribution(fields({ ref: 'op-1' }), alice, host);
    const c2 = signContribution(fields({ ref: 'op-2' }), alice, host);
    const c3 = signContribution(fields({ ref: 'op-3' }), alice, host);

    const a = new ReputationLog();
    [c1, c2, c3].forEach((c) => a.append(c));
    const b = new ReputationLog();
    [c3, c1, c2].forEach((c) => b.append(c));

    expect(a.forSubject(alice.did).map((c) => c.ref)).toEqual(
      b.forSubject(alice.did).map((c) => c.ref)
    );
  });
});
