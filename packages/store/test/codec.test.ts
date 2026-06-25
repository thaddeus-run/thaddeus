import { describe, expect, test } from 'bun:test';

import { decodeRecord, encodeRecord } from '../src/backend';

describe('record codec', () => {
  test('round-trips plain JSON values', () => {
    const v = { a: 1, b: ['x', 'y'], c: null };
    expect(decodeRecord(encodeRecord(v))).toEqual(v);
  });

  test('round-trips Uint8Array fields', () => {
    const v = { id: 'z', sig: new Uint8Array([0, 1, 254, 255]) };
    const out = decodeRecord(encodeRecord(v)) as typeof v;
    expect(out.id).toBe('z');
    expect(out.sig).toBeInstanceOf(Uint8Array);
    expect([...out.sig]).toEqual([0, 1, 254, 255]);
  });

  test('throws on an unknown record version', () => {
    const bad = new TextEncoder().encode(
      JSON.stringify({ v: 'future', d: {} })
    );
    expect(() => decodeRecord(bad)).toThrow(TypeError);
  });
});
