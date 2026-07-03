import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { signVeto } from '../src/veto';
import { VetoLog } from '../src/vetolog';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const AT = '2026-07-01T00:00:00Z';

describe('VetoLog', () => {
  test('record then forOp returns the veto, labelled verified', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const reviewer = Identity.create();
    const author = Identity.create();
    const op = await log.write('main', 'a.rs', enc('fn a() {}'), author);

    const vetoes = new VetoLog();
    const v = vetoes.record(op, { reason: 'unsafe', at: AT }, reviewer);
    expect(v.op).toBe(op.id);
    const found = vetoes.forOp(op.id);
    expect(found).toHaveLength(1);
    expect(vetoes.status(found[0])).toBe('verified');
  });

  test('append keeps an invalid veto, labelled unverified (never dropped)', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const reviewer = Identity.create();
    const author = Identity.create();
    const op = await log.write('main', 'b.rs', enc('fn b() {}'), author);

    const vetoes = new VetoLog();
    const signed = signVeto({ op: op.id, reason: 'x', at: AT }, reviewer);
    // Tamper the body after signing: the record is kept but does not verify.
    vetoes.append({ ...signed, reason: 'forged: totally fine' });

    const found = vetoes.forOp(op.id);
    expect(found).toHaveLength(1);
    expect(vetoes.status(found[0])).toBe('unverified');
  });

  test('dedups an identical veto, keeps a distinct one', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const reviewer = Identity.create();
    const author = Identity.create();
    const op = await log.write('main', 'c.rs', enc('fn c() {}'), author);

    const vetoes = new VetoLog();
    const v = signVeto({ op: op.id, reason: 'unsafe', at: AT }, reviewer);
    vetoes.append(v);
    vetoes.append(v); // identical content → deduped
    expect(vetoes.forOp(op.id)).toHaveLength(1);

    const v2 = signVeto(
      { op: op.id, reason: 'also leaks a key', at: AT },
      reviewer
    );
    vetoes.append(v2); // distinct body → kept
    expect(vetoes.forOp(op.id)).toHaveLength(2);
  });

  test('forOp order is deterministic regardless of insertion order', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const r1 = Identity.create();
    const r2 = Identity.create();
    const op = await log.write('main', 'd.rs', enc('fn d() {}'), author);

    const a = new VetoLog();
    a.append(signVeto({ op: op.id, reason: 'one', at: AT }, r1));
    a.append(signVeto({ op: op.id, reason: 'two', at: AT }, r2));

    const b = new VetoLog();
    b.append(signVeto({ op: op.id, reason: 'two', at: AT }, r2));
    b.append(signVeto({ op: op.id, reason: 'one', at: AT }, r1));

    expect(a.forOp(op.id).map((v) => v.reviewer)).toEqual(
      b.forOp(op.id).map((v) => v.reviewer)
    );
  });
});
