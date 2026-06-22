import { Identity, PublicIdentity } from '@thaddeus.run/identity';

import {
  type Capability,
  issueCapability,
  unwrapKey,
  verifyCapability,
} from './capability';
import {
  address,
  decrypt,
  encrypt,
  type EncryptedObject,
  newContentKey,
} from './object';

export interface Ref {
  readonly id: string;
  readonly plaintext_id: string;
}

export class AccessDenied extends Error {
  constructor(did: string) {
    super(`access denied for ${did}`);
    this.name = 'AccessDenied';
  }
}

export interface Store {
  put(plaintext: Uint8Array, owner: Identity): Promise<Ref>;
  get(ref: Ref, reader: Identity): Promise<Uint8Array>;
  grant(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void>;
  revoke(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void>;
  rawObject(id: string): EncryptedObject | undefined;
  verify(id: string): boolean;
}

// In-memory reference store. Never holds a plaintext content key: keys live
// only inside capabilities, sealed to each grantee. Spike — not durable, not
// concurrency-safe.
export class MemoryStore implements Store {
  readonly #objects: Map<string, EncryptedObject> = new Map();
  readonly #current: Map<string, string> = new Map();
  readonly #caps: Map<string, Capability[]> = new Map();

  async put(plaintext: Uint8Array, owner: Identity): Promise<Ref> {
    const contentKey = newContentKey();
    const object = encrypt(plaintext, contentKey);
    this.#objects.set(object.id, object);
    this.#current.set(object.plaintext_id, object.id);
    this.#caps.set(object.plaintext_id, [
      issueCapability({
        object: object.plaintext_id,
        contentKey,
        grantee: owner.toPublic(),
        grantedBy: owner,
      }),
    ]);
    return { id: object.id, plaintext_id: object.plaintext_id };
  }

  async get(ref: Ref, reader: Identity): Promise<Uint8Array> {
    return decrypt(
      this.#currentObject(ref.plaintext_id),
      this.#contentKeyVia(ref.plaintext_id, reader)
    );
  }

  async grant(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void> {
    const contentKey = this.#contentKeyVia(ref.plaintext_id, by);
    const caps = this.#caps.get(ref.plaintext_id) ?? [];
    caps.push(
      issueCapability({
        object: ref.plaintext_id,
        contentKey,
        grantee,
        grantedBy: by,
      })
    );
    this.#caps.set(ref.plaintext_id, caps);
  }

  async revoke(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void> {
    const oldKey = this.#contentKeyVia(ref.plaintext_id, by);
    const plaintext = decrypt(this.#currentObject(ref.plaintext_id), oldKey);

    // Rotate: new key, re-encrypt, supersede the current object.
    const newKey = newContentKey();
    const rotated = encrypt(plaintext, newKey);
    this.#objects.set(rotated.id, rotated);
    this.#current.set(ref.plaintext_id, rotated.id);

    // Re-issue capabilities for everyone except the revoked grantee.
    const remaining = (this.#caps.get(ref.plaintext_id) ?? []).filter(
      (c) => c.grantee !== grantee.did
    );
    this.#caps.set(
      ref.plaintext_id,
      remaining.map((c) =>
        issueCapability({
          object: ref.plaintext_id,
          contentKey: newKey,
          grantee: PublicIdentity.fromDid(c.grantee),
          grantedBy: by,
        })
      )
    );
  }

  rawObject(id: string): EncryptedObject | undefined {
    return this.#objects.get(id);
  }

  verify(id: string): boolean {
    const object = this.#objects.get(id);
    return object !== undefined && address(object.ciphertext) === id;
  }

  // Returns the capability for did within the plaintext object, if valid.
  #capabilityFor(plaintextId: string, did: string): Capability | undefined {
    const now = Date.now();
    return (this.#caps.get(plaintextId) ?? []).find(
      (c) =>
        c.grantee === did &&
        verifyCapability(c) &&
        Date.parse(c.not_before) <= now
    );
  }

  // Resolves the content key for who by locating and unwrapping their capability.
  // Throws AccessDenied if who has no valid capability.
  #contentKeyVia(plaintextId: string, who: Identity): Uint8Array {
    const cap = this.#capabilityFor(plaintextId, who.did);
    if (cap === undefined) {
      throw new AccessDenied(who.did);
    }
    return unwrapKey(cap, who);
  }

  // Resolves the current EncryptedObject for a plaintext id. Throws if missing.
  #currentObject(plaintextId: string): EncryptedObject {
    const id = this.#current.get(plaintextId);
    const object = id === undefined ? undefined : this.#objects.get(id);
    if (object === undefined) {
      throw new Error(`no object for ${plaintextId}`);
    }
    return object;
  }
}
