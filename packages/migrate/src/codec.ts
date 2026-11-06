import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';

import { MigrationError } from './errors';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Orders strings by UTF-16 code unit, the same on every machine and locale. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new MigrationError('malformed', 'expected UTF-8 text');
  }
}

/** Hex BLAKE3 of a domain-tagged string, used for ids and backend keys. */
export function digest(domain: string, value: string): string {
  return bytesToHex(blake3(utf8(`${domain}\0${value}`)));
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Decodes strict base64url, refusing anything that does not round-trip. */
export function fromBase64url(text: string): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new MigrationError('malformed', 'expected base64url text');
  }
  const bytes = new Uint8Array(Buffer.from(text, 'base64url'));
  if (base64url(bytes) !== text) {
    throw new MigrationError('malformed', 'expected canonical base64url text');
  }
  return bytes;
}

// JSON with object keys sorted and byte arrays as tagged hex, so two copies
// of one record hash the same whatever order their fields arrived in.
function stable(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $hex: bytesToHex(value) };
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(byCodeUnit)) {
      out[key] = stable((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** A content key for a record that does not depend on its field order. */
export function recordKey(kind: string, record: unknown): string {
  return digest(
    `thaddeus.migrate.evidence.${kind}`,
    JSON.stringify(stable(record))
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
