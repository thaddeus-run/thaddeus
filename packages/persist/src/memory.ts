import type {
  Backend,
  ConsumeNonceInput,
  ConsumeNonceResult,
  ReplayNonceBackend,
} from '@thaddeus.run/store';

import {
  type NonceExpiration,
  popExpiration,
  pushExpiration,
  validateConsumeNonceInput,
} from './replay';

// In-memory backend for fast, deterministic tests. Copies bytes in and out so a
// caller cannot mutate stored blobs through a held reference.
export class MemoryBackend implements Backend, ReplayNonceBackend {
  readonly #map: Map<string, Uint8Array> = new Map();
  readonly #nonces = new Map<string, number>();
  readonly #nonceExpirations: NonceExpiration[] = [];

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.#map.set(key, new Uint8Array(bytes));
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    if (this.#map.has(key)) {
      return false;
    }
    this.#map.set(key, new Uint8Array(bytes));
    return true;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const v = this.#map.get(key);
    return v === undefined ? undefined : new Uint8Array(v);
  }

  async list(prefix: string): Promise<readonly string[]> {
    return [...this.#map.keys()].filter((k) => k.startsWith(prefix));
  }

  async delete(key: string): Promise<void> {
    this.#map.delete(key);
  }

  async consumeNonce(input: ConsumeNonceInput): Promise<ConsumeNonceResult> {
    validateConsumeNonceInput(input);
    let cleanedCount = 0;
    for (;;) {
      const first = this.#nonceExpirations[0];
      // A nonce remains live at its exact expiry boundary.
      if (first === undefined || first.expiresAt >= input.now) break;
      const expired = popExpiration(this.#nonceExpirations);
      if (
        expired !== undefined &&
        this.#nonces.get(expired.key) === expired.expiresAt
      ) {
        this.#nonces.delete(expired.key);
        cleanedCount += 1;
      }
    }

    if (this.#nonces.has(input.key)) {
      return {
        status: 'replayed',
        activeCount: this.#nonces.size,
        cleanedCount,
      };
    }
    if (this.#nonces.size >= input.capacity) {
      const first = this.#nonceExpirations[0];
      if (first === undefined) {
        throw new Error('replay nonce index is inconsistent');
      }
      return {
        status: 'capacity',
        activeCount: this.#nonces.size,
        cleanedCount,
        retryAt: first.expiresAt + 1,
      };
    }

    this.#nonces.set(input.key, input.expiresAt);
    pushExpiration(this.#nonceExpirations, input);
    return {
      status: 'consumed',
      activeCount: this.#nonces.size,
      cleanedCount,
    };
  }
}
