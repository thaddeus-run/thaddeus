import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import {
  address,
  type Backend,
  decodeRecord,
  encodeRecord,
  type EncryptedObject,
} from '@thaddeus.run/store';
import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_QUOTAS = {
  maxRepositories: 100,
  maxObjects: 100_000,
  maxObjectBytes: 1_073_741_824,
  repositoryCreationLimit: 20,
  objectCreationLimit: 10_000,
  creationWindowMs: 3_600_000,
} as const;
export type QuotaConfig = {
  readonly [K in keyof typeof DEFAULT_QUOTAS]?: number;
};
export type ResolvedQuotas = {
  readonly [K in keyof typeof DEFAULT_QUOTAS]: number;
};

/** Rejects ambiguous, disabled, or overflowing quota configuration at startup. */
export function resolveQuotas(config: QuotaConfig = {}): ResolvedQuotas {
  if (config === null || typeof config !== 'object' || Array.isArray(config))
    throw new TypeError('invalid quotas');
  const result = { ...DEFAULT_QUOTAS, ...config };
  for (const [key, value] of Object.entries(result)) {
    if (
      !Object.hasOwn(DEFAULT_QUOTAS, key) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > Number.MAX_SAFE_INTEGER / 4
    ) {
      throw new RangeError(
        `invalid quota ${key}: expected a positive safe integer`
      );
    }
  }
  return result;
}

export type QuotaCode =
  | 'repository_quota_exceeded'
  | 'object_quota_exceeded'
  | 'object_bytes_quota_exceeded'
  | 'repository_creation_rate_limited'
  | 'object_creation_rate_limited'
  | 'quota_batch_too_large'
  | 'quota_storage_unavailable'
  | 'repository_exists';
export class QuotaError extends Error {
  constructor(
    readonly code: QuotaCode,
    readonly retryAfter?: number
  ) {
    super(code);
  }
}

interface Usage {
  repositories: number;
  objects: number;
  bytes: number;
  repoWindow: number;
  repoCreates: number;
  objectWindow: number;
  objectCreates: number;
}
interface Batch {
  prefix: string;
  usage: Usage;
  changes: Map<string, Uint8Array | undefined>;
  size: number;
  now: number;
  savepoint?: Map<string, { present: boolean; bytes: Uint8Array | undefined }>;
}
interface Journal {
  changes: [string, Uint8Array | undefined][];
}
const PREFIX = 'quota/v1/';
const JOURNAL = `${PREFIX}journal`;
const READY = `${PREFIX}ready`;
// Bound staging and legacy adoption independently of operator-raised quotas.
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_BATCH_KEYS = 1_000_000;
const MAX_ADOPTION_ENTRIES = 100_000;
const hash = (value: string): string =>
  bytesToHex(blake3(new TextEncoder().encode(value)));
const emptyUsage = (): Usage => ({
  repositories: 0,
  objects: 0,
  bytes: 0,
  repoWindow: 0,
  repoCreates: 0,
  objectWindow: 0,
  objectCreates: 0,
});
const queues = new WeakMap<object, Promise<unknown>>();

/** Serializes a backend's quota commits without retaining identity or repo maps. */
function exclusive<T>(backend: Backend, action: () => Promise<T>): Promise<T> {
  const domain = backend.coordinationDomain ?? backend;
  const previous = queues.get(domain) ?? Promise.resolve();
  const next = previous.then(action, action);
  queues.set(domain, next);
  void next
    .finally(() => {
      if (queues.get(domain) === next) queues.delete(domain);
    })
    .catch(() => {});
  return next;
}

/** Durable owner accounting and a bounded redo journal for repository writes. */
export class QuotaAccounting {
  readonly backend: Backend;
  readonly limits: ResolvedQuotas;
  readonly outcomes: Record<QuotaCode | 'committed' | 'recovered', number> = {
    repository_quota_exceeded: 0,
    object_quota_exceeded: 0,
    object_bytes_quota_exceeded: 0,
    repository_creation_rate_limited: 0,
    object_creation_rate_limited: 0,
    quota_batch_too_large: 0,
    quota_storage_unavailable: 0,
    repository_exists: 0,
    committed: 0,
    recovered: 0,
  };
  readonly #raw: Backend;
  readonly #context = new AsyncLocalStorage<Batch>();
  readonly #now: () => number;

