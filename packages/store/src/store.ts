import { Identity, PublicIdentity } from '@thaddeus.run/identity';

import { type Backend, decodeRecord, encodeRecord } from './backend';
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
  // `now` is a deterministic-clock injection for tests and trusted callers; it
  // gates `not_before` and can promote a due reveal. It is NOT a request input
  // — never wire it to untrusted callers, who could supply a future time to
  // read an embargoed object early. Omit it in production to use wall-clock.
  get(ref: Ref, reader: Identity, now?: string): Promise<Uint8Array>;
  grant(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void>;
  revoke(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void>;
  scheduleReveal(ref: Ref, at: string, by: Identity): Promise<void>;
  // `now`: same trusted/test-only clock injection as `get` (see above).
  reveal(ref: Ref, now?: string): Promise<boolean>;
  // Returns ONLY the served (mirror-visible) capabilities. Pending reveals are
  // withheld here until released; never route a wrapped_key capability through
  // this return type before it has been promoted to the served set.
  caps(plaintextId: string): readonly Capability[];
  rawObject(id: string): EncryptedObject | undefined;
  current(plaintextId: string): EncryptedObject | undefined;
  verify(id: string): boolean;
  ingest(object: EncryptedObject, caps: readonly Capability[]): Promise<void>;
}

// In-memory hot cache; durable when constructed with a `Backend` (write-through
// + `MemoryStore.open`). Spike — single process, not concurrency-safe.
export class MemoryStore implements Store {
  readonly #objects: Map<string, EncryptedObject> = new Map();
  readonly #current: Map<string, string> = new Map();
  readonly #caps: Map<string, Capability[]> = new Map();
  readonly #pending: Map<string, Capability[]> = new Map();
  readonly #backend: Backend | undefined;

  constructor(backend?: Backend) {
    this.#backend = backend;
  }

  // Rebuild a hot cache from a backend. A content-addressed object whose bytes
  // don't hash to its id is skipped (torn-write safety). A torn/old-version/
  // corrupt record that fails to decode is also skipped, never surfaced as truth.
  // Frozen on load.
  static async open(backend: Backend): Promise<MemoryStore> {
    const store = new MemoryStore(backend);
    for (const key of await backend.list('obj/')) {
      const bytes = await backend.get(key);
      if (bytes === undefined) {
        continue;
      }
      let o: EncryptedObject;
      try {
        o = decodeRecord(bytes) as EncryptedObject;
      } catch {
        continue; // torn/old-version/corrupt record — skip, never surface as truth
      }
      if (address(o.ciphertext) !== o.id) {
        continue; // torn or tampered — never surface as truth
      }
      store.#objects.set(o.id, Object.freeze(o));
    }
    for (const key of await backend.list('current/')) {
      const bytes = await backend.get(key);
      if (bytes === undefined) {
        continue;
      }
      try {
        store.#current.set(
          key.slice('current/'.length),
          decodeRecord(bytes) as string
        );
      } catch {
        continue; // torn/old-version/corrupt record — skip, never surface as truth
      }
    }
    for (const key of await backend.list('cap/')) {
      const bytes = await backend.get(key);
      if (bytes === undefined) {
        continue;
      }
      try {
        store.#caps.set(
          key.slice('cap/'.length),
          decodeRecord(bytes) as Capability[]
        );
      } catch {
        continue; // torn/old-version/corrupt record — skip, never surface as truth
      }
    }
    for (const key of await backend.list('pending/')) {
      const bytes = await backend.get(key);
      if (bytes === undefined) {
        continue;
      }
      try {
        store.#pending.set(
          key.slice('pending/'.length),
          decodeRecord(bytes) as Capability[]
        );
      } catch {
        continue; // torn/old-version/corrupt record — skip, never surface as truth
      }
    }
    return store;
  }

  // Write-through helper: no-op without a backend.
  async #persist(key: string, value: unknown): Promise<void> {
    if (this.#backend !== undefined) {
      await this.#backend.put(key, encodeRecord(value));
    }
  }

  async put(plaintext: Uint8Array, owner: Identity): Promise<Ref> {
    const contentKey = newContentKey();
    const object = Object.freeze(encrypt(plaintext, contentKey));
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
    await this.#persist(`obj/${object.id}`, object);
    await this.#persist(`current/${object.plaintext_id}`, object.id);
    await this.#persist(
      `cap/${object.plaintext_id}`,
      this.#caps.get(object.plaintext_id) ?? []
    );
    return { id: object.id, plaintext_id: object.plaintext_id };
  }

  // Ingest a client-encrypted object + its caps (the untrusted-server path):
  // verify the content-address (reject a mis-addressed blob), keep only valid
  // caps, store frozen, advance `current`, and write through. The server uses
  // this to persist content it cannot itself read.
  //
  // Caps are AUTHORITATIVE-REPLACE: the pushed set overwrites the stored set
  // entirely, so callers MUST push the full cap set for the object — not a
  // delta — or previously stored caps will be silently dropped.
  async ingest(
    object: EncryptedObject,
    caps: readonly Capability[]
  ): Promise<void> {
    if (address(object.ciphertext) !== object.id) {
      throw new TypeError(
        `refusing to ingest a mis-addressed object: ${object.id}`
      );
    }
    const frozen = Object.freeze(object);
    this.#objects.set(frozen.id, frozen);
    this.#current.set(frozen.plaintext_id, frozen.id);
    const valid = caps.filter((c) => verifyCapability(c));
    this.#caps.set(frozen.plaintext_id, valid);
    await this.#persist(`obj/${frozen.id}`, frozen);
    await this.#persist(`current/${frozen.plaintext_id}`, frozen.id);
    await this.#persist(
      `cap/${frozen.plaintext_id}`,
      this.#caps.get(frozen.plaintext_id) ?? []
    );
  }

  async get(ref: Ref, reader: Identity, now?: string): Promise<Uint8Array> {
    const nowMs = this.#resolveNow(now);
    if (this.#releaseDue(ref.plaintext_id, nowMs)) {
      await this.#persist(
        `cap/${ref.plaintext_id}`,
        this.#caps.get(ref.plaintext_id) ?? []
      );
      await this.#persist(
        `pending/${ref.plaintext_id}`,
        this.#pending.get(ref.plaintext_id) ?? []
      );
    }
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
    await this.#persist(`cap/${ref.plaintext_id}`, caps);
  }

  async revoke(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void> {
    const oldKey = this.#contentKeyVia(ref.plaintext_id, by, Date.now());
    const plaintext = decrypt(this.#currentObject(ref.plaintext_id), oldKey);

    // Rotate: new key, re-encrypt, supersede the current object.
    const newKey = newContentKey();
    const rotated = Object.freeze(encrypt(plaintext, newKey));
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
    await this.#persist(`obj/${rotated.id}`, rotated);
    await this.#persist(`current/${ref.plaintext_id}`, rotated.id);
    await this.#persist(
      `cap/${ref.plaintext_id}`,
      this.#caps.get(ref.plaintext_id) ?? []
    );
    await this.#persist(
      `pending/${ref.plaintext_id}`,
      this.#pending.get(ref.plaintext_id) ?? []
    );
  }

  // Schedule a withheld reveal: `by` (who must hold the content key) seals it to
  // the well-known public identity with not_before = at, parked in #pending.
  // Nothing is served or mirror-visible until a trigger fires (#releaseDue).
  async scheduleReveal(ref: Ref, at: string, by: Identity): Promise<void> {
    // Validate `at` the same way get/reveal validate `now`: a malformed
    // timestamp fails fast here instead of silently parking a reveal whose
    // NaN not_before can never become due.
    this.#resolveNow(at);
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
    await this.#persist(`pending/${ref.plaintext_id}`, pend);
  }

  // Manual trigger: promote due pending reveals into the served set.
  async reveal(ref: Ref, now?: string): Promise<boolean> {
    const nowMs = this.#resolveNow(now);
    const released = this.#releaseDue(ref.plaintext_id, nowMs);
    if (released) {
      await this.#persist(
        `cap/${ref.plaintext_id}`,
        this.#caps.get(ref.plaintext_id) ?? []
      );
      await this.#persist(
        `pending/${ref.plaintext_id}`,
        this.#pending.get(ref.plaintext_id) ?? []
      );
    }
    return released;
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
