import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import { MemoryStore, publicIdentity } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

// The brief's "one edit, end to end" flow. Tier 0 (identity + store) is real
// today; higher pillars are test.todo and become real as each ships. See
// ARCHITECTURE.md → north-star flow.
beforeAll(async () => {
  await ready();
});

describe('north-star: one edit, end to end', () => {
  test('P05/P01: an edit originates in a Workspace → stored as ciphertext a mirror can verify', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();

    // The edit enters Strata through the virtual filesystem, not a hand-built op:
    // stage a write in a copy-on-write workspace, then commit it into the log.
    const ws = Workspace.open(log, store, { source: 'main', reader: author });
    ws.write('src/auth.rs', new TextEncoder().encode('fn refresh() {}'));
    const [op] = await ws.commit(author);

    // The commit produced a signed op whose payload is mirror-verifiable ciphertext.
    expect(op).toBeDefined();
    expect(op?.payload).not.toBeNull();
    if (op?.payload != null) {
      expect(store.verify(op.payload.id)).toBe(true);
      expect(store.rawObject(op.payload.id)).toBeDefined();
    }
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
