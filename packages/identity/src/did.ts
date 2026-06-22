import { base58 } from '@scure/base';

// multicodec prefix for an ed25519 public key (varint 0xed01).
const ED25519_PREFIX: Uint8Array = new Uint8Array([0xed, 0x01]);

export function encodeDidKey(ed25519PublicKey: Uint8Array): string {
  const bytes = new Uint8Array(ED25519_PREFIX.length + ed25519PublicKey.length);
  bytes.set(ED25519_PREFIX, 0);
  bytes.set(ed25519PublicKey, ED25519_PREFIX.length);
  return `did:key:z${base58.encode(bytes)}`;
}

export function decodeDidKey(did: string): Uint8Array {
  const prefix = 'did:key:z';
  if (!did.startsWith(prefix)) {
    throw new Error(`not a did:key: ${did}`);
  }
  const bytes = base58.decode(did.slice(prefix.length));
  if (bytes[0] !== ED25519_PREFIX[0] || bytes[1] !== ED25519_PREFIX[1]) {
    throw new Error('unsupported did:key multicodec (expected ed25519)');
  }
  return bytes.slice(ED25519_PREFIX.length);
}
