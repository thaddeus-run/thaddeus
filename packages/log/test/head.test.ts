import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  decodeHeadRecord,
  encodeHeadRecord,
  headId,
  signHead,
  verifyHead,
  verifyHeadChain,
  verifyHeadSnapshot,
} from '../src/head';
import { signOp } from '../src/op';

beforeAll(async () => {
  await ready();
});

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

describe('signed view head protocol', () => {
  test('signs, verifies, encodes, and produces deterministic ids', () => {
    const owner = Identity.create();
    const fields = {
      repo: 'r',
      view: 'main',
      version: 0,
      previous: null,
      heads: [A],
    } as const;
    const record = signHead(fields, owner);
    expect(verifyHead(record)).toEqual({ ok: true });
    expect(record.id).toBe(headId(fields, owner.did));
    expect(signHead(fields, owner).id).toBe(record.id);
    expect(decodeHeadRecord(encodeHeadRecord(record))).toEqual(record);
  });

  test('tampering with every signed field, id, owner, or signature fails', () => {
    const owner = Identity.create();
    const stranger = Identity.create();
    const record = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 0,
        previous: null,
        heads: [A],
      },
      owner
    );
    const bad = [
      { ...record, repo: 'x' },
      { ...record, view: 'other' },
      { ...record, heads: [B] },
      { ...record, id: B },
      { ...record, owner: stranger.did },
      { ...record, sig: new Uint8Array(record.sig).fill(0) },
    ];
    for (const changed of bad) {
      expect(verifyHead(changed).ok).toBe(false);
    }

    const next = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 1,
        previous: record.id,
        heads: [A],
      },
      owner
    );
    expect(verifyHead({ ...next, version: 2 }).ok).toBe(false);
    expect(verifyHead({ ...next, previous: B }).ok).toBe(false);
  });

  test('rejects malformed canonical fields and wire encodings', () => {
    const owner = Identity.create();
    const genesis = {
      repo: 'r',
      view: 'main',
      version: 0,
      previous: null,
      heads: [] as string[],
    };
    expect(() => signHead({ ...genesis, version: -1 }, owner)).toThrow();
    expect(() => signHead({ ...genesis, version: 0.5 }, owner)).toThrow();
    expect(() => signHead({ ...genesis, previous: A }, owner)).toThrow();
    expect(() =>
      signHead({ ...genesis, version: 1, previous: null }, owner)
    ).toThrow();
    expect(() => signHead({ ...genesis, heads: [B, A] }, owner)).toThrow();
    expect(() => signHead({ ...genesis, heads: [A, A] }, owner)).toThrow();
    expect(() => signHead({ ...genesis, heads: ['ABC'] }, owner)).toThrow();
    const wire = encodeHeadRecord(signHead(genesis, owner));
    expect(() =>
      decodeHeadRecord({ ...wire, sig: wire.sig.toUpperCase() })
    ).toThrow();
    expect(() => decodeHeadRecord({ ...wire, extra: true })).toThrow();
  });

  test('accepts a contiguous monotonic chain and rejects structural attacks', () => {
    const owner = Identity.create();
    const genesis = signHead(
      { repo: 'r', view: 'main', version: 0, previous: null, heads: [A] },
      owner
    );
    const next = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 1,
        previous: genesis.id,
        heads: [A, B],
      },
      owner
    );
    expect(
      verifyHeadChain([genesis, next], { repo: 'r', view: 'main' })
    ).toEqual({
      ok: true,
    });
    expect(
      verifyHeadChain([genesis], { prefix: [genesis, next] })
    ).toMatchObject({
      ok: false,
      code: 'rollback',
    });
    const fork = signHead(
      { ...next, previous: genesis.id, heads: [A, C] },
      owner
    );
    expect(
      verifyHeadChain([genesis, fork], { prefix: [genesis, next] })
    ).toMatchObject({
      ok: false,
      code: 'fork',
    });
    const gap = signHead({ ...next, version: 2 }, owner);
    expect(verifyHeadChain([genesis, gap])).toMatchObject({
      ok: false,
      code: 'gap',
    });
    const broken = signHead({ ...next, previous: B }, owner);
    expect(verifyHeadChain([genesis, broken])).toMatchObject({
      ok: false,
      code: 'broken_previous',
    });
    const dropped = signHead(
      { ...next, previous: genesis.id, heads: [] },
      owner
    );
    expect(verifyHeadChain([genesis, dropped])).toMatchObject({
      ok: false,
      code: 'dropped_heads',
    });
    expect(verifyHeadChain([genesis, next], { repo: 'other' })).toMatchObject({
      ok: false,
      code: 'wrong_repo',
    });
    expect(verifyHeadChain([genesis, next], { view: 'other' })).toMatchObject({
      ok: false,
      code: 'wrong_view',
    });
    expect(
      verifyHeadChain([genesis, next], { owner: Identity.create().did })
    ).toMatchObject({ ok: false, code: 'wrong_owner' });
  });

  test('snapshot verification requires the exact signed reachable closure', () => {
    const owner = Identity.create();
    const author = Identity.create();
    const root = signOp(
      {
        path: 'a',
        parents: [],
        lamport: 0,
        at: '2026-07-13T00:00:00.000Z',
        payload: null,
      },
      author
    );
    const child = signOp(
      {
        path: 'b',
        parents: [root.id],
        lamport: 1,
        at: '2026-07-13T00:00:01.000Z',
        payload: null,
      },
      author
    );
    const extra = signOp(
      {
        path: 'x',
        parents: [],
        lamport: 0,
        at: '2026-07-13T00:00:02.000Z',
        payload: null,
      },
      author
    );
    const head = signHead(
      {
        repo: 'r',
        view: 'main',
        version: 0,
        previous: null,
        heads: [child.id],
      },
      owner
    );
    expect(verifyHeadSnapshot(head, [root, child])).toEqual({ ok: true });
    expect(verifyHeadSnapshot(head, [root])).toMatchObject({
      ok: false,
      code: 'missing_operation',
    });
    expect(verifyHeadSnapshot(head, [child])).toMatchObject({
      ok: false,
      code: 'missing_operation',
    });
    expect(verifyHeadSnapshot(head, [root, child, extra])).toMatchObject({
      ok: false,
      code: 'extra_operation',
    });
    expect(verifyHeadSnapshot(head, [root, child, child])).toMatchObject({
      ok: false,
      code: 'duplicate_operation',
    });
    expect(
      verifyHeadSnapshot(head, [root, { ...child, path: 'forged' }])
    ).toMatchObject({
      ok: false,
      code: 'invalid_operation',
    });
  });
});
