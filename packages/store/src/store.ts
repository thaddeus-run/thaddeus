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

interface RecallRecord {
  readonly object: EncryptedObject;
  readonly caps: readonly Capability[];
  readonly pending: readonly Capability[];
}

type RecallJournal =
  | { readonly phase: 'prepared'; readonly recall: RecallRecord }
  | { readonly phase: 'applied' };

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
  scheduleReveal(ref: Ref, at: string, by: Identity): Promise<Capability>;
  // Pending public capabilities are sensitive until their start time. This
  // accessor exists for owner-authorized server transport and key rotation;
  // ordinary pull/mirror responses must continue to use `caps()` only.
  pendingReveals(plaintextId: string): readonly Capability[];
  ingestReveal(capability: Capability): Promise<boolean>;
  // `now`: same trusted/test-only clock injection as `get` (see above).
  reveal(ref: Ref, now?: string): Promise<boolean>;
  revealDue(now?: string): Promise<number>;
  // Returns ONLY the served (mirror-visible) capabilities. Pending reveals are
  // withheld here until released; never route a wrapped_key capability through
  // this return type before it has been promoted to the served set.
  caps(plaintextId: string): readonly Capability[];
  rawObject(id: string): EncryptedObject | undefined;
  current(plaintextId: string): EncryptedObject | undefined;
  verify(id: string): boolean;
  ingest(object: EncryptedObject, caps: readonly Capability[]): Promise<void>;
  // Atomically replace ciphertext, served capabilities, and pending reveals
  // through a recoverable journal. Used by owner-authorized recall.
  ingestRecall(
    object: EncryptedObject,
    caps: readonly Capability[],
    pending: readonly Capability[]
  ): Promise<void>;
}

