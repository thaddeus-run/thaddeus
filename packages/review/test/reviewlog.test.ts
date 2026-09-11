import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { beforeAll, expect, test } from 'bun:test';

import {
  DEFAULT_REVIEW_LIMITS,
  reviewerCapabilityId,
  ReviewLog,
  signReviewerCapability,
  signReviewRevocation,
  signScopedVeto,
  signVeto,
  signVetoWithdrawal,
  verifyVeto,
  vetoId,
} from '../src';
beforeAll(ready);
const at = '2026-07-01T00:00:00Z';
function setup(backend = new MemoryBackend()) {
  const owner = Identity.create();
  const reviewer = Identity.create();
  const log = new ReviewLog('repo', owner.did, backend);
  const cap = signReviewerCapability(
    {
      repo: 'repo',
      reviewer: reviewer.did,
      paths: ['src/**'],
      at,
      nonce: 'one',
      maxVetoesPerHour: 2,
      maxActiveVetoes: 2,
    },
    owner
  );
  const veto = (op = 'op', grant = reviewerCapabilityId(cap)) =>
    signScopedVeto({ repo: 'repo', grant, op, reason: 'no', at }, reviewer);
  return { owner, reviewer, log, cap, veto, backend };
}
test('v2 binds repo and grant, and cannot be downgraded', () => {
  const { veto } = setup();
  const v = veto();
  expect(verifyVeto(v)).toBe(true);
  expect(verifyVeto({ ...v, repo: 'other' })).toBe(false);
  const { repo: _, grant: __, ...legacy } = v;
  expect(verifyVeto(legacy)).toBe(false);
  expect(verifyVeto({ ...v, grant: undefined })).toBe(false);
});
test('scope, owner legacy role, dedup, revocation, withdrawal and restart', async () => {
  const { owner, reviewer, log, cap, veto, backend } = setup();
  await log.grant(cap);
  const v = veto();
  const op = { id: 'op', path: 'src/a' };
  expect(
    await log.submit(v, reviewer.did, op, 1000, DEFAULT_REVIEW_LIMITS)
  ).toBe(true);
  expect(
    await log.submit(v, reviewer.did, op, 1001, DEFAULT_REVIEW_LIMITS)
  ).toBe(false);
  for (const path of [
    'src/../a',
    'src//a',
    '/src/a',
    'src\\a',
    'src/./a',
    'other/a',
  ])
    await rejects(
      log.submit(
        veto('bad'),
        reviewer.did,
        { id: 'bad', path },
        1002,
        DEFAULT_REVIEW_LIMITS
      )
    );
  expect(
    log.status(signVeto({ op: 'op', reason: 'no', at }, reviewer), op)
  ).toBe('legacy');
  expect(log.status(signVeto({ op: 'op', reason: 'no', at }, owner), op)).toBe(
    'active'
  );
  await log.revoke(
    signReviewRevocation(
      { repo: 'repo', grant: reviewerCapabilityId(cap), reason: 'stop', at },
      owner
    )
  );
  expect(log.status(v, op)).toBe('revoked');
  await rejects(log.submit(v, reviewer.did, op, 1003, DEFAULT_REVIEW_LIMITS));
  await log.withdraw(
    signVetoWithdrawal(
      { repo: 'repo', veto: vetoId(v), reason: 'withdraw', at },
      reviewer
    )
  );
  expect(log.status(v, op)).toBe('withdrawn');
  const reopened = await ReviewLog.load(backend, 'repo', owner.did);
  expect(reopened.status(v, op)).toBe('withdrawn');
  expect(reopened.grants()).toHaveLength(0);
});
test('trusted receipts and active counts survive restart and grant rotation', async () => {
  const { owner, reviewer, log, cap, veto, backend } = setup();
  await log.grant(cap);
  await log.submit(
    veto('a'),
    reviewer.did,
    { id: 'a', path: 'src/a' },
    1000,
    DEFAULT_REVIEW_LIMITS
  );
  await log.submit(
    veto('b'),
    reviewer.did,
    { id: 'b', path: 'src/a' },
    1001,
    DEFAULT_REVIEW_LIMITS
  );
  const reopened = await ReviewLog.load(backend, 'repo', owner.did);
  await rejects(
    reopened.submit(
      veto('c'),
      reviewer.did,
      { id: 'c', path: 'src/a' },
      1002,
      DEFAULT_REVIEW_LIMITS
    )
  );
  await reopened.withdraw(
    signVetoWithdrawal(
      { repo: 'repo', veto: vetoId(veto('a')), reason: 'ok', at },
      owner
    )
  );
  await rejects(
    reopened.submit(
      veto('c'),
      reviewer.did,
      { id: 'c', path: 'src/a' },
      1003,
      DEFAULT_REVIEW_LIMITS
    )
  );
  expect(
    await reopened.submit(
      veto('c'),
      reviewer.did,
      { id: 'c', path: 'src/a' },
      3601000,
      DEFAULT_REVIEW_LIMITS
    )
  ).toBe(true);
});
test('corruption fails closed and public projections cannot mutate authority', async () => {
  const { owner, reviewer, log, cap, veto, backend } = setup();
  await log.grant(cap);
  (cap.paths as string[]).push('**');
  (log.grants()[0].paths as string[]).push('**');
  await rejects(
    log.submit(
      veto(),
      reviewer.did,
      { id: 'op', path: 'other/a' },
      1,
      DEFAULT_REVIEW_LIMITS
    )
  );
  await backend.put('review/corrupt', new Uint8Array([1]));
  await rejects(ReviewLog.load(backend, 'repo', owner.did));
});
test('failed persistence leaves grant and veto projections unchanged', async () => {
  const { owner, reviewer, cap, veto } = setup();
  const backend = new MemoryBackend();
  const failing = {
    put: () => Promise.reject(new Error('disk unavailable')),
    get: backend.get.bind(backend),
    list: backend.list.bind(backend),
    delete: backend.delete.bind(backend),
    openScan: backend.openScan.bind(backend),
  };
  const log = new ReviewLog('repo', owner.did, failing);
  await rejects(log.grant(cap), 'disk unavailable');
  expect(log.grants()).toHaveLength(0);
  const stable = new ReviewLog('repo', owner.did, backend);
  await stable.grant(cap);
  backend.put = () => Promise.reject(new Error('disk unavailable'));
  await rejects(
    stable.submit(
      veto(),
      reviewer.did,
      { id: 'op', path: 'src/a' },
      1,
      DEFAULT_REVIEW_LIMITS
    ),
    'disk unavailable'
  );
  expect(stable.vetoes()).toHaveLength(0);
});
test('terminal revocation survives replay before grant, replacement keeps DID usage', async () => {
  const { owner, reviewer, log, cap, veto } = setup();
  await log.grant(cap);
  await log.submit(veto(), reviewer.did, { id: 'op', path: 'src/a' }, 10, {
    maxVetoesPerHour: 1,
    maxActiveVetoes: 10,
  });
  const revocation = signReviewRevocation(
    { repo: 'repo', grant: reviewerCapabilityId(cap), reason: 'stop', at },
    owner
  );
  await log.revoke(revocation);
  await rejects(log.grant(cap));
  const replacement = signReviewerCapability({ ...cap, nonce: 'two' }, owner);
  await log.grant(replacement);
  await rejects(
    log.submit(
      veto('next', reviewerCapabilityId(replacement)),
      reviewer.did,
      { id: 'next', path: 'src/a' },
      11,
      { maxVetoesPerHour: 1, maxActiveVetoes: 10 }
    )
  );
  const offline = new ReviewLog('repo', owner.did);
  await offline.import({ kind: 'revoke', revocation });
  await offline.import({ kind: 'grant', capability: cap });
  expect(offline.grants()).toHaveLength(0);
});
test('wrong owner cannot issue grants, revocations, or dismiss another reviewer', async () => {
  const { reviewer, log, cap, veto } = setup();
  await log.grant(cap);
  const other = Identity.create();
  await rejects(
    log.grant(signReviewerCapability({ ...cap, nonce: 'bad' }, other))
  );
  await rejects(
    log.revoke(
      signReviewRevocation(
        { repo: 'repo', grant: reviewerCapabilityId(cap), reason: 'bad', at },
        reviewer
      )
    )
  );
  await log.submit(
    veto(),
    reviewer.did,
    { id: 'op', path: 'src/a' },
    10,
    DEFAULT_REVIEW_LIMITS
  );
  await rejects(
    log.withdraw(
      signVetoWithdrawal(
        { repo: 'repo', veto: vetoId(veto()), reason: 'bad', at },
        other
      )
    )
  );
  const events = [...log.events()];
  const grant = events.find((e) => e.kind === 'grant')!;
  if (grant.kind === 'grant') grant.capability.sig.fill(0);
  expect(log.grants()[0].sig.some((x) => x !== 0)).toBe(true);
});
test('offline replay tolerates withdrawal and veto before their grant', async () => {
  const { owner, reviewer, cap, veto } = setup();
  const log = new ReviewLog('repo', owner.did);
  const v = veto();
  await log.import({
    kind: 'withdraw',
    withdrawal: signVetoWithdrawal(
      { repo: 'repo', veto: vetoId(v), reason: 'gone', at },
      reviewer
    ),
  });
  await log.import({ kind: 'veto', veto: v, receivedAt: 1 });
  await log.import({ kind: 'grant', capability: cap });
  expect(log.status(v, { id: 'op', path: 'src/a' })).toBe('withdrawn');
});
test('owner can dismiss a legacy veto absent from the new log', async () => {
  const { owner, log } = setup();
  const v = signVeto({ op: 'old', reason: 'old veto', at }, owner);
  await log.withdraw(
    signVetoWithdrawal(
      { repo: 'repo', veto: vetoId(v), reason: 'dismiss', at },
      owner
    )
  );
  expect(log.status(v, { id: 'old', path: 'src/a' })).toBe('withdrawn');
});
test('an unrelated pending withdrawal never dismisses its eventual target', async () => {
  const { log, reviewer, cap, veto } = setup();
  const attacker = Identity.create();
  const v = veto();
  await log.import({
    kind: 'withdraw',
    withdrawal: signVetoWithdrawal(
      { repo: 'repo', veto: vetoId(v), reason: 'forged authority', at },
      attacker
    ),
  });
  await log.grant(cap);
  await log.submit(
    v,
    reviewer.did,
    { id: 'op', path: 'src/a' },
    1,
    DEFAULT_REVIEW_LIMITS
  );
  expect(log.status(v, { id: 'op', path: 'src/a' })).toBe('active');
});

