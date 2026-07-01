import { Identity, ready } from '@thaddeus.run/identity';
import type { Conflict, Op } from '@thaddeus.run/log';
import { OpLog } from '@thaddeus.run/log';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import {
  type Contribution,
  ReputationLog,
  signContribution,
} from '@thaddeus.run/reputation';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  allowAll,
  blockOnConflict,
  type LandProposal,
  requireReputationTier,
  requireVerifiedProvenance,
} from '../src/policy';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// A proposal with no conflicts and no incoming ops, overridable per test.
function proposal(over: Partial<LandProposal> = {}): LandProposal {
  return {
    into: 'main',
    intoHeads: [],
    incomingHeads: [],
    mergedHeads: [],
    incomingOps: [],
    conflicts: [],
    ...over,
  };
}

const aConflict: Conflict = {
  path: 'src/rate.rs',
  ops: ['op-a', 'op-b'],
  winner: 'op-b',
};

describe('policy — allowAll / blockOnConflict', () => {
  test('allowAll always allows, even with conflicts', async () => {
    expect(await allowAll(proposal({ conflicts: [aConflict] }))).toEqual({
      allow: true,
    });
  });

  test('blockOnConflict allows a clean proposal', async () => {
    expect(await blockOnConflict(proposal())).toEqual({ allow: true });
  });

  test('blockOnConflict rejects when conflicts exist, naming the path', async () => {
    const d = await blockOnConflict(proposal({ conflicts: [aConflict] }));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('src/rate.rs');
  });
});

describe('policy — requireVerifiedProvenance', () => {
  test('allows when every incoming op has a verified provenance record', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const op = await log.write('main', 'a.rs', enc('fn a() {}'), author);
    const prov = new ProvenanceLog(store);
    await prov.record(
      op,
      { intent: 'add a', reasoning: 'feature', actorKind: 'agent:test@1' },
      author
    );

    const d = await requireVerifiedProvenance(prov)(
      proposal({ incomingOps: [op] })
    );
    expect(d.allow).toBe(true);
  });

  test('rejects an incoming op with no provenance record', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const op: Op = await log.write('main', 'b.rs', enc('fn b() {}'), author);
    const prov = new ProvenanceLog(store); // never records anything

    const d = await requireVerifiedProvenance(prov)(
      proposal({ incomingOps: [op] })
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('verified provenance');
  });
});

// Seed `count` attested (host-vouched) merge contributions for `subject`, each
// with a distinct `ref` so ReputationLog dedup keeps them all.
function seedMerges(
  reps: ReputationLog,
  subject: Identity,
  host: Identity,
  count: number
): void {
  for (let i = 0; i < count; i++) {
    reps.append(
      signContribution(
        {
          repo: 'acme/web',
          ref: `merge-${subject.did}-${i}`,
          kind: 'merge',
          at: '2026-07-01T00:00:00Z',
        },
        subject,
        host
      )
    );
  }
}

describe('policy — requireReputationTier', () => {
  test('allows when every op author meets the tier', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const reps = new ReputationLog();
    const host = Identity.create();
    const author = Identity.create();
    seedMerges(reps, author, host, 3);
    const op = await log.write('main', 'a.rs', enc('fn a() {}'), author);

    const d = await requireReputationTier(
      reps,
      3
    )(proposal({ incomingOps: [op] }));
    expect(d.allow).toBe(true);
  });

  test('rejects when an author is below the tier, naming the count', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const reps = new ReputationLog();
    const host = Identity.create();
    const author = Identity.create();
    seedMerges(reps, author, host, 1); // only 1 attested merge, tier needs 3
    const op = await log.write('main', 'b.rs', enc('fn b() {}'), author);

    const d = await requireReputationTier(
      reps,
      3
    )(proposal({ incomingOps: [op] }));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('1 op(s)');
    expect(d.reason).toContain('tier');
  });

  test('claimed (unattested) merges do not count toward the tier', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const reps = new ReputationLog();
    const host = Identity.create();
    const stray = Identity.create();
    const author = Identity.create();
    // authentic (subj_sig intact) but host_sig from the wrong key → claimed,
    // not attested, so it must not count toward byKind.merge.
    const base = signContribution(
      {
        repo: 'acme/web',
        ref: 'op-x',
        kind: 'merge',
        at: '2026-07-01T00:00:00Z',
      },
      author,
      host
    );
    const claimed: Contribution = {
      ...base,
      host_sig: stray.sign(new Uint8Array([9])),
    };
    reps.append(claimed);
    const op = await log.write('main', 'c.rs', enc('fn c() {}'), author);

    const d = await requireReputationTier(
      reps,
      1
    )(proposal({ incomingOps: [op] }));
    expect(d.allow).toBe(false);
  });

  test('minMerges of 0 allows any author', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const reps = new ReputationLog(); // empty — the author has no records
    const author = Identity.create();
    const op = await log.write('main', 'd.rs', enc('fn d() {}'), author);

    const d = await requireReputationTier(
      reps,
      0
    )(proposal({ incomingOps: [op] }));
    expect(d.allow).toBe(true);
  });

  test('a mixed bundle rejects with the count of under-tier ops', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const reps = new ReputationLog();
    const host = Identity.create();
    const senior = Identity.create();
    const junior = Identity.create();
    seedMerges(reps, senior, host, 5);
    seedMerges(reps, junior, host, 1);
    const opSenior = await log.write('main', 'e.rs', enc('fn e() {}'), senior);
    const opJunior = await log.write('main', 'f.rs', enc('fn f() {}'), junior);

    const d = await requireReputationTier(
      reps,
      3
    )(proposal({ incomingOps: [opSenior, opJunior] }));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('1 op(s)');
  });
});