// In-memory hot cache; durable when constructed with a `Backend` (write-through
// + `MemoryStore.open`). Spike — single process, not concurrency-safe.
export class MemoryStore implements Store {
  readonly #objects: Map<string, EncryptedObject> = new Map();
  readonly #current: Map<string, string> = new Map();
  readonly #caps: Map<string, Capability[]> = new Map();
  readonly #pending: Map<string, Capability[]> = new Map();
  readonly #preparedRecalls: Map<string, RecallRecord> = new Map();
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
    // A recall journal is the commit record for a ciphertext rotation. Replay
    // it after loading ordinary records so a crash between the individual
    // backend writes cannot strand the new ciphertext without its reveal.
    for (const key of await backend.list('recall/')) {
      const bytes = await backend.get(key);
      if (bytes === undefined) {
        continue;
      }
      let journal: RecallJournal;
      try {
        journal = decodeRecord(bytes) as RecallJournal;
      } catch {
        continue;
      }
      const plaintextId = key.slice('recall/'.length);
      if (journal.phase === 'applied') {
        await backend.delete(key).catch(() => {});
        continue;
      }
      try {
        store.#validateRecall(journal.recall, plaintextId, false);
      } catch {
        continue;
      }
      store.#preparedRecalls.set(plaintextId, journal.recall);
      await store.#finishRecall(plaintextId, journal.recall);
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
    await this.#settleRecall(object.plaintext_id);
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
  // caps, write through (persist-first), then update the hot maps. Persist-first
  // so a failed backend write leaves neither map nor backend updated — no
  // visible-but-non-durable state.
  //
  // Caps are AUTHORITATIVE-REPLACE: the pushed set overwrites the stored set
  // entirely, so callers MUST push the full cap set for the object — not a
  // delta — or previously stored caps will be silently dropped.
  async ingest(
    object: EncryptedObject,
    caps: readonly Capability[]
  ): Promise<void> {
    await this.#settleRecall(object.plaintext_id);
    if (address(object.ciphertext) !== object.id) {
      throw new TypeError(
        `refusing to ingest a mis-addressed object: ${object.id}`
      );
    }
    const frozen = Object.freeze(object);
    const valid = caps.filter((c) => verifyCapability(c));
    const previous = this.current(frozen.plaintext_id);
    const replacedKey = previous !== undefined && previous.id !== frozen.id;
    await this.#persist(`obj/${frozen.id}`, frozen);
    await this.#persist(`current/${frozen.plaintext_id}`, frozen.id);
    await this.#persist(`cap/${frozen.plaintext_id}`, valid);
    if (replacedKey) {
      // A pending capability wraps the old content key. Drop it when a peer
      // replaces the ciphertext; an owner-authorized recall can immediately
      // ingest the matching re-wrapped pending capability after this object.
      await this.#persist(`pending/${frozen.plaintext_id}`, []);
    }
    this.#objects.set(frozen.id, frozen);
    this.#current.set(frozen.plaintext_id, frozen.id);
    this.#caps.set(frozen.plaintext_id, valid);
    if (replacedKey) {
      this.#pending.set(frozen.plaintext_id, []);
    }
  }

  // Commit a recall as one recoverable state transition. The backend may not
  // support multi-key transactions, so a single atomic journal record is
  // written first and replayed by open() until every derived record exists.
  async ingestRecall(
    object: EncryptedObject,
    caps: readonly Capability[],
    pending: readonly Capability[]
  ): Promise<void> {
    await this.#settleRecall(object.plaintext_id);
    const recall: RecallRecord = {
      object: Object.freeze(object),
      caps: [...caps],
      pending: [...pending],
    };
    this.#validateRecall(recall, object.plaintext_id, true);
    await this.#persist(`recall/${object.plaintext_id}`, {
      phase: 'prepared',
      recall,
    } satisfies RecallJournal);
    this.#preparedRecalls.set(object.plaintext_id, recall);
    await this.#finishRecall(object.plaintext_id, recall);
  }

  // Decrypt the current ciphertext, then bind what the server served back to
  // the authenticated op's plaintext id. We deliberately do not compare
  // `ref.id`: key rotation replaces ciphertext without minting a new op, while
  // the plaintext address remains stable across re-encryption.
  async get(ref: Ref, reader: Identity, now?: string): Promise<Uint8Array> {
    const nowMs = this.#resolveNow(now);
    await this.#promoteDue(ref.plaintext_id, nowMs);
    const plaintext = decrypt(
      this.#currentObject(ref.plaintext_id),
      this.#contentKeyVia(ref.plaintext_id, reader, nowMs)
    );
    if (address(plaintext) !== ref.plaintext_id) {
      throw new AccessDenied(reader.did);
    }
    return plaintext;
  }

  async grant(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void> {
    await this.#settleRecall(ref.plaintext_id);
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
    await this.#settleRecall(ref.plaintext_id);
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
  // Nothing is served or mirror-visible until a trigger fires (#promoteDue).
  async scheduleReveal(
    ref: Ref,
    at: string,
    by: Identity
  ): Promise<Capability> {
    await this.#settleRecall(ref.plaintext_id);
    // Validate `at` the same way get/reveal validate `now`: a malformed
    // timestamp fails fast here instead of silently parking a reveal whose
    // NaN not_before can never become due.
    this.#resolveNow(at);
    const existing = [
      ...(this.#caps.get(ref.plaintext_id) ?? []),
      ...(this.#pending.get(ref.plaintext_id) ?? []),
    ].find(
      (cap) =>
        cap.grantee === publicIdentity().did &&
        cap.granted_by === by.did &&
        cap.not_before === at
    );
    if (existing !== undefined) {
      return existing;
    }
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
    return cap;
  }

  // Pending reveals are deliberately separate from served capabilities. The
  // server uses this only in owner-authorized scheduling/recall flows.
  pendingReveals(plaintextId: string): readonly Capability[] {
    return this.#pending.get(plaintextId) ?? [];
  }

  // Accept a client-created scheduled public capability. Persist-first keeps a
  // failed backend write invisible; the holder is trusted not to use the
  // well-known public identity to unwrap or publish it before not_before.
  async ingestReveal(capability: Capability): Promise<boolean> {
    await this.#settleRecall(capability.object);
    let valid = false;
    try {
      valid = verifyCapability(capability);
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new TypeError('invalid reveal capability signature');
    }
    if (capability.grantee !== publicIdentity().did) {
      throw new TypeError('reveal capability is not granted to the public');
    }
    if (Number.isNaN(Date.parse(capability.not_before))) {
      throw new TypeError('invalid reveal timestamp');
    }
    if (this.current(capability.object) === undefined) {
      throw new TypeError(`no object for ${capability.object}`);
    }
    const duplicate = [
      ...(this.#caps.get(capability.object) ?? []),
      ...(this.#pending.get(capability.object) ?? []),
    ].some((cap) => this.#sameCapability(cap, capability));
    if (duplicate) {
      return false;
    }
    const pending = [
      ...(this.#pending.get(capability.object) ?? []),
      capability,
    ];
    await this.#persist(`pending/${capability.object}`, pending);
    this.#pending.set(capability.object, pending);
    return true;
  }

  // Manual trigger: promote due pending reveals into the served set.
  async reveal(ref: Ref, now?: string): Promise<boolean> {
    const nowMs = this.#resolveNow(now);
    return this.#promoteDue(ref.plaintext_id, nowMs);
  }

  // Server scheduler entry point: promote every due capability in this store.
  // Returns the number of plaintext objects whose public capability changed.
  async revealDue(now?: string): Promise<number> {
    const nowMs = this.#resolveNow(now);
    let released = 0;
    for (const plaintextId of [...this.#pending.keys()]) {
      if (await this.#promoteDue(plaintextId, nowMs)) {
        released += 1;
      }
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

  // Persist the served copy before removing the withheld copy, then update the
  // hot maps. A failed write leaves the in-memory pending item available for
  // the next scheduler interval; duplicate durable copies are de-duplicated.
  async #promoteDue(plaintextId: string, nowMs: number): Promise<boolean> {
    await this.#settleRecall(plaintextId);
    const pend = this.#pending.get(plaintextId);
    if (pend === undefined || pend.length === 0) {
      return false;
    }
    const due = pend.filter((c) => Date.parse(c.not_before) <= nowMs);
    if (due.length === 0) {
      return false;
    }
    const pending = pend.filter((c) => Date.parse(c.not_before) > nowMs);
    const served = [...(this.#caps.get(plaintextId) ?? [])];
    for (const capability of due) {
      if (
        !served.some((existing) => this.#sameCapability(existing, capability))
      ) {
        served.push(capability);
      }
    }
    await this.#persist(`cap/${plaintextId}`, served);
    await this.#persist(`pending/${plaintextId}`, pending);
    this.#caps.set(plaintextId, served);
    this.#pending.set(plaintextId, pending);
    return true;
  }

  #sameCapability(left: Capability, right: Capability): boolean {
    return (
      left.object === right.object &&
      left.grantee === right.grantee &&
      left.granted_by === right.granted_by &&
      left.not_before === right.not_before
    );
  }

  #validateRecall(
    recall: RecallRecord,
    plaintextId: string,
    requireExisting: boolean
  ): void {
    if (
      recall === null ||
      typeof recall !== 'object' ||
      recall.object === null ||
      typeof recall.object !== 'object' ||
      !Array.isArray(recall.caps) ||
      !Array.isArray(recall.pending) ||
      recall.object.plaintext_id !== plaintextId ||
      address(recall.object.ciphertext) !== recall.object.id
    ) {
      throw new TypeError('invalid recall journal');
    }
    if (requireExisting && this.current(plaintextId) === undefined) {
      throw new TypeError(`no object for ${plaintextId}`);
    }
    if (
      recall.caps.some(
        (cap) => cap.object !== plaintextId || !verifyCapability(cap)
      )
    ) {
      throw new TypeError('invalid recalled capability');
    }
    for (const capability of recall.pending) {
      let valid = false;
      try {
        valid = verifyCapability(capability);
      } catch {
        valid = false;
      }
      if (
        !valid ||
        capability.object !== plaintextId ||
        capability.grantee !== publicIdentity().did ||
        Number.isNaN(Date.parse(capability.not_before))
      ) {
        throw new TypeError('invalid recalled reveal capability');
      }
    }
  }

  async #settleRecall(plaintextId: string): Promise<void> {
    const recall = this.#preparedRecalls.get(plaintextId);
    if (recall !== undefined) {
      await this.#finishRecall(plaintextId, recall);
    }
  }

  async #finishRecall(
    plaintextId: string,
    recall: RecallRecord
  ): Promise<void> {
    const object = Object.freeze(recall.object);
    const caps = [...recall.caps];
    const pending = [...recall.pending];
    await this.#persist(`obj/${object.id}`, object);
    await this.#persist(`current/${object.plaintext_id}`, object.id);
    await this.#persist(`cap/${object.plaintext_id}`, caps);
    await this.#persist(`pending/${object.plaintext_id}`, pending);
    // Mark the journal applied before exposing the new state in memory. A
    // leftover applied marker is cleanup-only and can never roll state back.
    await this.#persist(`recall/${plaintextId}`, {
      phase: 'applied',
    } satisfies RecallJournal);
    this.#objects.set(object.id, object);
    this.#current.set(object.plaintext_id, object.id);
    this.#caps.set(object.plaintext_id, caps);
    this.#pending.set(object.plaintext_id, pending);
    this.#preparedRecalls.delete(plaintextId);
    await this.#backend?.delete(`recall/${plaintextId}`).catch(() => {});
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
    const direct = this.#capabilityFor(plaintextId, who.did, nowMs);
    if (direct !== undefined) {
      return unwrapKey(direct, who);
    }
    const publicCap = this.#capabilityFor(
      plaintextId,
      publicIdentity().did,
      nowMs
    );
    if (publicCap === undefined) {
      throw new AccessDenied(who.did);
    }
    return unwrapKey(publicCap, publicIdentity());
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
