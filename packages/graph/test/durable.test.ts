import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { beforeAll, describe, expect, test } from 'bun:test';

import { signSymbolOp } from '../src/symbolop';
import { SymbolOpLog } from '../src/symboloplog';

beforeAll(async () => {
  await ready();
});

const fields = {
  kind: 'rename-symbol' as const,
  symbol: 'sym-abc',
  from: 'refresh',
  to: 'refreshToken',
  base: null,
};

describe('SymbolOpLog — durability', () => {
  test('an ingested SymbolOp survives a load() reopen and verifies', async () => {
    const backend = new MemoryBackend();
    const author = Identity.create();
    const op = signSymbolOp(fields, author);

    const log = new SymbolOpLog(backend);
    await log.ingest(op);

    const reopened = await SymbolOpLog.load(backend);
    const found = reopened.forSymbol('sym-abc');
    expect(found).toHaveLength(1);
    expect(found[0].to).toBe('refreshToken');
    expect(reopened.verify(found[0])).toBe(true);
  });

  test('write-through is idempotent; a torn record is skipped on load', async () => {
    const backend = new MemoryBackend();
    const author = Identity.create();
    const op = signSymbolOp(fields, author);

    // Author on one instance, ingest on another (the wire path), both durable.
    const source = new SymbolOpLog(backend);
    await source.ingest(op);
    const wire = new SymbolOpLog(backend);
    await wire.ingest(op); // identical content → idempotent

    // A corrupt record under the symop/ prefix must not crash load — it is skipped.
    await backend.put(
      'symop/torn',
      new TextEncoder().encode('{not valid record')
    );

    const reopened = await SymbolOpLog.load(backend);
    expect(reopened.forSymbol('sym-abc')).toHaveLength(1); // deduped + torn skipped
  });

  test('without a backend, behavior is unchanged (in-memory only)', () => {
    const op = signSymbolOp(fields, Identity.create());
    const log = new SymbolOpLog(); // no backend
    log.append(op);
    expect(log.forSymbol('sym-abc')).toHaveLength(1);
  });
});