  constructor(
    raw: Backend,
    config: QuotaConfig | undefined,
    now: () => number
  ) {
    this.#raw = raw;
    this.limits = resolveQuotas(config);
    this.#now = now;
    this.backend = {
      get: (key) => this.#get(key),
      put: (key, bytes) => this.#stage(key, bytes),
      putIfAbsent: async (key, bytes) => {
        if (this.#context.getStore() === undefined) {
          if (raw.putIfAbsent !== undefined) return raw.putIfAbsent(key, bytes);
          if ((await raw.get(key)) !== undefined) return false;
          await raw.put(key, bytes);
          return true;
        }
        if ((await this.#get(key)) !== undefined) return false;
        await this.#stage(key, bytes);
        return true;
      },
      delete: (key) => this.#stage(key, undefined),
      list: (prefix) => raw.list(prefix),
      openScan: (prefix) => raw.openScan(prefix),
    };
  }

  /** Finishes an interrupted commit before any route observes durable data. */
  async ready(): Promise<void> {
    return exclusive(this.#raw, async () => {
      try {
        await this.#recover();
      } catch {
        throw new QuotaError('quota_storage_unavailable', 1);
      }
    });
  }

  /** Reserves before hot allocation; only successful callbacks publish a journal. */
  async run<T>(
    name: string,
    owner: string,
    create: boolean,
    action: () => Promise<T>
  ): Promise<T> {
    // Cold repository loading can replay store journals during a mutation.
    // Join that repository's reservation instead of waiting on our own queue.
    const active = this.#context.getStore();
    if (active !== undefined) {
      if (create || active.prefix !== `repo/${name}/`)
        throw new QuotaError('quota_storage_unavailable', 1);
      return action();
    }
    return exclusive(this.#raw, async () => {
      try {
        await this.#recover();
        const marker = await this.#raw.get(READY);
        if (marker === undefined) await this.#adopt();
        else if (decodeRecord(marker) !== true)
          throw new Error('invalid quota marker');
        const key = `${PREFIX}owner/${hash(owner)}`;
        const usage = await this.#usage(key);
        const now = this.#now();
        if (!Number.isSafeInteger(now) || now < 0)
          throw new QuotaError('quota_storage_unavailable', 1);
        const batch: Batch = {
          prefix: `repo/${name}/`,
          usage,
          changes: new Map(),
          size: 0,
          now,
        };
        if (
          create &&
          (await this.#raw.get(`repo/${name}/meta/repo`)) !== undefined
        )
          throw new QuotaError('repository_exists');
        if (!create) {
          const metaBytes = await this.#raw.get(`repo/${name}/meta/repo`);
          if (
            metaBytes === undefined ||
            (decodeRecord(metaBytes) as { owner?: string }).owner !== owner
          )
            throw new QuotaError('quota_storage_unavailable', 1);
        }
        if (create) {
          if (usage.repositories >= this.limits.maxRepositories)
            throw new QuotaError('repository_quota_exceeded');
          usage.repositories++;
          this.#rate(batch, 'repo');
        }
        const result = await this.#context.run(batch, action);
        if (batch.changes.size === 0) return result;
        batch.changes.set(key, encodeRecord(batch.usage));
        // The journal is the commit point. A storage failure after this point
        // returns 503; the next request/restart idempotently finishes the commit.
        const undo: Journal['changes'] = [];
        const deleting = [...batch.changes.values()].some(
          (value) => value === undefined
        );
        let undoSize = 0;
        if (!deleting)
          for (const changed of batch.changes.keys()) {
            const old = await this.#raw.get(changed);
            undoSize += old?.byteLength ?? 0;
            if (undoSize > MAX_BATCH_BYTES)
              throw new QuotaError('quota_batch_too_large');
            undo.push([changed, old]);
          }
        await this.#raw.put(
          JOURNAL,
          encodeRecord({ changes: [...batch.changes] } satisfies Journal)
        );
        try {
          await this.#recover(false);
        } catch (error) {
          if (deleting) throw error;
          await this.#raw.put(
            JOURNAL,
            encodeRecord({ changes: undo } satisfies Journal)
          );
          await this.#recover(false);
          throw error;
        }
        this.outcomes.committed++;
        return result;
      } catch (error) {
        if (error instanceof QuotaError) throw error;
        throw new QuotaError('quota_storage_unavailable', 1);
      }
    });
  }

  /** Discards one rejected object's staged records while preserving valid siblings. */
  async object<T>(action: () => Promise<T>): Promise<T> {
    const batch = this.#context.getStore();
    if (batch === undefined) return action();
    const changes: NonNullable<Batch['savepoint']> = new Map();
    batch.savepoint = changes;
    const usage = { ...batch.usage };
    const size = batch.size;
    try {
      return await action();
    } catch (error) {
      for (const [key, previous] of changes) {
        if (previous.present) batch.changes.set(key, previous.bytes);
        else batch.changes.delete(key);
      }
      batch.usage = usage;
      batch.size = size;
      throw error;
    } finally {
      batch.savepoint = undefined;
    }
  }

  /** Rejects new allocation from a bounded upload before opening hot repo maps. */
  async preflight(objects: readonly EncryptedObject[]): Promise<void> {
    const batch = this.#context.getStore();
    if (batch === undefined)
      throw new QuotaError('quota_storage_unavailable', 1);
    const preview = { ...batch, usage: { ...batch.usage } };
    const seen = new Set<string>();
    for (const object of objects) {
      if (seen.has(object.id) || address(object.ciphertext) !== object.id)
        continue;
      seen.add(object.id);
      const bytes = encodeRecord(object);
      const old = await this.#raw.get(`${batch.prefix}obj/${object.id}`);
      this.#objectDelta(preview, bytes, old);
    }
  }

  async #get(key: string): Promise<Uint8Array | undefined> {
    const changes = this.#context.getStore()?.changes;
    return changes?.has(key) === true ? changes.get(key) : this.#raw.get(key);
  }

  /** Checks deltas before retaining bytes, including historical ciphertext versions. */
  async #stage(key: string, bytes: Uint8Array | undefined): Promise<void> {
    const batch = this.#context.getStore();
    if (batch === undefined) {
      if (/^repo\/.*\/obj\/[^/]+$/.test(key))
        throw new QuotaError('quota_storage_unavailable', 1);
      return bytes === undefined
        ? this.#raw.delete(key)
        : this.#raw.put(key, bytes);
    }
    const old = await this.#get(key);
    if (key.startsWith(`${batch.prefix}obj/`)) {
      this.#objectDelta(batch, bytes, old);
    }
    if (
      key === `${batch.prefix}meta/repo` &&
      bytes === undefined &&
      old !== undefined
    )
      batch.usage.repositories--;
    const size =
      batch.size -
      (batch.changes.get(key)?.byteLength ?? 0) +
      (bytes?.byteLength ?? 0) +
      (batch.changes.has(key) ? 0 : key.length * 3);
    if (
      size > MAX_BATCH_BYTES ||
      (!batch.changes.has(key) && batch.changes.size >= MAX_BATCH_KEYS)
    )
      throw new QuotaError('quota_batch_too_large');
    batch.size = size;
    if (batch.savepoint !== undefined && !batch.savepoint.has(key))
      batch.savepoint.set(key, {
        present: batch.changes.has(key),
        bytes: batch.changes.get(key),
      });
    batch.changes.set(
      key,
      bytes === undefined ? undefined : new Uint8Array(bytes)
    );
  }

  /** Applies count, encoded byte and creation-window deltas to one reservation. */
  #objectDelta(
    batch: Batch,
    bytes: Uint8Array | undefined,
    old: Uint8Array | undefined
  ): void {
    const count = Number(bytes !== undefined) - Number(old !== undefined);
    const delta = (bytes?.byteLength ?? 0) - (old?.byteLength ?? 0);
    if (count > 0 && batch.usage.objects + count > this.limits.maxObjects)
      throw new QuotaError('object_quota_exceeded');
    if (delta > 0 && batch.usage.bytes + delta > this.limits.maxObjectBytes)
      throw new QuotaError('object_bytes_quota_exceeded');
    if (count > 0) this.#rate(batch, 'object');
    batch.usage.objects += count;
    batch.usage.bytes += delta;
  }

  /** Uses a durable first-creation-anchored fixed window, including clock rollback. */
  #rate(batch: Batch, kind: 'repo' | 'object'): void {
    const usage = batch.usage;
    const start = kind === 'repo' ? 'repoWindow' : 'objectWindow';
    const count = kind === 'repo' ? 'repoCreates' : 'objectCreates';
    const limit =
      kind === 'repo'
        ? this.limits.repositoryCreationLimit
        : this.limits.objectCreationLimit;
    if (batch.now >= usage[start] + this.limits.creationWindowMs) {
      usage[start] = batch.now;
      usage[count] = 0;
    }
    if (usage[count] >= limit)
      throw new QuotaError(
        kind === 'repo'
          ? 'repository_creation_rate_limited'
          : 'object_creation_rate_limited',
        Math.max(
          1,
          Math.ceil(
            (usage[start] + this.limits.creationWindowMs - batch.now) / 1000
          )
        )
      );
    if (usage[count] === 0) usage[start] = Math.max(usage[start], batch.now);
    usage[count]++;
  }

  /** Trusts only complete nonnegative integer accounting records. */
  async #usage(key: string): Promise<Usage> {
    const bytes = await this.#raw.get(key);
    if (bytes === undefined) return emptyUsage();
    const value = decodeRecord(bytes) as Usage;
    if (
      value === null ||
      typeof value !== 'object' ||
      Object.keys(value).sort().join() !==
        Object.keys(emptyUsage()).sort().join() ||
      Object.values(value).some((n) => !Number.isSafeInteger(n) || n < 0)
    )
      throw new Error('invalid quota accounting');
    return value;
  }

  /** Replays a bounded write set; deleting the journal last makes replay idempotent. */
  async #recover(recovered = true): Promise<void> {
    const bytes = await this.#raw.get(JOURNAL);
    if (bytes === undefined) return;
    if (bytes.byteLength > MAX_BATCH_BYTES * 2)
      throw new Error('invalid quota journal');
    const journal = decodeRecord(bytes) as Journal;
    if (
      !Array.isArray(journal.changes) ||
      journal.changes.length > MAX_BATCH_KEYS + 1
    )
      throw new Error('invalid quota journal');
    for (const entry of journal.changes) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        (entry[1] != null && !(entry[1] instanceof Uint8Array))
      )
        throw new Error('invalid quota journal');
    }
    for (const [key, value] of journal.changes) {
      if (value == null) await this.#raw.delete(key);
      else await this.#raw.put(key, value);
    }
    await this.#raw.delete(JOURNAL);
    if (recovered) this.outcomes.recovered++;
  }

  /** Adopts existing data once with a hard scan budget; oversized stores fail closed. */
  async #adopt(): Promise<void> {
    const owners = new Map<string, Usage>();
    const scan = await this.#raw.openScan('repo/');
    let inspected = 0;
    try {
      while (true) {
        if (inspected >= MAX_ADOPTION_ENTRIES)
          throw new Error('quota adoption budget exceeded');
        const budget = Math.min(256, MAX_ADOPTION_ENTRIES - inspected);
        const page = await scan.read(budget);
        inspected += budget;
        for (const key of page.keys) {
          const match = /^repo\/(.*)\/(meta\/repo|obj\/[^/]+)$/.exec(key);
          if (match === null) continue;
          const metaBytes = await this.#raw.get(`repo/${match[1]}/meta/repo`);
          if (metaBytes === undefined)
            throw new Error('orphaned repository data');
          const meta = decodeRecord(metaBytes) as { owner: string };
          if (
            typeof meta.owner !== 'string' ||
            !meta.owner.startsWith('did:key:')
          )
            throw new Error('invalid repository owner');
          const ownerKey = `${PREFIX}owner/${hash(meta.owner)}`;
          const usage = owners.get(ownerKey) ?? emptyUsage();
          owners.set(ownerKey, usage);
          if (match[2] === 'meta/repo') usage.repositories++;
          else {
            const object = await this.#raw.get(key);
            if (object !== undefined) {
              usage.objects++;
              usage.bytes += object.byteLength;
            }
          }
        }
        if (page.done) break;
      }
    } finally {
      await scan.close();
    }
    const changes: Journal['changes'] = [...owners].map(([key, usage]) => [
      key,
      encodeRecord(usage),
    ]);
    changes.push([READY, encodeRecord(true)]);
    await this.#raw.put(JOURNAL, encodeRecord({ changes } satisfies Journal));
    await this.#recover(false);
  }
}
