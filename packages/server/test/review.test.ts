import { signDelegation } from '@thaddeus.run/agent';
import { Identity, ready } from '@thaddeus.run/identity';
import {
  decodeHeadRecord,
  type HeadRecordWire,
  OpLog,
} from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import {
  type ReviewerCapability,
  reviewerCapabilityId,
  signReviewerCapability,
  signReviewRevocation,
  signScopedVeto,
  signVeto,
  signVetoWithdrawal,
  type Veto,
  vetoId,
  VetoLog,
} from '@thaddeus.run/review';
import { MemoryStore, scoped } from '@thaddeus.run/store';
import { beforeAll, expect, test } from 'bun:test';

import { encodeBundle, encodeDelegation, encodeReviewRecord } from '../src/dto';
import { createServer } from '../src/server';
import { signRequest } from '../src/sign';
import { createRepoBody, landBody } from './heads';

beforeAll(ready);
type Result = {
  accepted: { veto: number };
  rejected: { reason: string }[];
  landed: boolean;
  records: { status?: string }[];
  recalled: { accepted: { veto: number } };
};

const at = '2026-09-11T12:00:00.000Z';
function signed(path: string, value: unknown, signer: Identity): Request {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const h = signRequest('POST', path, body, signer, at);
  return new Request(`http://t${path}`, {
    method: 'POST',
    body,
    headers: {
      'x-thaddeus-did': h.did,
      'x-thaddeus-timestamp': h.timestamp,
      'x-thaddeus-nonce': h.nonce,
      'x-thaddeus-signature': h.signature,
    },
  });
}

// A valid owner operation isolates authorization failures from signature failures.
async function fixture() {
  const owner = Identity.create();
  const reviewer = Identity.create();
  const backend = new MemoryBackend();
  const srv = createServer({ backend, now: () => at });
  expect(
    (await srv.fetch(signed('/repos', createRepoBody('r', owner), owner)))
      .status
  ).toBe(201);
  const log = new OpLog(new MemoryStore());
  const op = await log.write(
    'main',
    'src/auth.ts',
    new TextEncoder().encode('safe'),
    owner
  );
  expect(
    (
      await srv.fetch(
        signed('/repos/r/push', encodeBundle([op], [], []), owner)
      )
    ).status
  ).toBe(200);
  return { owner, reviewer, backend, srv, op };
}

test('THA-24: a docs writer cannot veto owner src ops, including across revoke and restart', async () => {
  const { owner, reviewer, backend, srv, op } = await fixture();
  const delegation = signDelegation(
    { agent: reviewer.did, paths: ['docs/**'], maxChanges: 10, maxSpend: 10 },
    owner
  );
  expect(
    (
      await srv.fetch(
        signed(
          '/repos/r/grants',
          { delegation: encodeDelegation(delegation) },
          owner
        )
      )
    ).status
  ).toBe(200);
  const veto = signVeto({ op: op.id, reason: 'deny service', at }, reviewer);
  const res = await srv.fetch(
    signed('/repos/r/push', encodeBundle([], [], [], [], [veto]), reviewer)
  );
  const result = (await res.json()) as Result;
  expect(result.accepted.veto).toBe(0);
  expect(result.rejected).toHaveLength(1);
  await srv.fetch(signed('/repos/r/revoke', { agent: reviewer.did }, owner));
  const restarted = createServer({ backend, now: () => at });
  const landed = await restarted.fetch(
    signed(
      '/repos/r/land',
      await landBody(restarted.fetch, 'r', [op.id], owner),
      owner
    )
  );
  expect(((await landed.json()) as Result).landed).toBe(true);
});

