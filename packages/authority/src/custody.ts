import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { type Backend, decodeRecord, encodeRecord } from '@thaddeus.run/store';
import sodium from 'libsodium-wrappers-sumo';

import {
  type Authority,
  type Authorization,
  internalsOf,
  writeAudit,
} from './authority';
import { digest, utf8 } from './codec';
import { AuthorityError } from './errors';
import { assertPath, type Scope } from './scope';

/**
 * Wraps and unwraps data keys under a root key the custody never sees. A
 * hosted deployment backs this with a KMS; `LocalRootKey` is for development
 * and tests. `context` must be bound into the wrap so a wrapped key copied to
 * another tenant or repository does not unwrap there.
 */
export interface RootKeyProvider {
  readonly id: string;
  wrap(key: Uint8Array, context: Uint8Array): Promise<Uint8Array>;
  unwrap(wrapped: Uint8Array, context: Uint8Array): Promise<Uint8Array>;
}

/**
 * A root key held in this process, for development and tests. It wraps with
 * XChaCha20-Poly1305 and never exposes the key bytes after construction.
 */
export class LocalRootKey implements RootKeyProvider {
  readonly id: string;
  readonly #key: Uint8Array;

  private constructor(key: Uint8Array) {
    this.#key = key;
    // A fingerprint, so a record wrapped under another key is recognizable.
    this.id = `local:${bytesToHex(blake3(utf8(`thaddeus.authority.root\0${bytesToHex(key)}`))).slice(0, 16)}`;
  }

  /** Uses 32 bytes the host keeps outside the repository backend. */
  static fromBytes(bytes: Uint8Array): LocalRootKey {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
      throw new RangeError('a local root key is exactly 32 bytes');
    }
    return new LocalRootKey(new Uint8Array(bytes));
  }

  async wrap(key: Uint8Array, context: Uint8Array): Promise<Uint8Array> {
    await sodium.ready;
    const nonce = sodium.randombytes_buf(
      sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
    );
    const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      key,
      context,
      null,
      nonce,
      this.#key
    );
    const out = new Uint8Array(nonce.length + sealed.length);
    out.set(nonce, 0);
    out.set(sealed, nonce.length);
    return out;
  }

  async unwrap(wrapped: Uint8Array, context: Uint8Array): Promise<Uint8Array> {
    await sodium.ready;
    const size = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    try {
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        wrapped.subarray(size),
        context,
        wrapped.subarray(0, size),
        this.#key
      );
    } catch {
      throw new AuthorityError(
        'decrypt_failed',
        'the data key does not unwrap under this root key and context'
      );
    }
  }
}

// Content as stored: encrypted under the repository's data key, bound to its
// tenant, repository and path.
export interface SealedContent {
  readonly v: 1;
  readonly keyVersion: number;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export interface KeyCustodyOptions {
  readonly authority: Authority;
  readonly backend: Backend;
  readonly root: RootKeyProvider;
}

const KEY_VERSION = 1;

function contentContext(
  tenant: string,
  repo: string,
  path: string,
  keyVersion: number
): Uint8Array {
  return utf8(
    JSON.stringify([
      'thaddeus.authority.content.v1',
      tenant,
      repo,
      path,
      keyVersion,
    ])
  );
}

function dataKeyContext(
  tenant: string,
  repo: string,
  keyVersion: number
): Uint8Array {
  return utf8(
    JSON.stringify(['thaddeus.authority.data-key.v1', tenant, repo, keyVersion])
  );
}

/**
 * Service-managed encryption for repository content. Each repository has a
 * data key, stored only wrapped by the root key. Plaintext goes in through
 * `seal` with an `edit` authorization and comes out through `open` with a
 * `read` authorization; both re-check the authorization when they act and
 * write an audit record. No method returns a key.
 */
export class KeyCustody {
  readonly #authority: Authority;
  readonly #backend: Backend;
  readonly #root: RootKeyProvider;
  readonly #keys = new Map<string, Promise<Uint8Array>>();

  constructor(options: KeyCustodyOptions) {
    if (typeof options.backend.putIfAbsent !== 'function') {
      throw new TypeError('key custody needs a backend with atomic create');
    }
    this.#authority = options.authority;
    this.#backend = options.backend;
    this.#root = options.root;
  }

