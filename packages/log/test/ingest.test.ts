import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { OpLog } from '../src/oplog';
import { expectRejects } from './reject';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('OpLog.ingest', () => {
  test('ingests a verified op into a fresh log', async () => {
    const author = Identity.create();
    const source = new OpLog(new MemoryStore());
    const op = await source.write('feat', 'a.rs', enc('a'), author);

    const dest = new OpLog(new MemoryStore());
    await dest.ingest(op);
    expect(dest.verify(op.id)).toBe(true);
    expect(Object.isFrozen(dest.ops().find((o) => o.id === op.id))).toBe(true);
  });

  test('rejects an unverifiable op', async () => {
    const author = Identity.create();
    const source = new OpLog(new MemoryStore());
    const op = await source.write('feat', 'a.rs', enc('a'), author);
    const forged = { ...op, sig: new Uint8Array(op.sig.length) };

    const dest = new OpLog(new MemoryStore());
    await expectRejects(dest.ingest(forged));
    expect(dest.verify(op.id)).toBe(false);
  });
});
