import type { Delegation } from '@thaddeus.run/agent';
import type { Op } from '@thaddeus.run/log';
import type { Provenance } from '@thaddeus.run/provenance';
import type { ContributionClaim } from '@thaddeus.run/reputation';
import type { Veto } from '@thaddeus.run/review';
import {
  type Capability,
  decodeRecord,
  encodeRecord,
  type EncryptedObject,
} from '@thaddeus.run/store';

// The wire reuses the persistence record codec (JSON + {$u8: base64}) per item,
// so byte fields (sig/nonce/ciphertext/wrapped_key) survive JSON transport. Each
// item rides as a base64 string; the bundle is plain JSON. `prov` carries the
// signed "why" (P04) and `veto` the standing human "no" (P10) alongside the
// code; both optional so an older client still round-trips.
export interface Bundle {
  ops: string[];
  objects: string[];
  caps: string[];
  prov?: string[];
  veto?: string[];
}

const toWire = (value: unknown): string =>
  Buffer.from(encodeRecord(value)).toString('base64');

const fromWire = (s: string): unknown =>
  decodeRecord(new Uint8Array(Buffer.from(s, 'base64')));

export function encodeBundle(
  ops: readonly Op[],
  objects: readonly EncryptedObject[],
  caps: readonly Capability[],
  prov: readonly Provenance[] = [],
  veto: readonly Veto[] = []
): Bundle {
  return {
    ops: ops.map(toWire),
    objects: objects.map(toWire),
    caps: caps.map(toWire),
    prov: prov.map(toWire),
    veto: veto.map(toWire),
  };
}

export function decodeBundle(b: Bundle): {
  ops: Op[];
  objects: EncryptedObject[];
  caps: Capability[];
  prov: Provenance[];
  veto: Veto[];
} {
  return {
    ops: (b.ops ?? []).map((s) => fromWire(s) as Op),
    objects: (b.objects ?? []).map((s) => fromWire(s) as EncryptedObject),
    caps: (b.caps ?? []).map((s) => fromWire(s) as Capability),
    prov: (b.prov ?? []).map((s) => fromWire(s) as Provenance),
    veto: (b.veto ?? []).map((s) => fromWire(s) as Veto),
  };
}

// A single Delegation on the wire: base64 of the persistence record encoding (so
// its sig bytes survive JSON), same convention as the bundle items.
export function encodeDelegation(d: Delegation): string {
  return Buffer.from(encodeRecord(d)).toString('base64');
}
export function decodeDelegation(s: string): Delegation {
  return decodeRecord(new Uint8Array(Buffer.from(s, 'base64'))) as Delegation;
}

// A subject-signed reputation claim (P07) on the wire — base64 of the record
// encoding so its subj_sig survives JSON. Rides in the land request body (not the
// pull/push Bundle): the client claims a contribution for a landed op, and an
// attesting host co-signs it.
export function encodeClaim(claim: ContributionClaim): string {
  return Buffer.from(encodeRecord(claim)).toString('base64');
}
export function decodeClaim(s: string): ContributionClaim {
  return decodeRecord(
    new Uint8Array(Buffer.from(s, 'base64'))
  ) as ContributionClaim;
}
