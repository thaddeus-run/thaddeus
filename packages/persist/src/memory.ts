import {
  type Backend,
  type BackendScan,
  type ConsumeNonceInput,
  type ConsumeNonceResult,
  type ReplayNonceBackend,
  scanKeys,
} from '@thaddeus.run/store';

import { consumeNonceState, type NonceExpiration } from './replay';

// In-memory backend for fast, deterministic tests. Copies bytes in and out so a
// caller cannot mutate stored blobs through a held reference.
export class MemoryBackend implements Backend, ReplayNonceBackend {
  readonly #map: Map<string, Uint8Array> = new Map();
  readonly #nonces = new Map<string, number>();
  readonly #nonceExpirations: NonceExpiration[] = [];

  /** Stores a defensive byte copy for a generic backend key. */
  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.#map.set(key, new Uint8Array(bytes));
  }

  /** Stores a generic key only when it is not already present. */
  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    if (this.#map.has(key)) {
      return false;
    }
    this.#map.set(key, new Uint8Array(bytes));
    return true;
  }

  /** Reads a defensive byte copy for a generic backend key when present. */
  async get(key: string): Promise<Uint8Array | undefined> {
    const v = this.#map.get(key);
    return v === undefined ? undefined : new Uint8Array(v);
  }

  /** Opens a lazy scan over the map without copying the remaining keyspace. */
  async openScan(prefix: string): Promise<BackendScan> {
    return scanKeys(this.#map.keys(), prefix);
  }

  /** Lists generic in-memory keys that begin with the supplied prefix. */
  async list(prefix: string): Promise<readonly string[]> {
    const scan = await this.openScan(prefix);
    const keys: string[] = [];
    try {
      while (true) {
        const page = await scan.read(1_024);
        keys.push(...page.keys);
        if (page.done) return keys;
      }
    } finally {
      await scan.close();
    }
  }

  /** Idempotently deletes a generic in-memory backend key. */
  async delete(key: string): Promise<void> {
    this.#map.delete(key);
  }

  /** Atomically consumes one nonce within this in-memory backend instance. */
  async consumeNonce(input: ConsumeNonceInput): Promise<ConsumeNonceResult> {
    return consumeNonceState(
      { byKey: this.#nonces, expirations: this.#nonceExpirations },
      input
    ).result;
  }
}
