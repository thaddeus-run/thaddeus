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

// Process-local monotonic counter — used to make temp-file names unique within
// a single process, preventing same-key concurrent puts from clobbering each
// other's temp file.
let tmpSeq = 0;

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
    const tmp = `${path}.tmp-${process.pid}-${tmpSeq++}`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.#path(key)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined; // absent
      }
      throw err; // a real read error must surface, not look like "absent"
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
      .filter((n) => !/\.tmp-\d+-\d+$/.test(n))
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

// Encode an arbitrary key into one safe, flat filename. Uses encodeURIComponent
// which is bijective for all Unicode (including non-ASCII and '/'), and leaves
// common safe chars readable. decodeURIComponent is the exact inverse.
function encodeKey(key: string): string {
  return encodeURIComponent(key);
}

function decodeKey(name: string): string {
  return decodeURIComponent(name);
}