// Management records remain owner signed even inside an authenticated request.
function capability(
  owner: Identity,
  reviewer: Identity,
  paths = ['src/**'],
  nonce = 'one'
) {
  return signReviewerCapability(
    {
      repo: 'r',
      reviewer: reviewer.did,
      paths,
      nonce,
      at,
      maxVetoesPerHour: 60,
      maxActiveVetoes: 256,
    },
    owner
  );
}
async function grantReview(
  srv: ReturnType<typeof createServer>,
  owner: Identity,
  cap: ReviewerCapability
) {
  const res = await srv.fetch(
    signed('/repos/r/reviewers', { capability: encodeReviewRecord(cap) }, owner)
  );
  expect(res.status).toBe(200);
  return reviewerCapabilityId(cap);
}
function scopedVeto(
  op: string,
  grant: string,
  reviewer: Identity,
  reason = 'unsafe'
) {
  return signScopedVeto({ repo: 'r', grant, op, reason, at }, reviewer);
}
async function submit(
  srv: ReturnType<typeof createServer>,
  veto: Veto,
  signer: Identity
) {
  return (await (
    await srv.fetch(
      signed(
        '/repos/r/vetoes',
        { veto: encodeBundle([], [], [], [], [veto]).veto },
        signer
      )
    )
  ).json()) as Result;
}
async function land(
  srv: ReturnType<typeof createServer>,
  op: string,
  owner: Identity
) {
  return (await (
    await srv.fetch(
      signed(
        '/repos/r/land',
        await landBody(srv.fetch, 'r', [op], owner),
        owner
      )
    )
  ).json()) as Result;
}

test('outside reviewer can veto but cannot push, land, grant or exceed review scope', async () => {
  const { owner, reviewer, srv, op } = await fixture();
  const grant = await grantReview(srv, owner, capability(owner, reviewer));
  expect(
    (await submit(srv, scopedVeto(op.id, grant, reviewer), reviewer)).accepted
      .veto
  ).toBe(1);
  expect((await land(srv, op.id, owner)).landed).toBe(false);
  expect(
    (
      await srv.fetch(
        signed('/repos/r/push', encodeBundle([op], [], []), reviewer)
      )
    ).status
  ).toBe(403);
  expect(
    (
      await srv.fetch(
        signed(
          '/repos/r/land',
          await landBody(srv.fetch, 'r', [op.id], owner),
          reviewer
        )
      )
    ).status
  ).toBe(403);
  expect(
    (
      await srv.fetch(
        signed(
          '/repos/r/reviewers',
          { capability: encodeReviewRecord(capability(owner, reviewer)) },
          reviewer
        )
      )
    ).status
  ).toBe(403);
  const docsGrant = await grantReview(
    srv,
    owner,
    capability(owner, reviewer, ['docs/**'], 'docs')
  );
  expect(
    (await submit(srv, scopedVeto(op.id, docsGrant, reviewer), reviewer))
      .accepted.veto
  ).toBe(0);
});

test('review revoke disables durable vetoes; a fresh grant does not resurrect them', async () => {
  const { owner, reviewer, backend, srv, op } = await fixture();
  const grant = await grantReview(srv, owner, capability(owner, reviewer));
  const veto = scopedVeto(op.id, grant, reviewer);
  await submit(srv, veto, reviewer);
  const revocation = signReviewRevocation(
    { repo: 'r', grant, reason: 'access ended', at },
    owner
  );
  expect(
    (
      await srv.fetch(
        signed(
          '/repos/r/reviewer-revocations',
          { revocation: encodeReviewRecord(revocation) },
          owner
        )
      )
    ).status
  ).toBe(200);
  const restarted = createServer({ backend, now: () => at });
  await grantReview(
    restarted,
    owner,
    capability(owner, reviewer, ['src/**'], 'two')
  );
  expect((await submit(restarted, veto, reviewer)).accepted.veto).toBe(0);
  expect((await land(restarted, op.id, owner)).landed).toBe(true);
  const history = (await (
    await restarted.fetch(new Request('http://t/repos/r/vetoes'))
  ).json()) as Result;
  expect(
    history.records.some((r: { status?: string }) => r.status === 'revoked')
  ).toBe(true);
});

test('withdrawal is durable, cannot be undone by duplicate upload, and preserves history', async () => {
  const { owner, reviewer, backend, srv, op } = await fixture();
  const grant = await grantReview(srv, owner, capability(owner, reviewer));
  const veto = scopedVeto(op.id, grant, reviewer);
  await submit(srv, veto, reviewer);
  const withdrawal = signVetoWithdrawal(
    { repo: 'r', veto: vetoId(veto), reason: 'resolved', at },
    reviewer
  );
  expect(
    (
      await srv.fetch(
        signed(
          '/repos/r/veto-withdrawals',
          { withdrawal: encodeReviewRecord(withdrawal) },
          reviewer
        )
      )
    ).status
  ).toBe(200);
  const restarted = createServer({ backend, now: () => at });
  expect((await submit(restarted, veto, reviewer)).accepted.veto).toBe(0);
  expect((await land(restarted, op.id, owner)).landed).toBe(true);
});

