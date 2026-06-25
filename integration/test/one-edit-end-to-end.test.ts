import {
  AgentRegistry,
  delegationPolicy,
  signDelegation,
} from '@thaddeus.run/agent';
import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { blockOnConflict, Platform } from '@thaddeus.run/platform';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import { ReputationLog, signContribution } from '@thaddeus.run/reputation';
import { MemoryStore, publicIdentity } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

// The brief's "one edit, end to end" flow. Tier 0 (identity + store) is real
// today; higher pillars are test.todo and become real as each ships. See
// ARCHITECTURE.md → north-star flow.
beforeAll(async () => {
  await ready();
});

describe('north-star: one edit, end to end', () => {
  test('P05/P06/P01: an edit originates in a Workspace, lands into main under policy → a mirror serves it', async () => {
    const repo = new Platform().createRepo('acme/web');
    const author = Identity.create();

    // The edit enters Strata through the virtual filesystem on a NAMED, landable
    // branch: stage a write in a copy-on-write workspace, then commit it.
    const ws = Workspace.open(repo.log, repo.store, {
      source: 'main',
      reader: author,
      name: 'feat/refresh',
    });
    ws.write('src/auth.rs', new TextEncoder().encode('fn refresh() {}'));
    const [op] = await ws.commit(author);

    // The policy stage: land the branch into main under blockOnConflict.
    const result = await repo.land({
      from: 'feat/refresh',
      into: 'main',
      author,
      policy: blockOnConflict,
    });
    expect(result.landed).toBe(true);
    expect(repo.log.materialize('main').has('src/auth.rs')).toBe(true);

    // The mirror stage: the landed op's payload is mirror-verifiable ciphertext,
    // and the op is fully servable to a public mirror (not embargoed).
    expect(op).toBeDefined();
    expect(op?.payload).not.toBeNull();
    if (op?.payload != null) {
      expect(repo.store.verify(op.payload.id)).toBe(true);
    }
    if (op != null) {
      expect(repo.log.publicView(op.id).kind).toBe('open');
    }
  });

  test('P06/P07: a landed op mints a merge Contribution verifiable on another instance', async () => {
    const repo = new Platform().createRepo('acme/web');
    const author = Identity.create();
    const instance = Identity.create(); // the host that attests the landing

    // Land an edit (P05/P06), exactly as the canonical flow does.
    const ws = Workspace.open(repo.log, repo.store, {
      source: 'main',
      reader: author,
      name: 'feat/refresh',
    });
    ws.write('src/auth.rs', new TextEncoder().encode('fn refresh() {}'));
    const [op] = await ws.commit(author);
    const result = await repo.land({
      from: 'feat/refresh',
      into: 'main',
      author,
      policy: blockOnConflict,
    });
    expect(result.landed).toBe(true);
    expect(op).toBeDefined();

    // P07: mint a 'merge' contribution for the landed op — the author claims it,
    // the instance attests it. Then honor it on a SECOND instance with no shared
    // state: reputation travels as signed records, verified from the dids alone.
    if (op != null) {
      const contribution = signContribution(
        {
          repo: repo.name,
          ref: op.id,
          kind: 'merge',
          at: '2026-06-24T00:00:00.000Z',
        },
        author,
        instance
      );

      const elsewhere = new ReputationLog();
      elsewhere.append(contribution);
      expect(elsewhere.verify(contribution)).toEqual({
        authentic: true,
        attested: true,
      });

      const profile = elsewhere.profile(author.did);
      expect(profile.attested).toHaveLength(1);
      expect(profile.attested[0]?.ref).toBe(op.id);
      expect(profile.byKind.merge).toBe(1);
    }
  });

  test('P09: an agent lands under its operator delegation; revocation quarantines it', async () => {
    const repo = new Platform().createRepo('acme/web');
    const operator = Identity.create();
    const agent = Identity.create();
    const registry = new AgentRegistry();
    registry.register(
      signDelegation(
        { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 100 },
        operator
      )
    );

    // Attribution: the change will be signed by the agent, attributed to operator.
    expect(registry.operatorOf(agent.did)).toBe(operator.did);

    // The agent lands a change within its delegated scope, under the policy.
    const ws = Workspace.open(repo.log, repo.store, {
      source: 'main',
      reader: agent,
      name: 'agent/feat',
    });
    ws.write('src/auth.rs', new TextEncoder().encode('fn refresh() {}'));
    await ws.commit(agent);
    const ok = await repo.land({
      from: 'agent/feat',
      into: 'main',
      author: agent,
      policy: delegationPolicy(registry),
    });
    expect(ok.landed).toBe(true);
    registry.record(agent.did, 1); // meter the successful land

    // Revocation quarantines the agent: a further landing is rejected.
    registry.revoke(agent.did);
    const ws2 = Workspace.open(repo.log, repo.store, {
      source: 'main',
      reader: agent,
      name: 'agent/feat2',
    });
    ws2.write('src/extra.rs', new TextEncoder().encode('fn x() {}'));
    await ws2.commit(agent);
    const blocked = await repo.land({
      from: 'agent/feat2',
      into: 'main',
      author: agent,
      policy: delegationPolicy(registry),
    });
    expect(blocked.landed).toBe(false);
    expect(blocked.reason).toContain('revoked');
  });

  test('P01/P02: grant releases the content key to a named grantee', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const reviewer = Identity.create();
    const ref = await store.put(
      new TextEncoder().encode('fn refresh() {}'),
      author
    );
    await store.grant(ref, reviewer.toPublic(), author);
    expect(new TextDecoder().decode(await store.get(ref, reviewer))).toBe(
      'fn refresh() {}'
    );
  });

  test('P03: the edit is recorded as a signed Op in the operation log', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();

    const op = await log.write(
      'main',
      'src/auth.rs',
      new TextEncoder().encode('fn refresh() {}'),
      author
    );

    // The edit is a signed op in the log, and materialize places it at its path
    // using cleartext metadata only.
    expect(op.author).toBe(author.did);
    expect(log.materialize('main').get('src/auth.rs')?.op.id).toBe(op.id);

    // Content reads back through the capability-checked store (payload is the Ref).
    expect(op.payload).not.toBeNull();
    if (op.payload !== null) {
      expect(
        new TextDecoder().decode(await store.get(op.payload, author))
      ).toBe('fn refresh() {}');
    }
  });
  test('P04: a signed Provenance record attaches the why to the Op', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const prov = new ProvenanceLog(store);

    const op = await log.write(
      'main',
      'src/auth.rs',
      new TextEncoder().encode('fn refresh() {}'),
      author
    );

    const why = await prov.record(
      op,
      {
        intent: 'fix race in token refresh',
        reasoning: 'refresh() re-entered before lock; added a mutex',
        actorKind: 'agent:claude-code@1.2',
        task: 'STRATA-417',
      },
      author
    );

    // The why is bound to the op's id and verifies.
    expect(why.op).toBe(op.id);
    expect(prov.status(why)).toBe('verified');
    expect(prov.forOp(op.id).map((p) => p.intent)).toContain(
      'fix race in token refresh'
    );

    // The trust rule: tampering any signed field renders it unverified.
    expect(prov.status({ ...why, reasoning: 'a plausible lie' })).toBe(
      'unverified'
    );
    expect(prov.status({ ...why, actor_kind: 'human' })).toBe('unverified');
  });
  test('P02: a scheduled reveal re-wraps the content key to public at T', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const ref = await store.put(
      new TextEncoder().encode('fn refresh() {}'),
      author
    );

    const T = '2030-01-01T00:00:00.000Z';
    await store.scheduleReveal(ref, T, author);

    // Embargo: ciphertext is mirror-verifiable; the public cannot read before T.
    expect(store.verify(ref.id)).toBe(true);
    let deniedBeforeT = false;
    try {
      await store.get(ref, publicIdentity(), '2026-06-23T00:00:00.000Z');
    } catch {
      deniedBeforeT = true;
    }
    expect(deniedBeforeT).toBe(true);

    // At T the content key re-wraps to public and the world can read.
    expect(
      new TextDecoder().decode(await store.get(ref, publicIdentity(), T))
    ).toBe('fn refresh() {}');
  });
});
