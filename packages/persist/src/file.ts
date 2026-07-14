import {
  type Backend,
  type ConsumeNonceInput,
  type ConsumeNonceResult,
  MAX_REPLAY_NONCE_CAPACITY,
  type ReplayNonceBackend,
} from '@thaddeus.run/store';
import {
  link,
  mkdir,
  opendir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import {
  type NonceExpiration,
  popExpiration,
  pushExpiration,
  validateConsumeNonceInput,
} from './replay';

// Process-local monotonic counter — used to make temp-file names unique within
// a single process, preventing same-key concurrent puts from clobbering each
// other's temp file.
let tmpSeq = 0;

const REPLAY_NONCE_DIRECTORY = '.replay-nonces-v1';
const REPLAY_NONCE_STAGING_DIRECTORY = '.staging';
const REPLAY_NONCE_RECORD_VERSION = 'thaddeus-replay-nonce-v1';

interface ReplayNonceRecord {
  readonly v: typeof REPLAY_NONCE_RECORD_VERSION;
  readonly expiresAt: number;
}

interface ReplayNonceIndex {
  readonly byKey: Map<string, number>;
  readonly expirations: NonceExpiration[];
}

// Codes for a transient lock on the rename destination (a virus scanner or the
// Windows Search indexer momentarily holding the file) — worth retrying. A
// non-transient error (ENOSPC, EROFS, …) is not retried.
const TRANSIENT_RENAME_ERRORS = new Set([
  'EPERM',
  'EACCES',
  'EBUSY',
  'ENOTEMPTY',
]);

// Rename `from` → `to`, retrying on a transient lock. On Windows `rename` over a
// live destination fails intermittently with EPERM/EBUSY while another process
// briefly holds it; a short backoff clears it. Atomicity is preserved — this is
// still a single rename, we just tolerate the lock. On final failure the temp
// file is cleaned up so `.staging/` never accumulates orphans.
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (
        attempt >= 10 ||
        code === undefined ||
        !TRANSIENT_RENAME_ERRORS.has(code)
      ) {
        await unlink(from).catch(() => {});
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

// Filesystem backend: each key → one percent-encoded file under `root`. Writes
// go through a `.staging/` subdir (same filesystem → atomic rename), so a
// crash never yields a half-written file and staging files never appear in
// `list`. Zero dependencies beyond node:fs. Flat directory (dir sharding is a
// later optimization); keys never contain a literal '%' collision because
// encodeKey is a bijection.
export class FileBackend implements Backend, ReplayNonceBackend {
  readonly #root: string;
  #nonceIndex: ReplayNonceIndex | undefined;
  #nonceQueue: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.#root = root;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const staging = join(this.#root, '.staging');
    await mkdir(staging, { recursive: true });
    const tmp = join(staging, `${process.pid}-${tmpSeq++}`);
    await writeFile(tmp, bytes);
    await renameWithRetry(tmp, this.#path(key));
  }

  // Link a fully written staging file into place. A hard link is an atomic
  // create-if-absent operation on the same filesystem and never replaces an
  // existing monotonic record.
  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    await mkdir(this.#root, { recursive: true });
    const staging = join(this.#root, '.staging');
    await mkdir(staging, { recursive: true });
    const tmp = join(staging, `${process.pid}-${tmpSeq++}`);
    await writeFile(tmp, bytes);
    try {
      await link(tmp, this.#path(key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw error;
    } finally {
      await unlink(tmp).catch(() => {});
    }
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

  // Returns only regular files in root, auto-excluding the .staging subdir and
  // any other directories. No regex filter needed — directories simply don't
  // pass isFile().
  async list(prefix: string): Promise<readonly string[]> {
    let names: string[];
    try {
      const entries = await readdir(this.#root, { withFileTypes: true });
      // String(d.name) is the cast-free way to obtain a string regardless of
      // whether the runtime Dirent carries a Buffer or a string for d.name.
      names = entries.filter((d) => d.isFile()).map((d) => String(d.name));
    } catch {
      return [];
    }
    const keys: string[] = [];
    for (const name of names) {
      let key: string;
      try {
        // decodeURIComponent throws URIError on a malformed name (e.g. `%GG`);
        // a stray/undecodable file is skipped, not fatal — matching the
        // defensive per-record decode in MemoryStore.open / OpLog.load.
        key = decodeKey(name);
      } catch {
        continue;
      }
      if (key.startsWith(prefix)) {
        keys.push(key);
      }
    }
    return keys;
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.#path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return; // already absent — idempotent
      }
      throw err; // a real error must surface, not look like success
    }
  }

  // Serializing consumption within this instance makes capacity checks, atomic
  // links, and index updates one coordination domain. FileBackend intentionally
  // remains a single-process backend; distributed CAS is deferred to P14.
  consumeNonce(input: ConsumeNonceInput): Promise<ConsumeNonceResult> {
    const consume = this.#nonceQueue.then(() => this.#consumeNonce(input));
    this.#nonceQueue = consume.then(
      () => undefined,
      () => undefined
    );
    return consume;
  }

  async #consumeNonce(input: ConsumeNonceInput): Promise<ConsumeNonceResult> {
    validateConsumeNonceInput(input);
    const index = await this.#nonceIndexForConsumption();
    const cleanedCount = await this.#cleanExpiredNonces(index, input.now);

    if (index.byKey.has(input.key)) {
      return {
        status: 'replayed',
        activeCount: index.byKey.size,
        cleanedCount,
      };
    }
    if (index.byKey.size >= input.capacity) {
      const first = index.expirations[0];
      if (first === undefined) {
        throw new Error('replay nonce index is inconsistent');
      }
      return {
        status: 'capacity',
        activeCount: index.byKey.size,
        cleanedCount,
        retryAt: first.expiresAt + 1,
      };
    }

    const nonceDir = this.#nonceDirectory();
    const staging = join(nonceDir, REPLAY_NONCE_STAGING_DIRECTORY);
    await mkdir(staging, { recursive: true });
    const tmp = join(staging, `${process.pid}-${tmpSeq++}`);
    const record: ReplayNonceRecord = {
      v: REPLAY_NONCE_RECORD_VERSION,
      expiresAt: input.expiresAt,
    };
    await writeFile(tmp, JSON.stringify(record));
    try {
      await link(tmp, join(nonceDir, input.key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Another coordinator won the atomic link. Validate and index its record
      // before reporting the request as a replay; malformed state fails closed.
      if (index.byKey.size >= MAX_REPLAY_NONCE_CAPACITY) {
        throw new Error('replay nonce store exceeds its hard maximum');
      }
      const existing = await this.#readNonceRecord(
        join(nonceDir, input.key),
        input.key
      );
      index.byKey.set(input.key, existing.expiresAt);
      pushExpiration(index.expirations, {
        key: input.key,
        expiresAt: existing.expiresAt,
      });
      return {
        status: 'replayed',
        activeCount: index.byKey.size,
        cleanedCount,
      };
    } finally {
      await unlink(tmp).catch(() => {});
    }

    index.byKey.set(input.key, input.expiresAt);
    pushExpiration(index.expirations, input);
    return {
      status: 'consumed',
      activeCount: index.byKey.size,
      cleanedCount,
    };
  }

  // Rebuild lazily on the first signed request. Streaming directory iteration
  // bounds allocation and lets the hard maximum fail before an unbounded list
  // of attacker-controlled filenames is trusted.
  async #nonceIndexForConsumption(): Promise<ReplayNonceIndex> {
    if (this.#nonceIndex !== undefined) return this.#nonceIndex;

    const nonceDir = this.#nonceDirectory();
    await mkdir(nonceDir, { recursive: true });
    const byKey = new Map<string, number>();
    const expirations: NonceExpiration[] = [];
    const directory = await opendir(nonceDir);
    for await (const entry of directory) {
      const name = String(entry.name);
      if (name === REPLAY_NONCE_STAGING_DIRECTORY && entry.isDirectory()) {
        continue;
      }
      if (!entry.isFile() || !/^[0-9a-f]{64}$/.test(name)) {
        throw new Error('replay nonce store contains a malformed record');
      }
      if (byKey.size >= MAX_REPLAY_NONCE_CAPACITY) {
        throw new Error('replay nonce store exceeds its hard maximum');
      }
      const record = await this.#readNonceRecord(join(nonceDir, name), name);
      byKey.set(name, record.expiresAt);
      pushExpiration(expirations, { key: name, expiresAt: record.expiresAt });
    }
    this.#nonceIndex = { byKey, expirations };
    return this.#nonceIndex;
  }

  async #readNonceRecord(
    path: string,
    expectedKey: string
  ): Promise<ReplayNonceRecord> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error('replay nonce store contains a malformed record');
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Object.keys(parsed).sort().join(',') !== 'expiresAt,v' ||
      (parsed as { v?: unknown }).v !== REPLAY_NONCE_RECORD_VERSION ||
      !Number.isSafeInteger((parsed as { expiresAt?: unknown }).expiresAt) ||
      (parsed as { expiresAt: number }).expiresAt < 0 ||
      !/^[0-9a-f]{64}$/.test(expectedKey)
    ) {
      throw new Error('replay nonce store contains a malformed record');
    }
    return parsed as ReplayNonceRecord;
  }

  async #cleanExpiredNonces(
    index: ReplayNonceIndex,
    now: number
  ): Promise<number> {
    let cleaned = 0;
    for (;;) {
      const first = index.expirations[0];
      if (first === undefined || first.expiresAt >= now) return cleaned;
      try {
        await unlink(join(this.#nonceDirectory(), first.key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      popExpiration(index.expirations);
      if (index.byKey.get(first.key) === first.expiresAt) {
        index.byKey.delete(first.key);
        cleaned += 1;
      }
    }
  }

  #nonceDirectory(): string {
    return join(this.#root, REPLAY_NONCE_DIRECTORY);
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
