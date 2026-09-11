import {
  assertScanBudget,
  type Backend,
  type ConsumeNonceInput,
  type ConsumeNonceResult,
  MAX_REPLAY_NONCE_CAPACITY,
  type ReplayNonceBackend,
} from '@thaddeus.run/store';
import type { BackendScan } from '@thaddeus.run/store';
import { createHash } from 'node:crypto';
import type { Dir } from 'node:fs';
import {
  access,
  link,
  mkdir,
  opendir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  consumeNonceState,
  type NonceExpiration,
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

interface ReplayNonceCoordinator {
  readonly activeStagingFiles: Set<string>;
  index?: ReplayNonceIndex;
  queue: Promise<void>;
}

const replayNonceCoordinators = new Map<string, ReplayNonceCoordinator>();

/** Shares nonce serialization and indexes across FileBackend instances. */
function replayNonceCoordinator(root: string): ReplayNonceCoordinator {
  const key = resolve(root);
  let coordinator = replayNonceCoordinators.get(key);
  if (coordinator === undefined) {
    coordinator = {
      activeStagingFiles: new Set(),
      queue: Promise.resolve(),
    };
    replayNonceCoordinators.set(key, coordinator);
  }
  return coordinator;
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

// Generic records use 256 hash shards. Legacy flat records remain readable;
// overwrites migrate them lazily. Staging and nonce internals stay invisible.
export class FileBackend implements Backend, ReplayNonceBackend {
  readonly #root: string;
  readonly #nonceCoordinator: ReplayNonceCoordinator;

  get coordinationDomain(): object {
    return this.#nonceCoordinator;
  }

  constructor(root: string) {
    this.#root = root;
    this.#nonceCoordinator = replayNonceCoordinator(root);
  }

  /** Atomically replaces the bytes stored for a generic backend key. */
  async put(key: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const staging = join(this.#root, '.staging');
    await mkdir(staging, { recursive: true });
    const tmp = join(staging, `${process.pid}-${tmpSeq++}`);
    try {
      await mkdir(dirname(this.#path(key)), { recursive: true });
      await writeFile(tmp, bytes);
      await renameWithRetry(tmp, this.#path(key));
      await this.#unlink(this.#legacyPath(key));
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  /**
   * Atomically creates a generic key without replacing an existing record.
   * A hard link publishes the fully written staging file in one operation.
   */
  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    await mkdir(this.#root, { recursive: true });
    const staging = join(this.#root, '.staging');
    await mkdir(staging, { recursive: true });
    const tmp = join(staging, `${process.pid}-${tmpSeq++}`);
    try {
      if (await this.#exists(this.#legacyPath(key))) return false;
      await mkdir(dirname(this.#path(key)), { recursive: true });
      await writeFile(tmp, bytes);
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

  /** Reads a defensive byte copy for a generic backend key when present. */
  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.#path(key)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          return new Uint8Array(await readFile(this.#legacyPath(key)));
        } catch (legacyError) {
          if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT')
            return undefined;
          throw legacyError;
        }
      }
      throw err; // a real read error must surface, not look like "absent"
    }
  }

  /** Traverses shards lazily, counting directory entries against the scan budget. */
  async openScan(prefix: string): Promise<BackendScan> {
    const stack: { directory: Dir; path: string; depth: number }[] = [];
    let done = false;
    const open = async (path: string, depth: number): Promise<void> => {
      try {
        stack.push({ directory: await opendir(path), path, depth });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    };
    await open(this.#root, 0);
    const closeDirectory = async (directory: Dir): Promise<void> => {
      try {
        await directory.close();
      } catch {
        /* BackendScan.close is idempotent. */
      }
    };
    const close = async (): Promise<void> => {
      done = true;
      while (stack.length > 0) await closeDirectory(stack.pop()!.directory);
    };
    return {
      read: async (maxEntries) => {
        assertScanBudget(maxEntries);
        const keys: string[] = [];
        if (done) return { keys, done };
        try {
          for (let inspected = 0; inspected < maxEntries; inspected++) {
            const current = stack.at(-1);
            if (current === undefined) {
              done = true;
              break;
            }
            let entry;
            try {
              entry = await current.directory.read();
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
              entry = null;
            }
            if (entry === null) {
              stack.pop();
              await closeDirectory(current.directory);
              continue;
            }
            const name = String(entry.name);
            if (entry.isDirectory()) {
              if (
                (current.depth === 0 && name === '.records-v1') ||
                (current.depth === 1 && /^[0-9a-f]{2}$/.test(name))
              )
                await open(join(current.path, name), current.depth + 1);
              continue;
            }
            if (!entry.isFile() || current.depth === 1) continue;
            let key: string;
            try {
              key = decodeKey(name);
            } catch {
              continue;
            }
            if (!key.startsWith(prefix)) continue;
            if (current.depth === 0 && (await this.#exists(this.#path(key))))
              continue;
            keys.push(key);
          }
          return { keys, done };
        } catch (error) {
          await close();
          throw error;
        }
      },
      close,
    };
  }

  /**
   * Lists generic keys with a prefix while excluding internal directories.
   * Only regular root files are visible through the generic backend contract.
   */
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

  /** Idempotently deletes a generic backend key. */
  async delete(key: string): Promise<void> {
    // Remove legacy first so a interrupted delete cannot resurrect stale bytes.
    await this.#unlink(this.#legacyPath(key));
    await this.#unlink(this.#path(key));
  }

  async #unlink(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * Atomically consumes a nonce across FileBackend instances in this process.
   * Distributed coordination remains deferred to P14.
   */
  consumeNonce(input: ConsumeNonceInput): Promise<ConsumeNonceResult> {
    const consume = this.#nonceCoordinator.queue.then(() =>
      this.#consumeNonce(input)
    );
    this.#nonceCoordinator.queue = consume.then(
      () => undefined,
      () => undefined
    );
    return consume;
  }

  /** Applies the shared state decision and completes its durable file updates. */
  async #consumeNonce(input: ConsumeNonceInput): Promise<ConsumeNonceResult> {
    validateConsumeNonceInput(input);
    const index = await this.#nonceIndexForConsumption();
    const decision = consumeNonceState(index, input);

    try {
      for (const expired of decision.cleaned) {
        try {
          await unlink(join(this.#nonceDirectory(), expired.key));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (decision.record === undefined) return decision.result;
      return await this.#persistNonceRecord(decision.record, decision.result);
    } catch (error) {
      // The state machine mutates the cached index first. Rebuild from durable
      // records after any storage failure so memory never outruns persistence.
      this.#nonceCoordinator.index = undefined;
      throw error;
    }
  }

  /** Persists an accepted nonce before reporting the consumption as successful. */
  async #persistNonceRecord(
    expiration: NonceExpiration,
    consumed: ConsumeNonceResult
  ): Promise<ConsumeNonceResult> {
    const nonceDir = this.#nonceDirectory();
    const staging = join(nonceDir, REPLAY_NONCE_STAGING_DIRECTORY);
    await mkdir(staging, { recursive: true });
    const tmpName = `${process.pid}-${tmpSeq++}`;
    const tmp = join(staging, tmpName);
    const record: ReplayNonceRecord = {
      v: REPLAY_NONCE_RECORD_VERSION,
      expiresAt: expiration.expiresAt,
    };
    this.#nonceCoordinator.activeStagingFiles.add(tmpName);
    try {
      await writeFile(tmp, JSON.stringify(record));
      await link(tmp, join(nonceDir, expiration.key));
      return consumed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A coordinator outside this process won the atomic link. Validate its
      // record, invalidate our cache, and fail the envelope closed as a replay.
      await this.#readNonceRecord(
        join(nonceDir, expiration.key),
        expiration.key
      );
      this.#nonceCoordinator.index = undefined;
      return {
        status: 'replayed',
        activeCount: consumed.activeCount,
        cleanedCount: consumed.cleanedCount,
      };
    } finally {
      await unlink(tmp).catch(() => {});
      this.#nonceCoordinator.activeStagingFiles.delete(tmpName);
    }
  }

  /**
   * Lazily rebuilds the bounded index using streaming directory iteration.
   * This fails before trusting an unbounded set of durable filenames.
   */
  async #nonceIndexForConsumption(): Promise<ReplayNonceIndex> {
    if (this.#nonceCoordinator.index !== undefined) {
      return this.#nonceCoordinator.index;
    }

    const nonceDir = this.#nonceDirectory();
    await mkdir(nonceDir, { recursive: true });
    await this.#cleanNonceStagingDirectory(nonceDir);
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
    this.#nonceCoordinator.index = { byKey, expirations };
    return this.#nonceCoordinator.index;
  }

  /** Removes abandoned temp records before rebuilding the durable index. */
  async #cleanNonceStagingDirectory(nonceDir: string): Promise<void> {
    const staging = join(nonceDir, REPLAY_NONCE_STAGING_DIRECTORY);
    await mkdir(staging, { recursive: true });
    const directory = await opendir(staging);
    for await (const entry of directory) {
      const name = String(entry.name);
      if (this.#nonceCoordinator.activeStagingFiles.has(name)) continue;
      try {
        await unlink(join(staging, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  /** Reads and validates one versioned durable nonce record. */
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

  /** Returns the hidden directory reserved for durable replay nonce records. */
  #nonceDirectory(): string {
    return join(this.#root, REPLAY_NONCE_DIRECTORY);
  }

  #legacyPath(key: string): string {
    return join(this.#root, encodeKey(key));
  }

  #path(key: string): string {
    const shard = createHash('sha256').update(key).digest('hex').slice(0, 2);
    return join(this.#root, '.records-v1', shard, encodeKey(key));
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
