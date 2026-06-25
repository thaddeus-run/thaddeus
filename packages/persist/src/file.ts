import type { Backend } from '@thaddeus.run/store';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

// Filesystem backend: each key → one percent-encoded file under `root`. Writes
// are temp-file + atomic rename, so a crash never yields a half-written file.
// Zero dependencies beyond node:fs. Flat directory (dir sharding is a later
// optimization); keys never contain a literal '%' collision because encodeKey is
// a bijection.
export class FileBackend implements Backend {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const path = this.#path(key);
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.#path(key)));
    } catch {
      return undefined; // ENOENT (and any read error) → absent
    }
  }

  async list(prefix: string): Promise<readonly string[]> {
    let names: string[];
    try {
      names = await readdir(this.#root);
    } catch {
      return [];
    }
    return names
      .filter((n) => !n.includes('.tmp-'))
      .map(decodeKey)
      .filter((k) => k.startsWith(prefix));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.#path(key));
    } catch {
      // already absent — idempotent
    }
  }

  #path(key: string): string {
    return join(this.#root, encodeKey(key));
  }
}

// Encode an arbitrary key into one safe, flat filename (percent-encode every
// char that isn't filename-safe, including '/'). Bijective, so decodeKey
// recovers the original key exactly.
function encodeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, (c) => {
    const hex = c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    return `%${hex}`;
  });
}

function decodeKey(name: string): string {
  return name.replace(/%([0-9A-F]{2})/g, (_m, h: string) =>
    String.fromCharCode(Number.parseInt(h, 16))
  );
}
