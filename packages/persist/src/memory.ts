import type {
  Backend,
  ConsumeNonceInput,
  ConsumeNonceResult,
  ReplayNonceBackend,
} from '@thaddeus.run/store';

import { consumeNonceState, type NonceExpiration } from './replay';

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

  /** Atomically consumes one nonce within this in-memory backend instance. */
  async consumeNonce(input: ConsumeNonceInput): Promise<ConsumeNonceResult> {
    return consumeNonceState(
      { byKey: this.#nonces, expirations: this.#nonceExpirations },
      input
    ).result;
  }
}
