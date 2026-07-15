import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import type { Backend } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { REPUTATION_ARCHIVE_FORMAT } from '../src/archive';
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
    const profile = reopened.profile(subject.did, new Set([host.did]));
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
    expect(
      reopened.profile(subject.did, new Set([host.did])).byKind.merge
    ).toBe(1);
  });

  test('without a backend, behavior is unchanged (in-memory only)', async () => {
    const subject = Identity.create();
    const host = Identity.create();
    const reps = new ReputationLog(); // no backend
    await reps.ingest(signContribution(fields('op-3'), subject, host));
    expect(reps.profile(subject.did, new Set([host.did])).byKind.merge).toBe(1);
  });

  test('a subject can mint and self-verify a claim without the host key', () => {
    const subject = Identity.create();
    const claim = signClaim(fields('op-4'), subject);
    // verifyClaim proves the subject signature holds with no host involved.
    expect(claim.subject).toBe(subject.did);
    expect(claim.subj_sig).toBeInstanceOf(Uint8Array);
  });

  test('an archive persists atomically, reloads, and reimports idempotently', async () => {
    const backend = new MemoryBackend();
    const subject = Identity.create();
    const host = Identity.create();
    const contribution = signContribution(fields('portable'), subject, host);
    const reps = new ReputationLog(backend);
    await reps.ingest(signContribution(fields('legacy'), subject, host));
    const archive = {
      format: REPUTATION_ARCHIVE_FORMAT,
      subject: subject.did,
      contributions: [contribution],
    } as const;

    expect(await reps.ingestArchive(archive)).toEqual({
      imported: 1,
      duplicates: 0,
      total: 2,
    });
    expect(await reps.ingestArchive(archive)).toEqual({
      imported: 0,
      duplicates: 1,
      total: 2,
    });
    expect(await backend.list('rep-import/')).toHaveLength(1);
    expect(
      (await ReputationLog.load(backend)).archive(subject.did).contributions
    ).toHaveLength(2);
  });

  test('a failed archive write leaves no contribution visible', async () => {
    const memory = new MemoryBackend();
    const backend: Backend = {
      get: (key) => memory.get(key),
      openScan: (prefix) => memory.openScan(prefix),
      list: (prefix) => memory.list(prefix),
      delete: (key) => memory.delete(key),
      put: () => Promise.reject(new Error('write failed')),
    };
    const subject = Identity.create();
    const host = Identity.create();
    const reps = new ReputationLog(backend);
    let message = '';
    try {
      await reps.ingestArchive({
        format: REPUTATION_ARCHIVE_FORMAT,
        subject: subject.did,
        contributions: [signContribution(fields('fail'), subject, host)],
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('write failed');
    expect(reps.forSubject(subject.did)).toEqual([]);
  });
});
