import { type Backend, decodeRecord, encodeRecord } from '@thaddeus.run/store';

import {
  type HeadRecord,
  type HeadVerification,
  verifyHead,
  verifyHeadChain,
} from './head';

const KEY_PATTERN = /^head\/([^/]+)\/(\d{16})$/;

function keyFor(view: string, version: number): string {
  return `head/${encodeURIComponent(view)}/${version.toString().padStart(16, '0')}`;
}

function fail(verification: Exclude<HeadVerification, { ok: true }>): never {
  throw new HeadVerificationError(verification);
}

// Keep caller-owned mutable arrays out of the store and never expose the
// store's own signature bytes through its read APIs.
function copyRecord(record: HeadRecord): HeadRecord {
  return Object.freeze({
    ...record,
    heads: Object.freeze([...record.heads]),
    sig: new Uint8Array(record.sig),
  });
}

export class HeadVerificationError extends Error {
  readonly verification: Exclude<HeadVerification, { ok: true }>;

  constructor(verification: Exclude<HeadVerification, { ok: true }>) {
    super(verification.message);
    this.name = 'HeadVerificationError';
    this.verification = verification;
  }
}

// Durable owner-authored history. There is no mutable current pointer: current
// is always the final record in a completely verified contiguous chain.
export class HeadStore {
  readonly #repo: string;
  readonly #backend: Backend | undefined;
  readonly #histories = new Map<string, HeadRecord[]>();
  #owner: string | undefined;

  constructor(repo: string, backend?: Backend) {
    if (typeof repo !== 'string' || repo.length === 0) {
      throw new TypeError('head store repo must be a non-empty string');
    }
    this.#repo = repo;
    this.#backend = backend;
  }

  static async load(repo: string, backend?: Backend): Promise<HeadStore> {
    const store = new HeadStore(repo, backend);
    if (backend === undefined) {
      return store;
    }
    const grouped = new Map<string, Map<number, HeadRecord>>();
    for (const key of await backend.list('head/')) {
      const match = key.match(KEY_PATTERN);
      if (match === null) {
        throw new Error(`corrupt signed-head key: ${key}`);
      }
      let view: string;
      try {
        view = decodeURIComponent(match[1] ?? '');
      } catch {
        throw new Error(`corrupt signed-head view key: ${key}`);
      }
      if (view.length === 0 || encodeURIComponent(view) !== match[1]) {
        throw new Error(`non-canonical signed-head view key: ${key}`);
      }
      const version = Number(match[2]);
      if (!Number.isSafeInteger(version)) {
        throw new Error(`corrupt signed-head version key: ${key}`);
      }
      const bytes = await backend.get(key);
      if (bytes === undefined) {
        throw new Error(`signed-head record disappeared while loading: ${key}`);
      }
      let record: HeadRecord;
      try {
        record = decodeRecord(bytes) as HeadRecord;
      } catch {
        throw new Error(`corrupt signed-head record: ${key}`);
      }
      const verified = verifyHead(record);
      if (!verified.ok) {
        fail(verified);
      }
      if (
        record.repo !== repo ||
        record.view !== view ||
        record.version !== version ||
        keyFor(view, version) !== key
      ) {
        throw new Error(`signed-head record does not match its key: ${key}`);
      }
      const versions = grouped.get(view) ?? new Map<number, HeadRecord>();
      if (versions.has(version)) {
        throw new Error(
          `conflicting signed-head records at ${view}@${version}`
        );
      }
      versions.set(version, record);
      grouped.set(view, versions);
    }

    for (const [view, versions] of grouped) {
      const chain = [...versions.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, record]) => record);
      const verified = verifyHeadChain(chain, {
        repo,
        view,
        owner: store.#owner,
      });
      if (!verified.ok) {
        fail(verified);
      }
      store.#owner ??= chain[0]?.owner;
      store.#histories.set(view, chain.map(copyRecord));
    }
    return store;
  }

  get owner(): string | undefined {
    return this.#owner;
  }

  views(): readonly string[] {
    return [...this.#histories.keys()].sort();
  }

  history(view: string): readonly HeadRecord[] {
    return (this.#histories.get(view) ?? []).map(copyRecord);
  }

  current(view: string): HeadRecord | undefined {
    const record = this.#histories.get(view)?.at(-1);
    return record === undefined ? undefined : copyRecord(record);
  }

  async bootstrap(record: HeadRecord): Promise<void> {
    const verified = verifyHeadChain([record], {
      repo: this.#repo,
      view: record.view,
      owner: this.#owner,
    });
    if (!verified.ok) {
      fail(verified);
    }
    if (this.#histories.has(record.view)) {
      const current = this.current(record.view);
      if (current?.id === record.id) {
        return;
      }
      fail({
        ok: false,
        code: 'fork',
        message: `signed head view ${record.view} already exists`,
      });
    }
    await this.#write(record);
    this.#owner ??= record.owner;
    this.#histories.set(record.view, [copyRecord(record)]);
  }

  async advance(record: HeadRecord): Promise<void> {
    const history = this.#histories.get(record.view);
    if (history === undefined) {
      fail({
        ok: false,
        code: 'gap',
        message: `signed head view ${record.view} has no genesis record`,
      });
    }
    const recordVerification = verifyHead(record);
    if (!recordVerification.ok) {
      fail(recordVerification);
    }
    const current = history.at(-1);
    if (current?.id === record.id) {
      return;
    }
    if (current !== undefined && record.version <= current.version) {
      fail({
        ok: false,
        code: record.version === current.version ? 'fork' : 'rollback',
        message:
          record.version === current.version
            ? 'head record conflicts at the current version'
            : 'head record is older than the current version',
      });
    }
    if (current !== undefined && record.version > current.version + 1) {
      fail({
        ok: false,
        code: 'gap',
        message: 'head record skips one or more versions',
      });
    }
    const verified = verifyHeadChain([...history, record], {
      repo: this.#repo,
      view: record.view,
      owner: this.#owner,
      prefix: history,
    });
    if (!verified.ok) {
      fail(verified);
    }
    if (record.version !== history.length) {
      fail({
        ok: false,
        code: record.version < history.length ? 'rollback' : 'gap',
        message: 'head record is not the direct successor',
      });
    }
    await this.#write(record);
    history.push(copyRecord(record));
  }

  async import(
    chain: readonly HeadRecord[],
    expectedOwner?: string
  ): Promise<void> {
    const first = chain[0];
    const view = first?.view;
    const local = view === undefined ? [] : this.history(view);
    const verified = verifyHeadChain(chain, {
      repo: this.#repo,
      view,
      owner: expectedOwner ?? this.#owner,
      prefix: local,
    });
    if (!verified.ok) {
      fail(verified);
    }
    if (first === undefined) {
      return;
    }
    for (const record of chain.slice(local.length)) {
      if (record.version === 0) {
        await this.bootstrap(record);
      } else {
        await this.advance(record);
      }
    }
  }

  async #write(record: HeadRecord): Promise<void> {
    if (this.#backend !== undefined) {
      await this.#backend.put(
        keyFor(record.view, record.version),
        encodeRecord(record)
      );
    }
  }
}