// Await rejected operations explicitly because Bun's matcher type returns void.
async function rejects(
  promise: Promise<unknown>,
  message?: string
): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  if (message !== undefined)
    expect((error as Error).message).toContain(message);
}
test('active budget is shared across grants and owner limits also apply', async () => {
  const { owner, reviewer, log, cap, veto } = setup();
  await log.grant(cap);
  const limits = { maxVetoesPerHour: 20, maxActiveVetoes: 1 };
  await log.submit(
    veto(),
    reviewer.did,
    { id: 'op', path: 'src/a' },
    1,
    limits
  );
  const replacement = signReviewerCapability(
    { ...cap, nonce: 'another' },
    owner
  );
  await log.grant(replacement);
  await rejects(
    log.submit(
      veto('next', reviewerCapabilityId(replacement)),
      reviewer.did,
      { id: 'next', path: 'src/a' },
      2,
      limits
    ),
    'active veto limit'
  );
  await log.withdraw(
    signVetoWithdrawal(
      { repo: 'repo', veto: vetoId(veto()), reason: 'release', at },
      reviewer
    )
  );
  expect(
    await log.submit(
      veto('next', reviewerCapabilityId(replacement)),
      reviewer.did,
      { id: 'next', path: 'src/a' },
      3,
      limits
    )
  ).toBe(true);
  const owned = (id: string) =>
    signScopedVeto(
      { repo: 'repo', grant: 'owner', op: id, reason: 'no', at },
      owner
    );
  await log.submit(
    owned('owner-a'),
    owner.did,
    { id: 'owner-a', path: 'outside/a' },
    4,
    limits
  );
  await rejects(
    log.submit(
      owned('owner-b'),
      owner.did,
      { id: 'owner-b', path: 'outside/a' },
      5,
      limits
    ),
    'active veto limit'
  );
});
test('network withdrawal rejects unknown reviewer targets and deduplicates changed reason', async () => {
  const { reviewer, log, cap, veto } = setup();
  const v = veto();
  const withdrawal = signVetoWithdrawal(
    { repo: 'repo', veto: vetoId(v), reason: 'first', at },
    reviewer
  );
  await rejects(log.withdraw(withdrawal));
  await log.grant(cap);
  await log.submit(
    v,
    reviewer.did,
    { id: 'op', path: 'src/a' },
    1,
    DEFAULT_REVIEW_LIMITS
  );
  await log.withdraw(withdrawal);
  await log.withdraw(
    signVetoWithdrawal(
      { repo: 'repo', veto: vetoId(v), reason: 'different', at: 'later' },
      reviewer
    )
  );
  expect([...log.events()].filter((e) => e.kind === 'withdraw')).toHaveLength(
    1
  );
});