test('request signer, target, repository, and review payload cannot be substituted', async () => {
  const { owner, reviewer, srv, op } = await fixture();
  const grant = await grantReview(srv, owner, capability(owner, reviewer));
  const veto = scopedVeto(op.id, grant, reviewer);
  expect((await submit(srv, veto, owner)).accepted.veto).toBe(0);
  expect(
    (await submit(srv, scopedVeto('absent', grant, reviewer), reviewer))
      .accepted.veto
  ).toBe(0);
  expect(
    (await submit(srv, { ...veto, reason: 'tampered' }, reviewer)).accepted.veto
  ).toBe(0);
  expect(
    (
      await submit(
        srv,
        signScopedVeto(
          { repo: 'other', grant, op: op.id, reason: 'x', at },
          reviewer
        ),
        reviewer
      )
    ).accepted.veto
  ).toBe(0);
  expect(
    (
      await srv.fetch(
        signed(
          '/repos/r/vetoes',
          { veto: encodeBundle([], [], [], [], [veto]).veto, ops: [op] },
          reviewer
        )
      )
    ).status
  ).toBe(400);
  const recalled = (await (
    await srv.fetch(
      signed(
        '/repos/r/revoke',
        {
          agent: Identity.create().did,
          recall: encodeBundle([], [], [], [], [veto]),
        },
        owner
      )
    )
  ).json()) as Result;
  expect(recalled.recalled.accepted.veto).toBe(0);
  expect((await land(srv, op.id, owner)).landed).toBe(true);
});

test('review scope may exceed write scope and write revocation leaves review authority intact', async () => {
  const { owner, reviewer, srv, op } = await fixture();
  const delegation = signDelegation(
    { agent: reviewer.did, paths: ['docs/**'], maxChanges: 10, maxSpend: 10 },
    owner
  );
  await srv.fetch(
    signed(
      '/repos/r/grants',
      { delegation: encodeDelegation(delegation) },
      owner
    )
  );
  const grant = await grantReview(srv, owner, capability(owner, reviewer));
  await srv.fetch(signed('/repos/r/revoke', { agent: reviewer.did }, owner));
  expect(
    (await submit(srv, scopedVeto(op.id, grant, reviewer), reviewer)).accepted
      .veto
  ).toBe(1);
  expect((await land(srv, op.id, owner)).landed).toBe(false);
});

test('rate limits survive restart and retries consume no additional budget', async () => {
  const f = await fixture();
  const srv = createServer({
    backend: f.backend,
    now: () => at,
    reviewLimits: { maxVetoesPerHour: 1 },
  });
  const grant = await grantReview(
    srv,
    f.owner,
    capability(f.owner, f.reviewer)
  );
  const veto = scopedVeto(f.op.id, grant, f.reviewer);
  expect((await submit(srv, veto, f.reviewer)).accepted.veto).toBe(1);
  expect((await submit(srv, veto, f.reviewer)).accepted.veto).toBe(1);
  const restarted = createServer({
    backend: f.backend,
    now: () => at,
    reviewLimits: { maxVetoesPerHour: 1 },
  });
  const limited = await submit(
    restarted,
    scopedVeto(f.op.id, grant, f.reviewer, 'another reason'),
    f.reviewer
  );
  expect(limited.accepted.veto).toBe(0);
  expect(limited.rejected[0].reason).toContain('rate');
  const withdrawal = signVetoWithdrawal(
    { repo: 'r', veto: vetoId(veto), reason: 'clear', at },
    f.owner
  );
  expect(
    (
      await restarted.fetch(
        signed(
          '/repos/r/veto-withdrawals',
          { withdrawal: encodeReviewRecord(withdrawal) },
          f.owner
        )
      )
    ).status
  ).toBe(200);
});

