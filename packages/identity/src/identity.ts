import sodium from 'libsodium-wrappers-sumo';

import { decodeDidKey, encodeDidKey } from './did';

let initialized = false;

// libsodium loads its wasm asynchronously; call once before using this module.
export async function ready(): Promise<void> {
  await sodium.ready;
  initialized = true;
}

function assertReady(): void {
  if (!initialized) {
    throw new Error('call `await ready()` before using @thaddeus.run/identity');
  }
}

// The shareable half of an identity: a did:key plus the keys it encodes.
export class PublicIdentity {
  readonly did: string;
  readonly #edPk: Uint8Array;
  readonly #xPk: Uint8Array;

  constructor(did: string, edPk: Uint8Array, xPk: Uint8Array) {
    this.did = did;
    this.#edPk = edPk;
    this.#xPk = xPk;
  }

  static fromDid(did: string): PublicIdentity {
    assertReady();
    const edPk = decodeDidKey(did);
    const xPk = sodium.crypto_sign_ed25519_pk_to_curve25519(edPk);
    return new PublicIdentity(did, edPk, xPk);
  }

  verify(bytes: Uint8Array, sig: Uint8Array): boolean {
    return sodium.crypto_sign_verify_detached(sig, bytes, this.#edPk);
  }

  // Anonymous sealed box: only the matching secret key can open it.
  seal(bytes: Uint8Array): Uint8Array {
    return sodium.crypto_box_seal(bytes, this.#xPk);
  }
}

// A full identity: signs, unseals, and yields its shareable PublicIdentity.
export class Identity {
  readonly #xPk: Uint8Array;
  readonly #xSk: Uint8Array;
  readonly #edSk: Uint8Array;
  readonly #public: PublicIdentity;

  private constructor(
    edPk: Uint8Array,
    edSk: Uint8Array,
    xPk: Uint8Array,
    xSk: Uint8Array
  ) {
    this.#edSk = edSk;
    this.#xPk = xPk;
    this.#xSk = xSk;
    this.#public = new PublicIdentity(encodeDidKey(edPk), edPk, xPk);
  }

  static create(): Identity {
    assertReady();
    const ed = sodium.crypto_sign_keypair();
    const xPk = sodium.crypto_sign_ed25519_pk_to_curve25519(ed.publicKey);
    const xSk = sodium.crypto_sign_ed25519_sk_to_curve25519(ed.privateKey);
    return new Identity(ed.publicKey, ed.privateKey, xPk, xSk);
  }

  get did(): string {
    return this.#public.did;
  }

  sign(bytes: Uint8Array): Uint8Array {
    return sodium.crypto_sign_detached(bytes, this.#edSk);
  }

  unseal(box: Uint8Array): Uint8Array {
    return sodium.crypto_box_seal_open(box, this.#xPk, this.#xSk);
  }

  toPublic(): PublicIdentity {
    return this.#public;
  }
}
