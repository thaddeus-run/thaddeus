import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { decodeBundle, encodeBundle } from '../src/dto';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('wire bundle codec', () => {
  test('round-trips ops, objects, and caps through JSON-safe strings', async () => {
    const author = Identity.create();
    const store = new MemoryStore();
    const log = new OpLog(store);
    const op = await log.write('feat', 'a.rs', enc('fn a() {}'), author);
    const object = store.rawObject(op.payload!.id)!;
    const caps = [...store.caps(op.payload!.plaintext_id)];

    const wire = encodeBundle([op], [object], caps);
    // Wire form is JSON-serializable (base64 strings).
    const reparsed = JSON.parse(JSON.stringify(wire)) as typeof wire;
    const back = decodeBundle(reparsed);

    expect(back.ops[0]?.id).toBe(op.id);
    expect(back.ops[0]?.sig).toBeInstanceOf(Uint8Array);
    expect([...back.ops[0].sig]).toEqual([...op.sig]);
    expect(back.objects[0]?.id).toBe(object.id);
    expect([...back.objects[0].ciphertext]).toEqual([...object.ciphertext]);
    expect(back.caps[0]?.object).toBe(caps[0]?.object);
    if (
      back.caps[0]?.wrapped_key !== undefined &&
      caps[0]?.wrapped_key !== undefined
    ) {
      expect(back.caps[0].wrapped_key).toBeInstanceOf(Uint8Array);
      expect([...back.caps[0].wrapped_key]).toEqual([...caps[0].wrapped_key]);
    }
  });

  test('tolerates missing arrays (decodes to empty)', () => {
    // @ts-expect-error — deliberately omit fields to exercise the ?? [] guards
    const back = decodeBundle({});
    expect(back).toEqual({
      ops: [],
      objects: [],
      caps: [],
      prov: [],
      veto: [],
      symop: [],
    });
  });
});