test('upgrades preserve owner v1 vetoes and ignore outsider v1 even after granting review', async () => {
  const { owner, reviewer, backend, op } = await fixture();
  const legacy = new VetoLog(scoped(backend, 'repo/r/'));
  await legacy.ingest(
    signVeto({ op: op.id, reason: 'old outsider veto', at }, reviewer)
  );
  const restarted = createServer({ backend, now: () => at });
  await grantReview(restarted, owner, capability(owner, reviewer));
  expect((await land(restarted, op.id, owner)).landed).toBe(true);
  const other = await fixture();
  const ownerVeto = signVeto(
    { op: other.op.id, reason: 'old owner veto', at },
    other.owner
  );
  await new VetoLog(scoped(other.backend, 'repo/r/')).ingest(ownerVeto);
  const loaded = createServer({ backend: other.backend, now: () => at });
  expect((await land(loaded, other.op.id, other.owner)).landed).toBe(false);
  const withdrawal = signVetoWithdrawal(
    { repo: 'r', veto: vetoId(ownerVeto), reason: 'clear legacy', at },
    other.owner
  );
  expect(
    (
      await loaded.fetch(
        signed(
          '/repos/r/veto-withdrawals',
          { withdrawal: encodeReviewRecord(withdrawal) },
          other.owner
        )
      )
    ).status
  ).toBe(200);
  expect((await land(loaded, other.op.id, other.owner)).landed).toBe(true);
});

test('batch limits, forged management, and unaffiliated withdrawals fail without persisting authority', async () => {
  const f = await fixture();
  const srv = createServer({
    backend: f.backend,
    now: () => at,
    reviewLimits: { maxVetoesPerRequest: 1 },
  });
  const cap = capability(f.owner, f.reviewer);
  const grant = await grantReview(srv, f.owner, cap);
  const veto = scopedVeto(f.op.id, grant, f.reviewer);
  const batch = await srv.fetch(
    signed(
      '/repos/r/vetoes',
      { veto: encodeBundle([], [], [], [], [veto, veto]).veto },
      f.reviewer
    )
  );
  expect(batch.status).toBe(413);
  const invalidCap = { ...cap, paths: ['**'] };
  expect(
    (
      await srv.fetch(
        signed(
          '/repos/r/reviewers',
          { capability: encodeReviewRecord(invalidCap) },
          f.owner
        )
      )
    ).status
  ).toBe(403);
  const stranger = Identity.create();
  const withdrawal = signVetoWithdrawal(
    { repo: 'r', veto: vetoId(veto), reason: 'unauthorized', at },
    stranger
  );
  expect(
    (
      await srv.fetch(
        signed(
          '/repos/r/veto-withdrawals',
          { withdrawal: encodeReviewRecord(withdrawal) },
          stranger
        )
      )
    ).status
  ).toBe(403);
  const history = (await (
    await srv.fetch(new Request('http://t/repos/r/vetoes'))
  ).json()) as Result;
  expect(history.records).toHaveLength(1);
  expect((await land(srv, f.op.id, f.owner)).landed).toBe(true);
});

test('concurrent revoke and submit cannot leave a veto active after revocation', async () => {
  const { owner, reviewer, srv, op } = await fixture();
  const grant = await grantReview(srv, owner, capability(owner, reviewer));
  const veto = scopedVeto(op.id, grant, reviewer);
  const revocation = signReviewRevocation(
    { repo: 'r', grant, reason: 'end access', at },
    owner
  );
  const [result, revoked] = await Promise.all([
    submit(srv, veto, reviewer),
    srv.fetch(
      signed(
        '/repos/r/reviewer-revocations',
        { revocation: encodeReviewRecord(revocation) },
        owner
      )
    ),
  ]);
  expect([0, 1]).toContain(result.accepted.veto);
  expect(revoked.status).toBe(200);
  expect((await submit(srv, veto, reviewer)).accepted.veto).toBe(0);
  expect((await land(srv, op.id, owner)).landed).toBe(true);
});

test('land and veto are serialized; a later veto never rewrites a landed head', async () => {
  const { owner, reviewer, srv, op } = await fixture();
  const grant = await grantReview(srv, owner, capability(owner, reviewer));
  const veto = scopedVeto(op.id, grant, reviewer);
  const [landed, submitted] = await Promise.all([
    land(srv, op.id, owner),
    submit(srv, veto, reviewer),
  ]);
  expect(submitted.accepted.veto).toBe(1);
  const view = (await (
    await srv.fetch(new Request('http://t/repos/r/views/main'))
  ).json()) as { head: HeadRecordWire };
  expect(decodeHeadRecord(view.head).heads).toEqual(
    landed.landed ? [op.id] : []
  );
  const after = await land(srv, op.id, owner);
  expect(after.landed).toBe(landed.landed);
});

