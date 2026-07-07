import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { signSymbolOp, verifySymbolOp } from '../src/symbolop';
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

describe('SymbolOp — signed record', () => {
  test('sign then verify round-trips', () => {
    const op = signSymbolOp(fields, Identity.create());
    expect(verifySymbolOp(op)).toBe(true);
    expect(op.kind).toBe('rename-symbol');
    expect(op.symbol).toBe('sym-abc');
  });

  test('tampering any signed field fails closed', () => {
    const op = signSymbolOp(fields, Identity.create());
    expect(verifySymbolOp({ ...op, to: 'evil' })).toBe(false);
    expect(verifySymbolOp({ ...op, symbol: 'other' })).toBe(false);
    // id binds the tuple too: a mismatched id fails without throwing.
    expect(verifySymbolOp({ ...op, id: 'deadbeef' })).toBe(false);
  });

  test('an empty required field throws on sign', () => {
    expect(() =>
      signSymbolOp({ ...fields, to: '' }, Identity.create())
    ).toThrow();
  });
});

describe('SymbolOpLog — keep-and-verify', () => {
  test('forSymbol returns records for an id; append dedups identical records', () => {
    const op = signSymbolOp(fields, Identity.create());
    const log = new SymbolOpLog();
    log.append(op);
    log.append(op); // idempotent
    expect(log.forSymbol('sym-abc')).toHaveLength(1);
    expect(log.verify(op)).toBe(true);
  });
});
