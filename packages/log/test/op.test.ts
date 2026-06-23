import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { signOp, verifyOp } from '../src/op';

beforeAll(async () => {
  await ready();
});

describe('Op record', () => {
  test('signOp produces a verifiable, id-bound record', () => {
    const author = Identity.create();
    const ref = { id: 'objid', plaintext_id: 'ptid' };
    const op = signOp(
      { path: 'a.ts', parents: [], lamport: 0, payload: ref },
      author
    );
    expect(op.author).toBe(author.did);
    expect(op.id.length).toBeGreaterThan(0);
    expect(verifyOp(op)).toBe(true);
  });

  test('tampering with any field breaks verification', () => {
    const author = Identity.create();
    const op = signOp(
      { path: 'a.ts', parents: [], lamport: 0, payload: null },
      author
    );
    expect(verifyOp({ ...op, path: 'b.ts' })).toBe(false);
    expect(verifyOp({ ...op, lamport: 1 })).toBe(false);
    expect(verifyOp({ ...op, id: `${op.id}0` })).toBe(false);
  });
});
