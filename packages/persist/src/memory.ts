import type { Backend } from '@thaddeus.run/store';

// In-memory backend for fast, deterministic tests. Copies bytes in and out so a
// caller cannot mutate stored blobs through a held reference.
export class MemoryBackend implements Backend {
  readonly #map: Map<string, Uint8Array> = new Map();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.#map.set(key, new Uint8Array(bytes));
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
}
