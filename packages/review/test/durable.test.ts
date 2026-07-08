import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { VetoLog } from '../src/vetolog';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const AT = '2026-07-01T00:00:00Z';

describe('VetoLog — durability', () => {
  test('a recorded veto written through a backend survives a load() reopen', async () => {
    const backend = new MemoryBackend();
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const reviewer = Identity.create();
    const op = await log.write('main', 'src/auth.rs', enc('fn a() {}'), author);

    const vetoes = new VetoLog(backend);
    await vetoes.record(op, { reason: 'ships a secret', at: AT }, reviewer);

    // Reopen from the same backend — the veto survives, verified.
    const reopened = await VetoLog.load(backend);
    const found = reopened.forOp(op.id);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe('ships a secret');
    expect(reopened.status(found[0])).toBe('verified');
  });

  test('ingest() write-through is durable; a torn record is skipped on load', async () => {
    const backend = new MemoryBackend();
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const reviewer = Identity.create();
    const op = await log.write('main', 'a.rs', enc('x'), author);

    // Author on one instance, ingest on another (the wire path), both durable.
    const source = new VetoLog(backend);
    const v = await source.record(op, { reason: 'unsafe', at: AT }, reviewer);
    const wire = new VetoLog(backend);
    await wire.ingest(v);

    // A corrupt record under the veto/ prefix must not crash load — it is skipped.
    await backend.put('veto/torn', enc('{not valid record'));

    const reopened = await VetoLog.load(backend);
    expect(reopened.forOp(op.id)).toHaveLength(1); // deduped + torn skipped
  });

  test('without a backend, behavior is unchanged (in-memory only)', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const reviewer = Identity.create();
    const op = await log.write('main', 'a.rs', enc('x'), author);
    const vetoes = new VetoLog(); // no backend
    await vetoes.record(op, { reason: 'x', at: AT }, reviewer);
    expect(vetoes.forOp(op.id)).toHaveLength(1);
  });
});
