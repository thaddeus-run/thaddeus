import {
  MAX_REPLAY_NONCE_CAPACITY,
  type ReplayNonceBackend,
} from '@thaddeus.run/store';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileBackend } from '../src/file';
import { MemoryBackend } from '../src/memory';

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-replay-nonce-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const key = (character: string): string => character.repeat(64);
const input = (
  nonceKey: string,
  now = 1_000,
  expiresAt = 2_000,
  capacity = 10
) => ({ key: nonceKey, now, expiresAt, capacity });

/** Asserts an asynchronous backend failure without matcher thenables. */
async function expectFailure(
  action: () => Promise<unknown>,
  message?: string
): Promise<void> {
  let rejection: unknown;
  try {
    await action();
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(Error);
  if (message !== undefined) {
    expect((rejection as Error).message).toContain(message);
  }
}

for (const [name, make] of [
  ['MemoryBackend', () => new MemoryBackend()],
  ['FileBackend', () => new FileBackend(mkdtempSync(join(tmp, 'contract-')))],
] as const) {
  describe(`${name} — ReplayNonceBackend contract`, () => {
    test('first consumption succeeds and a live duplicate is replayed', async () => {
      const backend = make();
      expect(await backend.consumeNonce(input(key('a')))).toEqual({
        status: 'consumed',
        activeCount: 1,
        cleanedCount: 0,
      });
      expect(await backend.consumeNonce(input(key('a')))).toEqual({
        status: 'replayed',
        activeCount: 1,
        cleanedCount: 0,
      });
    });

    test('concurrent identical calls yield exactly one consumption', async () => {
      const backend = make();
      const results = await Promise.all(
        Array.from({ length: 16 }, () => backend.consumeNonce(input(key('b'))))
      );
      expect(
        results.filter((result) => result.status === 'consumed')
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'replayed')
      ).toHaveLength(15);
    });

    test('different opaque keys are independent', async () => {
      const backend = make();
      expect((await backend.consumeNonce(input(key('c')))).status).toBe(
        'consumed'
      );
      expect((await backend.consumeNonce(input(key('d')))).status).toBe(
        'consumed'
      );
    });

    test('capacity fails closed with the earliest safe retry time', async () => {
      const backend = make();
      await backend.consumeNonce(input(key('e'), 1_000, 1_500, 1));
      expect(
        await backend.consumeNonce(input(key('f'), 1_000, 2_000, 1))
      ).toEqual({
        status: 'capacity',
        activeCount: 1,
        cleanedCount: 0,
        retryAt: 1_501,
      });
    });

    test('exact expiry remains live and one millisecond later is reusable', async () => {
      const backend = make();
      await backend.consumeNonce(input(key('1'), 1_000, 1_500, 1));
      expect(
        (await backend.consumeNonce(input(key('1'), 1_500, 2_000, 1))).status
      ).toBe('replayed');
      expect(
        await backend.consumeNonce(input(key('1'), 1_501, 2_000, 1))
      ).toEqual({
        status: 'consumed',
        activeCount: 1,
        cleanedCount: 1,
      });
    });

    test('cleanup restores capacity', async () => {
      const backend = make();
      await backend.consumeNonce(input(key('2'), 1_000, 1_100, 1));
      expect(
        await backend.consumeNonce(input(key('3'), 1_101, 2_000, 1))
      ).toEqual({
        status: 'consumed',
        activeCount: 1,
        cleanedCount: 1,
      });
    });

    test('invalid keys, times, and capacities fail closed', async () => {
      const backend: ReplayNonceBackend = make();
      for (const invalid of [
        input('not-a-key'),
        input(key('g')),
        input(key('a'), -1),
        input(key('a'), 1_001, 1_000),
        input(key('a'), 1_000, Number.NaN),
        input(key('a'), 1_000, 2_000, 0),
        input(key('a'), 1_000, 2_000, 1.5),
        input(key('a'), 1_000, 2_000, MAX_REPLAY_NONCE_CAPACITY + 1),
      ]) {
        await expectFailure(() => backend.consumeNonce(invalid));
      }
      expect((await backend.consumeNonce(input(key('a')))).status).toBe(
        'consumed'
      );
    });
  });
}

describe('FileBackend — durable replay nonce state', () => {
  test('a new instance rejects a previously consumed live nonce', async () => {
    const root = mkdtempSync(join(tmp, 'restart-'));
    await new FileBackend(root).consumeNonce(input(key('a')));
    expect(
      (await new FileBackend(root).consumeNonce(input(key('a')))).status
    ).toBe('replayed');
  });

  test('lowering capacity after restart stays closed until cleanup', async () => {
    const root = mkdtempSync(join(tmp, 'lower-'));
    const first = new FileBackend(root);
    await first.consumeNonce(input(key('a'), 1_000, 1_500, 2));
    await first.consumeNonce(input(key('b'), 1_000, 2_000, 2));

    const restarted = new FileBackend(root);
    expect(
      await restarted.consumeNonce(input(key('c'), 1_000, 3_000, 1))
    ).toMatchObject({ status: 'capacity', activeCount: 2, retryAt: 1_501 });
    expect(
      await restarted.consumeNonce(input(key('c'), 1_501, 3_000, 1))
    ).toMatchObject({ status: 'capacity', activeCount: 1, cleanedCount: 1 });
    expect(
      await restarted.consumeNonce(input(key('c'), 2_001, 3_000, 1))
    ).toMatchObject({ status: 'consumed', activeCount: 1, cleanedCount: 1 });
  });

  test('hidden nonce records never appear through generic list()', async () => {
    const root = mkdtempSync(join(tmp, 'hidden-'));
    const backend = new FileBackend(root);
    await backend.put('obj/visible', new Uint8Array([1]));
    await backend.consumeNonce(input(key('a')));
    expect(await backend.list('')).toEqual(['obj/visible']);
  });

  test('corrupt durable nonce records fail closed after restart', async () => {
    const root = mkdtempSync(join(tmp, 'corrupt-'));
    const nonceDir = join(root, '.replay-nonces-v1');
    mkdirSync(nonceDir, { recursive: true });
    writeFileSync(join(nonceDir, key('a')), '{"v":"wrong","expiresAt":2000}');

    const backend = new FileBackend(root);
    await expectFailure(
      () => backend.consumeNonce(input(key('b'))),
      'malformed record'
    );
    await expectFailure(
      () => backend.consumeNonce(input(key('b'))),
      'malformed record'
    );
  });
});