for (const failRollback of [false, true]) {
  test(`review write failure ${failRollback ? 'recovers its journal' : 'rolls back'} without stale authority`, async () => {
    class AmbiguousBackend extends MemoryBackend {
      failReviewWrite = false;
      reviewWriteFailed = false;
      override async put(key: string, value: Uint8Array): Promise<void> {
        if (
          failRollback &&
          this.reviewWriteFailed &&
          key === 'quota/v1/journal'
        ) {
          this.reviewWriteFailed = false;
          throw new Error('injected rollback journal failure');
        }
        await super.put(key, value);
        if (this.failReviewWrite && key.includes('/review/')) {
          this.failReviewWrite = false;
          this.reviewWriteFailed = true;
          throw new Error('injected failure after durable review write');
        }
      }
    }
    const backend = new AmbiguousBackend();
    const owner = Identity.create();
    const reviewer = Identity.create();
    const srv = createServer({
      backend,
      now: () => at,
      reviewLimits: { maxVetoesPerHour: 1 },
    });
    await srv.fetch(signed('/repos', createRepoBody('r', owner), owner));
    const op = await new OpLog(new MemoryStore()).write(
      'main',
      'src/a.ts',
      new TextEncoder().encode('a'),
      owner
    );
    await srv.fetch(signed('/repos/r/push', encodeBundle([op], [], []), owner));
    const grant = await grantReview(srv, owner, capability(owner, reviewer));
    const veto = scopedVeto(op.id, grant, reviewer);
    backend.failReviewWrite = true;
    const failed = await srv.fetch(
      signed(
        '/repos/r/vetoes',
        { veto: encodeBundle([], [], [], [], [veto]).veto },
        reviewer
      )
    );
    expect(failed.status).toBe(503);
    // A completed undo removes the veto. If publishing undo fails, recovery
    // finishes the original commit. The hot log must agree with either outcome.
    const readHistory = async () =>
      (await (
        await srv.fetch(new Request('http://t/repos/r/vetoes'))
      ).json()) as Result;
    expect(
      (await readHistory()).records.filter(
        (record) => record.status === 'active'
      )
    ).toHaveLength(failRollback ? 1 : 0);
    expect((await submit(srv, veto, reviewer)).accepted.veto).toBe(1);
    expect((await land(srv, op.id, owner)).landed).toBe(false);
    const second = await submit(
      srv,
      scopedVeto(op.id, grant, reviewer, 'second'),
      reviewer
    );
    expect(second.accepted.veto).toBe(0);
    expect(second.rejected[0].reason).toBe('rate_limit');
    expect(
      (await readHistory()).records.filter(
        (record) => record.status === 'active'
      )
    ).toHaveLength(1);
  });
}

test('review routes preserve write revocation for slash-containing repository names', async () => {
  const owner = Identity.create();
  const delegate = Identity.create();
  const srv = createServer({ backend: new MemoryBackend(), now: () => at });
  for (const name of ['a', 'a/reviewers', 'a/vetoes']) {
    expect(
      (await srv.fetch(signed('/repos', createRepoBody(name, owner), owner)))
        .status
    ).toBe(201);
    const delegation = signDelegation(
      { agent: delegate.did, paths: ['**'], maxChanges: 10, maxSpend: 10 },
      owner
    );
    expect(
      (
        await srv.fetch(
          signed(
            `/repos/${name}/grants`,
            { delegation: encodeDelegation(delegation) },
            owner
          )
        )
      ).status
    ).toBe(200);
  }
  for (const name of ['a/reviewers', 'a/vetoes']) {
    const response = await srv.fetch(
      signed(`/repos/${name}/revoke`, { agent: delegate.did }, owner)
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      agent: delegate.did,
      revoked: true,
    });
    const denied = await srv.fetch(
      signed(`/repos/${name}/push`, encodeBundle([], [], []), delegate)
    );
    expect(denied.status).toBe(403);
  }
  expect(
    (
      await srv.fetch(
        signed('/repos/a/push', encodeBundle([], [], []), delegate)
      )
    ).status
  ).toBe(200);
});
