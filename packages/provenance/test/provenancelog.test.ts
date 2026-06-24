import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { signProvenance, verifyProvenance } from '../src/provenance';
import { ProvenanceLog } from '../src/provenancelog';

beforeAll(async () => {
  await ready();
});

// Helper: write a real op so provenance has something to bind to.
async function anOp(store: MemoryStore, author: Identity) {
  const log = new OpLog(store);
  return log.write('main', 'src/auth.rs', enc('fn refresh() {}'), author);
}
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('ProvenanceLog', () => {
  test('record builds a verified why bound to the op', async () => {
    const store = new MemoryStore();
    const actor = Identity.create();
    const op = await anOp(store, actor);
    const prov = new ProvenanceLog(store);

    const p = await prov.record(
      op,
      {
        intent: 'fix race in token refresh',
        reasoning: 'added a mutex',
        actorKind: 'agent:claude-code@1.2',
        task: 'STRATA-417',
      },
      actor
    );

    expect(p.op).toBe(op.id);
    expect(prov.status(p)).toBe('verified');
    expect(prov.forOp(op.id)).toHaveLength(1);
    expect(prov.forOp(op.id)[0]?.intent).toBe('fix race in token refresh');
  });

  test('a supplied prompt is stored capability-gated and bound by hash', async () => {
    const store = new MemoryStore();
    const actor = Identity.create();
    const stranger = Identity.create();
    const op = await anOp(store, actor);
    const prov = new ProvenanceLog(store);

    const promptBytes = enc('secret prompt: the API key is hunter2');
    const p = await prov.record(
      op,
      { intent: 'i', reasoning: 'r', actorKind: 'human', prompt: promptBytes },
      actor
    );

    // prompt_ref is the tamper-evident hash; the Ref is the gated pointer.
    expect(p.prompt_ref).not.toBeNull();
    expect(p.prompt).not.toBeNull();
    expect(prov.status(p)).toBe('verified');

    // The actor can read the prompt back; it hashes to prompt_ref.
    if (p.prompt !== null) {
      const back = await store.get(p.prompt, actor);
      expect(new TextDecoder().decode(back)).toBe(
        'secret prompt: the API key is hunter2'
      );
      // A non-grantee cannot read it (no leak into readable history).
      let denied = false;
      try {
        await store.get(p.prompt, stranger);
      } catch {
        denied = true;
      }
      expect(denied).toBe(true);
    }
  });

  test('no prompt → prompt_ref and prompt are null, still verified', async () => {
    const store = new MemoryStore();
    const actor = Identity.create();
    const op = await anOp(store, actor);
    const prov = new ProvenanceLog(store);

    const p = await prov.record(
      op,
      { intent: 'i', reasoning: 'r', actorKind: 'human' },
      actor
    );
    expect(p.prompt_ref).toBeNull();
    expect(p.prompt).toBeNull();
    expect(prov.status(p)).toBe('verified');
  });

  test('actor need not equal op.author — still verifies and binds the op', async () => {
    const store = new MemoryStore();
    const human = Identity.create();
    const agent = Identity.create();
    const op = await anOp(store, human);
    const prov = new ProvenanceLog(store);

    const p = await prov.record(
      op,
      { intent: 'i', reasoning: 'r', actorKind: 'agent:claude-code@1.2' },
      agent
    );
    expect(p.actor).toBe(agent.did);
    expect(p.actor).not.toBe(op.author);
    expect(prov.status(p)).toBe('verified');
  });

  test('append KEEPS an invalid record and labels it unverified (does not throw)', async () => {
    const store = new MemoryStore();
    const actor = Identity.create();
    const op = await anOp(store, actor);
    const prov = new ProvenanceLog(store);

    const good = signProvenance(
      {
        op: op.id,
        actor_kind: 'human',
        intent: 'i',
        reasoning: 'r',
        task: null,
        prompt_ref: null,
        prompt: null,
      },
      actor
    );
    const tampered = { ...good, reasoning: 'forged' };

    expect(() => prov.append(tampered)).not.toThrow();
    expect(prov.forOp(op.id)).toHaveLength(1);
    expect(prov.status(prov.forOp(op.id)[0])).toBe('unverified');
  });

  test('a same-sig forgery never evicts the genuine record, in either arrival order', async () => {
    // A forged record reuses the genuine signature: `{ ...good, reasoning }`
    // keeps good.sig. Dedup keys on full content, not (actor, sig), so the two
    // are distinct records — BOTH are kept (keep-and-label) and the genuine one
    // always survives and verifies regardless of which arrives first. (Keying
    // on (actor, sig) would let the first arrival win and drop the other.)
    const make = async (order: 'good-first' | 'forged-first') => {
      const store = new MemoryStore();
      const actor = Identity.create();
      const op = await anOp(store, actor);
      const prov = new ProvenanceLog(store);

      const good = signProvenance(
        {
          op: op.id,
          actor_kind: 'human',
          intent: 'i',
          reasoning: 'the real reasoning',
          task: null,
          prompt_ref: null,
          prompt: null,
        },
        actor
      );
      const forged = { ...good, reasoning: 'forged' };

      if (order === 'good-first') {
        prov.append(good);
        prov.append(forged);
      } else {
        prov.append(forged);
        prov.append(good);
      }
      return prov.forOp(op.id);
    };

    for (const order of ['good-first', 'forged-first'] as const) {
      const records = await make(order);
      // Both kept; the genuine record is present and verifies, the forgery does
      // not — neither displaces the other.
      expect(records).toHaveLength(2);
      const verified = records.filter((r) => verifyProvenance(r));
      expect(verified).toHaveLength(1);
      expect(verified[0].reasoning).toBe('the real reasoning');
      expect(
        records.some((r) => r.reasoning === 'forged' && !verifyProvenance(r))
      ).toBe(true);
    }
  });

  test('append is idempotent on full record content; forOp order is deterministic', async () => {
    const store = new MemoryStore();
    const actor = Identity.create();
    const op = await anOp(store, actor);
    const prov = new ProvenanceLog(store);

    const p = signProvenance(
      {
        op: op.id,
        actor_kind: 'human',
        intent: 'i',
        reasoning: 'r',
        task: null,
        prompt_ref: null,
        prompt: null,
      },
      actor
    );
    prov.append(p);
    prov.append(p);
    expect(prov.forOp(op.id)).toHaveLength(1);

    // A second distinct record (different actor) appears in a stable order.
    const other = Identity.create();
    const q = signProvenance(
      {
        op: op.id,
        actor_kind: 'human',
        intent: 'i2',
        reasoning: 'r2',
        task: null,
        prompt_ref: null,
        prompt: null,
      },
      other
    );
    prov.append(q);
    const order1 = prov.forOp(op.id).map((r) => r.actor);
    const order2 = prov.forOp(op.id).map((r) => r.actor);
    expect(order1).toEqual(order2);
    expect(order1).toHaveLength(2);
  });
});
