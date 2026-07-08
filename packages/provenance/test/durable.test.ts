import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { ProvenanceLog } from '../src/provenancelog';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('ProvenanceLog — durability', () => {
  test('records written through a backend survive a load() reopen', async () => {
    const backend = new MemoryBackend();
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const op = await log.write(
      'main',
      'src/auth.rs',
      enc('fn refresh() {}'),
      author
    );

    const prov = new ProvenanceLog(store, backend);
    await prov.record(
      op,
      {
        intent: 'fix race',
        reasoning: 'added a mutex',
        actorKind: 'agent:x@1',
      },
      author
    );

    // Reopen from the same backend — the why survives, verified.
    const reopened = await ProvenanceLog.load(store, backend);
    const records = reopened.forOp(op.id);
    expect(records).toHaveLength(1);
    expect(records[0].intent).toBe('fix race');
    expect(reopened.status(records[0])).toBe('verified');
  });

  test('ingest() write-through is durable; a torn record is skipped on load', async () => {
    const backend = new MemoryBackend();
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const op = await log.write('main', 'a.rs', enc('x'), author);

    // Author on one instance, ingest on another (the wire path), both durable.
    const source = new ProvenanceLog(store, backend);
    const p = await source.record(
      op,
      { intent: 'add a', reasoning: 'feature', actorKind: 'agent:x@1' },
      author
    );
    const wire = new ProvenanceLog(store, backend);
    await wire.ingest(p);

    // A corrupt record under the prov/ prefix must not crash load — it is skipped.
    await backend.put(
      'prov/torn',
      new TextEncoder().encode('{not valid record')
    );

    const reopened = await ProvenanceLog.load(store, backend);
    expect(reopened.forOp(op.id)).toHaveLength(1); // deduped + torn skipped
  });

  test('without a backend, behavior is unchanged (in-memory only)', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const op = await log.write('main', 'a.rs', enc('x'), author);
    const prov = new ProvenanceLog(store); // no backend
    await prov.record(
      op,
      { intent: 'x', reasoning: 'y', actorKind: 'a' },
      author
    );
    expect(prov.forOp(op.id)).toHaveLength(1);
  });
});
