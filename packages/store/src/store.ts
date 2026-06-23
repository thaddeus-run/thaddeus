import { Identity, PublicIdentity } from '@thaddeus.run/identity';

import {
  type Capability,
  issueCapability,
  unwrapKey,
  verifyCapability,
} from './capability';
import { publicIdentity } from './membrane';
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
  get(ref: Ref, reader: Identity, now?: string): Promise<Uint8Array>;
  grant(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void>;
  revoke(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void>;
  scheduleReveal(ref: Ref, at: string, by: Identity): Promise<void>;
  reveal(ref: Ref, now?: string): Promise<boolean>;
  // Returns ONLY the served (mirror-visible) capabilities. Pending reveals are
  // withheld here until released; never route a wrapped_key capability through
  // this return type before it has been promoted to the served set.
  caps(plaintextId: string): readonly Capability[];
  rawObject(id: string): EncryptedObject | undefined;
  current(plaintextId: string): EncryptedObject | undefined;
  verify(id: string): boolean;
}

// In-memory reference store. Never holds a plaintext content key: keys live
// only inside capabilities, sealed to each grantee. Spike — not durable, not
// concurrency-safe.
export class MemoryStore implements Store {
  readonly #objects: Map<string, EncryptedObject> = new Map();
  readonly #current: Map<string, string> = new Map();
  readonly #caps: Map<string, Capability[]> = new Map();
  readonly #pending: Map<string, Capability[]> = new Map();

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

  async get(ref: Ref, reader: Identity, now?: string): Promise<Uint8Array> {
    const nowMs = this.#resolveNow(now);
    this.#releaseDue(ref.plaintext_id, nowMs);
    return decrypt(
      this.#currentObject(ref.plaintext_id),
      this.#contentKeyVia(ref.plaintext_id, reader, nowMs)
    );
  }

  async grant(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void> {
    const contentKey = this.#contentKeyVia(ref.plaintext_id, by, Date.now());
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
    const oldKey = this.#contentKeyVia(ref.plaintext_id, by, Date.now());
    const plaintext = decrypt(this.#currentObject(ref.plaintext_id), oldKey);

    // Rotate: new key, re-encrypt, supersede the current object.
    const newKey = newContentKey();
    const rotated = encrypt(plaintext, newKey);
    this.#objects.set(rotated.id, rotated);
    this.#current.set(ref.plaintext_id, rotated.id);

    // Re-wrap each remaining capability (served and pending) to the new key,
    // preserving its original start time. The revoked grantee is dropped from
    // both sets — so revoking the public identity cancels a pending reveal.
    const rewrap = (caps: Capability[]): Capability[] =>
      caps
        .filter((c) => c.grantee !== grantee.did)
        .map((c) =>
          issueCapability({
            object: ref.plaintext_id,
            contentKey: newKey,
            grantee: PublicIdentity.fromDid(c.grantee),
            grantedBy: by,
            notBefore: c.not_before,
          })
        );

    this.#caps.set(
      ref.plaintext_id,
      rewrap(this.#caps.get(ref.plaintext_id) ?? [])
    );
    // Intentional: re-key pending reveals too. A scheduled reveal must survive
    // a key rotation so it can still fire at its not_before time.
    this.#pending.set(
      ref.plaintext_id,
      rewrap(this.#pending.get(ref.plaintext_id) ?? [])
    );
  }

  // Schedule a withheld reveal: `by` (who must hold the content key) seals it to
  // the well-known public identity with not_before = at, parked in #pending.
  // Nothing is served or mirror-visible until a trigger fires (#releaseDue).
  async scheduleReveal(ref: Ref, at: string, by: Identity): Promise<void> {
    const contentKey = this.#contentKeyVia(ref.plaintext_id, by, Date.now());
    const cap = issueCapability({
      object: ref.plaintext_id,
      contentKey,
      grantee: publicIdentity().toPublic(),
      grantedBy: by,
      notBefore: at,
    });
    const pend = this.#pending.get(ref.plaintext_id) ?? [];
    pend.push(cap);
    this.#pending.set(ref.plaintext_id, pend);
  }

  // Manual trigger: promote due pending reveals into the served set.
  async reveal(ref: Ref, now?: string): Promise<boolean> {
    const nowMs = this.#resolveNow(now);
    return this.#releaseDue(ref.plaintext_id, nowMs);
  }

  // The served (mirror-visible) capabilities for an object. Pending reveals are
  // withheld and never appear here until released.
  caps(plaintextId: string): readonly Capability[] {
    return this.#caps.get(plaintextId) ?? [];
  }

  rawObject(id: string): EncryptedObject | undefined {
    return this.#objects.get(id);
  }

  // The current (latest) object for a plaintext id — follows key rotation, so a
  // mirror or viewer always sees the live ciphertext. Undefined if not stored.
  current(plaintextId: string): EncryptedObject | undefined {
    const id = this.#current.get(plaintextId);
    return id === undefined ? undefined : this.#objects.get(id);
  }

  verify(id: string): boolean {
    const object = this.#objects.get(id);
    return object !== undefined && address(object.ciphertext) === id;
  }

  // Resolve an optional ISO-8601 clock to epoch ms; default = now. A
  // defined-but-unparseable timestamp is a caller error, not a silent denial.
  #resolveNow(now?: string): number {
    if (now === undefined) {
      return Date.now();
    }
    const ms = Date.parse(now);
    if (Number.isNaN(ms)) {
      throw new RangeError(`invalid now timestamp: ${now}`);
    }
    return ms;
  }

  // The key-release event: move pending reveals whose not_before <= nowMs into
  // the served #caps set. Returns true if anything was released.
  #releaseDue(plaintextId: string, nowMs: number): boolean {
    const pend = this.#pending.get(plaintextId);
    if (pend === undefined || pend.length === 0) {
      return false;
    }
    const due = pend.filter((c) => Date.parse(c.not_before) <= nowMs);
    if (due.length === 0) {
      return false;
    }
    this.#pending.set(
      plaintextId,
      pend.filter((c) => Date.parse(c.not_before) > nowMs)
    );
    const served = this.#caps.get(plaintextId) ?? [];
    served.push(...due);
    this.#caps.set(plaintextId, served);
    return true;
  }

  // Returns the capability for did within the plaintext object, if valid at nowMs.
  #capabilityFor(
    plaintextId: string,
    did: string,
    nowMs: number
  ): Capability | undefined {
    return (this.#caps.get(plaintextId) ?? []).find(
      (c) =>
        c.grantee === did &&
        verifyCapability(c) &&
        Date.parse(c.not_before) <= nowMs
    );
  }

  // Resolves the content key for who by locating and unwrapping their capability.
  // Throws AccessDenied if who has no valid capability at nowMs.
  #contentKeyVia(
    plaintextId: string,
    who: Identity,
    nowMs: number
  ): Uint8Array {
    const cap = this.#capabilityFor(plaintextId, who.did, nowMs);
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
