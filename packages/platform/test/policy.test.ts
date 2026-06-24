import { Identity, ready } from '@thaddeus.run/identity';
import type { Conflict, Op } from '@thaddeus.run/log';
import { OpLog } from '@thaddeus.run/log';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  allowAll,
  blockOnConflict,
  type LandProposal,
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
