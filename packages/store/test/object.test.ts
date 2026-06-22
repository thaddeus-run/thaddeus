import { ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { address, decrypt, encrypt, newContentKey } from '../src/object';

beforeAll(async () => {
  await ready();
});

describe('object', () => {
  test('encrypt → decrypt round-trips with the content key', () => {
    const key = newContentKey();
    const plaintext = new TextEncoder().encode('DATABASE_URL=postgres://x');
    const obj = encrypt(plaintext, key);
    expect(decrypt(obj, key)).toEqual(plaintext);
  });

  test('id is blake3(ciphertext); plaintext_id is blake3(plaintext)', () => {
    const key = newContentKey();
    const plaintext = new TextEncoder().encode('secret');
    const obj = encrypt(plaintext, key);
    expect(obj.id).toBe(address(obj.ciphertext));
    expect(obj.plaintext_id).toBe(address(plaintext));
  });

  test('ciphertext holds no plaintext', () => {
    const key = newContentKey();
    const obj = encrypt(new TextEncoder().encode('postgres-password'), key);
    expect(new TextDecoder().decode(obj.ciphertext).includes('postgres')).toBe(
      false
    );
  });

  test('decrypt with the wrong key throws', () => {
    const obj = encrypt(new TextEncoder().encode('secret'), newContentKey());
    expect(() => decrypt(obj, newContentKey())).toThrow();
  });
});
