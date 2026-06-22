import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import sodium from 'libsodium-wrappers-sumo';

export const ALG = 'xchacha20poly1305';

export interface EncryptedObject {
  readonly id: string;
  readonly plaintext_id: string;
  readonly alg: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

// Content address: hex blake3. Used for object ids (over ciphertext) and
// plaintext ids (over plaintext).
export function address(bytes: Uint8Array): string {
  return bytesToHex(blake3(bytes));
}

export function newContentKey(): Uint8Array {
  return sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
}

export function encrypt(
  plaintext: Uint8Array,
  contentKey: Uint8Array
): EncryptedObject {
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  );
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    null,
    null,
    nonce,
    contentKey
  );
  return {
    id: address(ciphertext),
    plaintext_id: address(plaintext),
    alg: ALG,
    nonce,
    ciphertext,
  };
}

export function decrypt(
  object: EncryptedObject,
  contentKey: Uint8Array
): Uint8Array {
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    object.ciphertext,
    null,
    object.nonce,
    contentKey
  );
}
