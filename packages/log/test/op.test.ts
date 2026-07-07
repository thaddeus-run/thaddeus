import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { signOp, verifyOp } from '../src/op';

beforeAll(async () => {
  await ready();
});

const AT = '2026-07-07T12:00:00.000Z';

describe('Op record', () => {
  test('signOp produces a verifiable, id-bound record carrying the timestamp', () => {
    const author = Identity.create();
    const ref = { id: 'objid', plaintext_id: 'ptid' };
    const op = signOp(
      { path: 'a.ts', parents: [], lamport: 0, at: AT, payload: ref },
      author
    );
    expect(op.author).toBe(author.did);
    expect(op.at).toBe(AT);
    expect(op.id.length).toBeGreaterThan(0);
    expect(verifyOp(op)).toBe(true);
  });

  test('tampering with any field — including the timestamp — breaks verification', () => {
    const author = Identity.create();
    const op = signOp(
      { path: 'a.ts', parents: [], lamport: 0, at: AT, payload: null },
      author
    );
    expect(verifyOp({ ...op, path: 'b.ts' })).toBe(false);
    expect(verifyOp({ ...op, lamport: 1 })).toBe(false);
    expect(verifyOp({ ...op, at: '2026-01-01T00:00:00.000Z' })).toBe(false);
    expect(verifyOp({ ...op, id: `${op.id}0` })).toBe(false);
  });

  test('signOp rejects a non-ISO timestamp', () => {
    const author = Identity.create();
    expect(() =>
      signOp(
        {
          path: 'a.ts',
          parents: [],
          lamport: 0,
          at: 'not-a-date',
          payload: null,
        },
        author
      )
    ).toThrow();
  });

  test('verifyOp returns false (never throws) on malformed input', () => {
    const author = Identity.create();
    const op = signOp(
      { path: 'a.ts', parents: [], lamport: 0, at: AT, payload: null },
      author
    );
    expect(verifyOp({ ...op, author: 'did:key:not-a-real-key' })).toBe(false);
    expect(verifyOp({ ...op, sig: new Uint8Array([1, 2, 3]) })).toBe(false);
  });
});
