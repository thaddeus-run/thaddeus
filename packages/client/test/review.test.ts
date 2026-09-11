import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import {
  reviewerCapabilityId,
  signReviewerCapability,
  signReviewRevocation,
  signScopedVeto,
  signVetoWithdrawal,
  vetoId,
} from '@thaddeus.run/review';
import { createServer } from '@thaddeus.run/server';
import { beforeAll, expect, test } from 'bun:test';

import { Client } from '../src/client';

beforeAll(ready);

test('live HTTP review lifecycle, second repo isolation, and owner write/land regression', async () => {
  const backend = new MemoryBackend();
  const server = createServer({ backend, defaultPageSize: 2 });
  const http = Bun.serve({ port: 0, fetch: server.fetch });
  const owner = Identity.create();
  const reviewer = Identity.create();
  const base = `http://localhost:${http.port}`;
  const writer = new Client(base, owner);
  const outside = new Client(base, reviewer);
  try {
    await writer.createRepo('r');
    await writer.createRepo('second');
    const local = new MemoryBackend();
    const { repo } = await writer.clone('r', local);
    const ws = Workspace.open(repo.log, repo.store, {
      source: 'main',
      name: 'change',
      reader: owner,
    });
    ws.write('src/auth.ts', new TextEncoder().encode('first'));
    const [op] = await ws.commit(owner);
    expect(op).toBeDefined();
    expect((await writer.push('r', repo, [op.id])).accepted.ops).toBe(1);
    const cap = signReviewerCapability(
      {
        repo: 'r',
        reviewer: reviewer.did,
        paths: ['src/**'],
        nonce: 'first',
        at: new Date().toISOString(),
        maxVetoesPerHour: 60,
        maxActiveVetoes: 256,
      },
      owner
    );
    const grant = (await writer.grantReviewer('r', cap)).grant;
    expect(grant).toBe(reviewerCapabilityId(cap));
    expect(await outside.listReviewers('r', owner.did)).toHaveLength(1);
    expect(await outside.listReviewers('r', reviewer.did)).toHaveLength(0);
    const veto = signScopedVeto(
      {
        repo: 'r',
        grant,
        op: op.id,
        reason: 'needs a guard',
        at: new Date().toISOString(),
      },
      reviewer
    );
    expect((await outside.pushVetoes('r', [veto])).accepted.veto).toBe(1);
    expect((await outside.pushVetoes('second', [veto])).accepted.veto).toBe(0);
    expect((await writer.land('r', repo, [op.id])).landed).toBe(false);
    let denied = false;
    try {
      await outside.push('r', repo, [op.id]);
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
    const audit = await outside.reviewHistory('r');
    expect(
      audit.some(
        (entry) => entry.id === vetoId(veto) && entry.status === 'active'
      )
    ).toBe(true);
    const withdrawal = signVetoWithdrawal(
      {
        repo: 'r',
        veto: vetoId(veto),
        reason: 'resolved',
        at: new Date().toISOString(),
      },
      reviewer
    );
    expect((await outside.withdrawVeto('r', withdrawal)).withdrawn).toBe(true);
    expect((await writer.land('r', repo, [op.id])).landed).toBe(true);
    const mirrorBackend = new MemoryBackend();
    const mirror = await outside.clone('r', mirrorBackend, 'main', {
      expectedOwner: owner.did,
    });
    expect(mirror.reviews.status(veto, op)).toBe('withdrawn');
    expect(mirror.vetoes.forOp(op.id)).toHaveLength(1);
    // A second upload/land through the old owner path still works.
    const second = Workspace.open(repo.log, repo.store, {
      source: 'main',
      name: 'second',
      reader: owner,
    });
    second.write('src/second.ts', new TextEncoder().encode('second'));
    const [op2] = await second.commit(owner);
    expect(
      (await writer.push('r', repo, [op2.id])).accepted.ops
    ).toBeGreaterThan(0);
    const secondVeto = signScopedVeto(
      {
        repo: 'r',
        grant,
        op: op2.id,
        reason: 'review second',
        at: new Date().toISOString(),
      },
      reviewer
    );
    await outside.pushVetoes('r', [secondVeto]);
    const revocation = signReviewRevocation(
      { repo: 'r', grant, reason: 'finished', at: new Date().toISOString() },
      owner
    );
    await writer.revokeReviewer('r', revocation);
    expect(await outside.listReviewers('r', owner.did)).toHaveLength(0);
    expect((await writer.land('r', repo, [op2.id])).landed).toBe(true);
    const pulled = await outside.pull('r', mirror.repo, mirrorBackend);
    expect(pulled.reviews.status(secondVeto, op2)).toBe('revoked');
    expect(pulled.reviews.status(veto, op)).toBe('withdrawn');
    const secondRepo = await writer.clone('second', new MemoryBackend());
    expect(secondRepo.heads).toHaveLength(0);
    expect([...secondRepo.reviews.events()]).toHaveLength(0);
  } finally {
    await http.stop(true);
    await server.close();
  }
});