test('pending offline veto and unrelated withdrawal replay remain inert across reload', async () => {
  const { owner, reviewer, cap, veto } = setup();
  const backend = new MemoryBackend();
  const log = new ReviewLog('repo', owner.did, backend);
  const v = veto();
  const op = { id: 'op', path: 'src/a' };
  await log.import({ kind: 'veto', veto: v, receivedAt: 1 });
  const pending = await ReviewLog.load(backend, 'repo', owner.did);
  expect(pending.status(v, op)).toBe('unauthorized');
  const unrelated = signVetoWithdrawal(
    { repo: 'repo', veto: vetoId(v), reason: 'unrelated', at },
    Identity.create()
  );
  await pending.import({ kind: 'withdraw', withdrawal: unrelated });
  await pending.grant(cap);
  expect(pending.status(v, op)).toBe('active');
  const restored = await ReviewLog.load(backend, 'repo', owner.did);
  expect(restored.status(v, op)).toBe('active');
  await restored.withdraw(
    signVetoWithdrawal(
      { repo: 'repo', veto: vetoId(v), reason: 'resolved', at },
      reviewer
    )
  );
  expect((await ReviewLog.load(backend, 'repo', owner.did)).status(v, op)).toBe(
    'withdrawn'
  );
});

test('owner authority marker cannot be revoked to reset active accounting', async () => {
  const { owner, log } = setup();
  const make = (op: string) =>
    signScopedVeto(
      { repo: 'repo', grant: 'owner', op, reason: 'unsafe', at },
      owner
    );
  const limits = { maxVetoesPerHour: 10, maxActiveVetoes: 1 };
  await log.submit(make('a'), owner.did, { id: 'a', path: 'src/a' }, 1, limits);
  await rejects(
    log.revoke(
      signReviewRevocation(
        { repo: 'repo', grant: 'owner', reason: 'reset', at },
        owner
      )
    )
  );
  await rejects(
    log.submit(make('b'), owner.did, { id: 'b', path: 'src/b' }, 2, limits),
    'active veto limit'
  );
});

