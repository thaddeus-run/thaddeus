import type { Op } from '@thaddeus.run/log';
import {
  type Capability,
  decodeRecord,
  encodeRecord,
  type EncryptedObject,
} from '@thaddeus.run/store';

// The wire reuses the persistence record codec (JSON + {$u8: base64}) per item,
// so byte fields (sig/nonce/ciphertext/wrapped_key) survive JSON transport. Each
// item rides as a base64 string; the bundle is plain JSON.
export interface Bundle {
  ops: string[];
  objects: string[];
  caps: string[];
}

const toWire = (value: unknown): string =>
  Buffer.from(encodeRecord(value)).toString('base64');

const fromWire = (s: string): unknown =>
  decodeRecord(new Uint8Array(Buffer.from(s, 'base64')));

export function encodeBundle(
  ops: readonly Op[],
  objects: readonly EncryptedObject[],
  caps: readonly Capability[]
): Bundle {
  return {
    ops: ops.map(toWire),
    objects: objects.map(toWire),
    caps: caps.map(toWire),
  };
}

export function decodeBundle(b: Bundle): {
  ops: Op[];
  objects: EncryptedObject[];
  caps: Capability[];
} {
  return {
    ops: (b.ops ?? []).map((s) => fromWire(s) as Op),
    objects: (b.objects ?? []).map((s) => fromWire(s) as EncryptedObject),
    caps: (b.caps ?? []).map((s) => fromWire(s) as Capability),
  };
}
