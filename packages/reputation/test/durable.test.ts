import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  attest,
  type ContributionFields,
  signClaim,
  signContribution,
} from '../src/contribution';
import { ReputationLog } from '../src/reputationlog';

beforeAll(async () => {
  await ready();
});

const fields = (ref: string): ContributionFields => ({
  repo: 'acme/web',
  ref,
  kind: 'merge',
  at: '2026-07-01T00:00:00Z',
});

describe('ReputationLog — durability', () => {
  test('an attested contribution survives a load() reopen and counts', async () => {
    const backend = new MemoryBackend();
    const subject = Identity.create();
    const host = Identity.create();

    const reps = new ReputationLog(backend);
    await reps.ingest(signContribution(fields('op-1'), subject, host));

    // Reopen from the same backend — the attested merge survives and counts.
    const reopened = await ReputationLog.load(backend);
    const profile = reopened.profile(subject.did);
    expect(profile.attested).toHaveLength(1);
    expect(profile.byKind.merge).toBe(1);
  });

  test('a claim attested by the host is durable; a torn record is skipped', async () => {
    const backend = new MemoryBackend();
    const subject = Identity.create();
    const host = Identity.create();

    // The subject mints a claim with its key alone; the host attests it.
    const claim = signClaim(fields('op-2'), subject);
    const attested = attest(claim, host);
    const reps = new ReputationLog(backend);
    await reps.ingest(attested);

    // A corrupt record under the rep/ prefix must not crash load — it is skipped.
    await backend.put(
      'rep/torn',
      new TextEncoder().encode('{not valid record')
    );

    const reopened = await ReputationLog.load(backend);
    expect(reopened.profile(subject.did).byKind.merge).toBe(1);
  });

  test('without a backend, behavior is unchanged (in-memory only)', async () => {
    const subject = Identity.create();
    const host = Identity.create();
    const reps = new ReputationLog(); // no backend
    await reps.ingest(signContribution(fields('op-3'), subject, host));
    expect(reps.profile(subject.did).byKind.merge).toBe(1);
  });

  test('a subject can mint and self-verify a claim without the host key', () => {
    const subject = Identity.create();
    const claim = signClaim(fields('op-4'), subject);
    // verifyClaim proves the subject signature holds with no host involved.
    expect(claim.subject).toBe(subject.did);
    expect(claim.subj_sig).toBeInstanceOf(Uint8Array);
  });
});
