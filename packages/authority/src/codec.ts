import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { PublicIdentity } from '@thaddeus.run/identity';

import { AuthorityError } from './errors';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Orders strings by UTF-16 code unit, the same on every machine and locale. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Domain-separated bytes for a signature: the tag, a newline, then JSON. */
export function signedBytes(domain: string, value: unknown): Uint8Array {
  return utf8(`${domain}\n${JSON.stringify(value)}`);
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Decodes strict base64url, refusing anything that does not round-trip. */
export function fromBase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new AuthorityError('malformed', 'expected base64url text');
  }
  const bytes = new Uint8Array(Buffer.from(text, 'base64url'));
  if (base64url(bytes) !== text) {
    throw new AuthorityError('malformed', 'expected canonical base64url text');
  }
  return bytes;
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new AuthorityError('malformed', 'expected UTF-8 text');
  }
}

/** Hex BLAKE3 of a domain-tagged string, used for ids and backend keys. */
export function digest(domain: string, value: string): string {
  return bytesToHex(blake3(utf8(`${domain}\0${value}`)));
}

/** 128 random bits as hex, for credential, ticket and record ids. */
export function randomId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** Verifies an ed25519 signature by a did:key; malformed input is false. */
export function verifyDid(
  did: string,
  bytes: Uint8Array,
  signature: Uint8Array
): boolean {
  try {
    return PublicIdentity.fromDid(did).verify(bytes, signature);
  } catch {
    return false;
  }
}

/** Throws unless `did` decodes as an ed25519 did:key. */
export function assertDid(what: string, did: unknown): asserts did is string {
  if (typeof did !== 'string') {
    throw new AuthorityError('malformed', `${what} must be a did:key`);
  }
  try {
    PublicIdentity.fromDid(did);
  } catch {
    throw new AuthorityError('malformed', `${what} must be an ed25519 did:key`);
  }
}