  /** Encrypts plaintext for `path` under an `edit` authorization. */
  async seal(
    authorization: Authorization,
    path: string,
    plaintext: Uint8Array
  ): Promise<SealedContent> {
    return this.#gate(authorization, 'edit', path, async () => {
      await sodium.ready;
      const key = await this.#dataKey(authorization.tenant, authorization.repo);
      const nonce = sodium.randombytes_buf(
        sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
      );
      const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        contentContext(
          authorization.tenant,
          authorization.repo,
          path,
          KEY_VERSION
        ),
        null,
        nonce,
        key
      );
      await this.#record(authorization, 'plaintext.write', path, 'allow');
      return { v: 1, keyVersion: KEY_VERSION, nonce, ciphertext };
    });
  }

  /**
   * Decrypts content for `path` under a `read` authorization. The audit
   * record is written before the plaintext is returned, and the
   * authorization is checked again after that write, so a revocation that
   * lands meanwhile still withholds the content.
   */
  async open(
    authorization: Authorization,
    path: string,
    sealed: SealedContent
  ): Promise<Uint8Array> {
    return this.#gate(authorization, 'read', path, async () => {
      if (
        sealed === null ||
        typeof sealed !== 'object' ||
        sealed.v !== 1 ||
        sealed.keyVersion !== KEY_VERSION ||
        !(sealed.nonce instanceof Uint8Array) ||
        !(sealed.ciphertext instanceof Uint8Array)
      ) {
        throw new AuthorityError('malformed', 'unsupported sealed content');
      }
      await sodium.ready;
      const key = await this.#dataKey(authorization.tenant, authorization.repo);
      let plaintext: Uint8Array;
      try {
        plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          sealed.ciphertext,
          contentContext(
            authorization.tenant,
            authorization.repo,
            path,
            sealed.keyVersion
          ),
          sealed.nonce,
          key
        );
      } catch {
        throw new AuthorityError(
          'decrypt_failed',
          `the content does not belong to ${authorization.repo}:${path} in this tenant`
        );
      }
      await this.#record(authorization, 'plaintext.read', path, 'allow');
      this.#authority.check(authorization);
      return plaintext;
    });
  }

  // Checks scope, path and the live authorization, runs `work`, and audits a
  // refusal with its code.
  async #gate<T>(
    authorization: Authorization,
    scope: Scope,
    path: string,
    work: () => Promise<T>
  ): Promise<T> {
    const internals = internalsOf(authorization);
    if (internals.authority !== this.#authority) {
      throw new AuthorityError(
        'bad_credential',
        'the authorization came from another authority'
      );
    }
    const event = scope === 'read' ? 'plaintext.read' : 'plaintext.write';
    try {
      assertPath(path);
      if (authorization.scope !== scope) {
        throw new AuthorityError(
          'scope_denied',
          `${event} needs a ${scope} authorization, not ${authorization.scope}`
        );
      }
      if (!authorization.allows(path)) {
        throw new AuthorityError(
          'scope_denied',
          `${path} is outside the authorized paths`
        );
      }
      this.#authority.check(authorization);
      return await work();
    } catch (error) {
      if (error instanceof AuthorityError) {
        await this.#record(authorization, event, path, 'deny', error);
      }
      throw error;
    }
  }

  #record(
    authorization: Authorization,
    event: 'plaintext.read' | 'plaintext.write',
    path: string,
    outcome: 'allow' | 'deny',
    error?: AuthorityError
  ): Promise<void> {
    return writeAudit(this.#authority, {
      tenant: authorization.tenant,
      event,
      outcome,
      actor: authorization.subject,
      principal: authorization.principal,
      subject: authorization.subject,
      kind: authorization.kind,
      credential: authorization.credential,
      scope: authorization.scope,
      repo: authorization.repo,
      paths: [path],
      ...(error === undefined
        ? {}
        : { code: error.code, detail: error.message }),
    });
  }

  // The repository's data key, created on first use. Two creators race on an
  // atomic create; the loser unwraps the winner's key, so both agree.
  #dataKey(tenant: string, repo: string): Promise<Uint8Array> {
    const cacheKey = `${tenant}\n${repo}`;
    let pending = this.#keys.get(cacheKey);
    if (pending === undefined) {
      pending = this.#loadOrCreate(tenant, repo);
      this.#keys.set(cacheKey, pending);
      pending.catch(() => this.#keys.delete(cacheKey));
    }
    return pending;
  }

  async #loadOrCreate(tenant: string, repo: string): Promise<Uint8Array> {
    const key = `authority/key/${tenant}/${digest('thaddeus.authority.name', repo)}/${KEY_VERSION}`;
    const context = dataKeyContext(tenant, repo, KEY_VERSION);
    const existing = await this.#backend.get(key);
    if (existing === undefined) {
      await sodium.ready;
      const fresh = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
      const wrapped = await this.#root.wrap(fresh, context);
      const record = encodeRecord({ v: 1, provider: this.#root.id, wrapped });
      if ((await this.#backend.putIfAbsent?.(key, record)) === true)
        return fresh;
    }
    const bytes = existing ?? (await this.#backend.get(key));
    if (bytes === undefined) {
      throw new Error(`data key record disappeared: ${key}`);
    }
    const record = decodeRecord(bytes) as { wrapped: Uint8Array };
    return this.#root.unwrap(record.wrapped, context);
  }
}