test('pending evidence that later names a different grantee stays unauthorized after reload', async () => {
  const { owner, cap, backend } = setup();
  const attacker = Identity.create();
  const log = new ReviewLog('repo', owner.did, backend);
  const veto = signScopedVeto(
    {
      repo: 'repo',
      grant: reviewerCapabilityId(cap),
      op: 'op',
      reason: 'forged authority',
      at,
    },
    attacker
  );
  await log.import({ kind: 'veto', veto, receivedAt: 1 });
  await log.import({ kind: 'grant', capability: cap });
  const op = { id: 'op', path: 'src/a' };
  expect(log.status(veto, op)).toBe('unauthorized');
  expect(
    (await ReviewLog.load(backend, 'repo', owner.did)).status(veto, op)
  ).toBe('unauthorized');
});

test('clock rollback cannot reopen a pruned receipt window, including after restart', async () => {
  const { owner, reviewer, log, cap, veto, backend } = setup();
  await log.grant(cap);
  const limits = { maxVetoesPerHour: 1, maxActiveVetoes: 10 };
  await log.submit(
    veto('old'),
    reviewer.did,
    { id: 'old', path: 'src/a' },
    1,
    limits
  );
  await log.submit(
    veto('new'),
    reviewer.did,
    { id: 'new', path: 'src/b' },
    3600001,
    limits
  );
  for (const current of [
    log,
    await ReviewLog.load(backend, 'repo', owner.did),
  ]) {
    await rejects(
      current.submit(
        veto('rollback'),
        reviewer.did,
        { id: 'rollback', path: 'src/c' },
        2,
        limits
      ),
      'server clock'
    );
    await rejects(
      current.submit(
        veto('limited'),
        reviewer.did,
        { id: 'limited', path: 'src/c' },
        3600002,
        limits
      ),
      'hourly'
    );
  }
});

test('load distinguishes malformed bytes from content-address corruption', async () => {
  const { owner, log, cap, backend } = setup();
  await log.grant(cap);
  const key = (await backend.list('review/'))[0];
  const bytes = (await backend.get(key))!;
  await backend.put('review/wrong-address', bytes);
  await rejects(
    ReviewLog.load(backend, 'repo', owner.did),
    'review content address mismatch'
  );
  await backend.delete('review/wrong-address');
  await backend.put('review/malformed', new Uint8Array([255]));
  await rejects(
    ReviewLog.load(backend, 'repo', owner.did),
    'cannot decode review event'
  );
});
