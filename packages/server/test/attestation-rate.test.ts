import { MemoryBackend } from '@thaddeus.run/persist';
import { encodeRecord } from '@thaddeus.run/store';
import { describe, expect, test } from 'bun:test';

import { AttestationRateLimiter } from '../src/attestation-rate';

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected promise to reject');
}

describe('AttestationRateLimiter', () => {
  test('allows the twentieth issuance and rejects the twenty-first', async () => {
    const backend = new MemoryBackend();
    const limiter = new AttestationRateLimiter(backend, 20);
    for (let index = 0; index < 20; index += 1) {
      expect(
        (
          await limiter.reserve(
            'did:key:sensitive-subject',
            `event-${index}`,
            1_000
          )
        ).status
      ).toBe('reserved');
    }
    expect(
      (await limiter.reserve('did:key:sensitive-subject', 'event-20', 1_000))
        .status
    ).toBe('rate_limited');
    const keys = await backend.list('attestation-rate/v1/');
    expect(keys).toHaveLength(20);
    expect(keys.join('\n')).not.toContain('sensitive-subject');
    expect(keys.join('\n')).not.toContain('event-');
  });

  test('enforces a durable per-subject rolling-hour ceiling', async () => {
    const backend = new MemoryBackend();
    const first = new AttestationRateLimiter(backend, 2);
    expect((await first.reserve('subject', 'merge-a', 1_000)).status).toBe(
      'reserved'
    );
    expect((await first.reserve('subject', 'release-b', 2_000)).status).toBe(
      'reserved'
    );

    const reopened = new AttestationRateLimiter(backend, 2);
    expect((await reopened.reserve('subject', 'merge-c', 3_000)).status).toBe(
      'rate_limited'
    );
    expect((await reopened.reserve('other', 'merge-c', 3_000)).status).toBe(
      'reserved'
    );
  });

  test('expires the exact rolling-hour boundary and reports cleanup', async () => {
    const backend = new MemoryBackend();
    const limiter = new AttestationRateLimiter(backend, 1);
    await limiter.reserve('subject', 'first', 10_000);
    const boundary = await limiter.reserve(
      'subject',
      'second',
      10_000 + 60 * 60 * 1_000
    );
    expect(boundary).toMatchObject({ status: 'reserved', cleaned: 1 });
  });

  test('serializes concurrent reservations and releases capacity', async () => {
    const backend = new MemoryBackend();
    const limiter = new AttestationRateLimiter(backend, 1);
    const results = await Promise.all([
      limiter.reserve('subject', 'one', 1_000),
      limiter.reserve('subject', 'two', 1_000),
    ]);
    expect(
      results.filter((result) => result.status === 'reserved')
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rate_limited')
    ).toHaveLength(1);

    const reserved = results.find((result) => result.status === 'reserved');
    if (reserved?.status !== 'reserved') throw new Error('missing reservation');
    await limiter.release(reserved.key);
    expect((await limiter.reserve('subject', 'three', 1_001)).status).toBe(
      'reserved'
    );
  });

  test('fails closed on corrupt durable records', async () => {
    const backend = new MemoryBackend();
    const limiter = new AttestationRateLimiter(backend, 1);
    // Use the hash-derived prefix by first locating a real subject prefix.
    const probe = await limiter.reserve('subject', 'one', 1_000);
    if (probe.status !== 'reserved') throw new Error('missing probe');
    const [realKey] = await backend.list('attestation-rate/v1/');
    const subjectPrefix = realKey?.split('/').slice(0, 3).join('/');
    if (subjectPrefix === undefined) throw new Error('missing subject prefix');
    await backend.put(
      `${subjectPrefix}/corrupt`,
      encodeRecord({ issuedAt: 'not-a-number' })
    );
    expect(
      await rejectionMessage(limiter.reserve('subject', 'two', 2_000))
    ).toContain('stored attestation rate record is invalid');
  });
});
