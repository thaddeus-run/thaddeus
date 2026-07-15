import type { BackendScan } from '@thaddeus.run/store';

export interface PaginationConfig {
  readonly defaultPageSize: number;
  readonly maxPageSize: number;
  readonly maxPageResponseBytes: number;
  readonly cursorCapacity: number;
  readonly cursorTtlMs: number;
}

export interface PageRequest {
  readonly limit: number;
  readonly cursor?: string;
}

export interface PageSource<T> {
  read(maxEntries: number): Promise<{
    items: readonly T[];
    done: boolean;
  }>;
  close(): Promise<void>;
}

export type PaginationErrorCode =
  | 'invalid_pagination'
  | 'pagination_cursor_invalid'
  | 'pagination_snapshot_changed'
  | 'pagination_capacity_exceeded'
  | 'page_item_too_large';

export class PaginationError extends Error {
  readonly code: PaginationErrorCode;
  readonly status: number;

  constructor(code: PaginationErrorCode) {
    super(code);
    this.name = 'PaginationError';
    this.code = code;
    this.status =
      code === 'invalid_pagination'
        ? 400
        : code === 'pagination_cursor_invalid'
          ? 410
          : code === 'pagination_snapshot_changed'
            ? 409
            : code === 'pagination_capacity_exceeded'
              ? 429
              : 422;
  }
}

interface CursorSession {
  readonly binding: string;
  readonly revision: number;
  readonly revisionNow: () => number;
  readonly source: BufferedPageSource<unknown>;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface PageInput<T> {
  readonly request: PageRequest;
  readonly binding: string;
  readonly revisionNow: () => number;
  readonly createSource: () => Promise<PageSource<T>>;
  readonly render: (items: readonly T[], nextCursor: string | null) => unknown;
  readonly maxBytes?: number;
  readonly isWithinLimit?: (body: unknown) => boolean;
}

export interface PageResult {
  readonly body: unknown;
  readonly nextCursor: string | null;
}

const CURSOR_BYTES = 32;
const CURSOR_LENGTH = 43;
const CURSOR_PLACEHOLDER = 'x'.repeat(CURSOR_LENGTH);
const encoder = new TextEncoder();

/** Parses strict, duplicate-free public pagination parameters. */
export function parsePagination(
  url: URL,
  config: Pick<PaginationConfig, 'defaultPageSize' | 'maxPageSize'>
): PageRequest {
  const limits = url.searchParams.getAll('limit');
  const cursors = url.searchParams.getAll('cursor');
  if (limits.length > 1 || cursors.length > 1) {
    throw new PaginationError('invalid_pagination');
  }
  let limit = config.defaultPageSize;
  if (limits.length === 1) {
    const raw = limits[0];
    if (!/^[1-9]\d*$/.test(raw)) {
      throw new PaginationError('invalid_pagination');
    }
    limit = Number(raw);
    if (!Number.isSafeInteger(limit) || limit > config.maxPageSize) {
      throw new PaginationError('invalid_pagination');
    }
  }
  if (cursors.length === 1 && cursors[0].length === 0) {
    throw new PaginationError('invalid_pagination');
  }
  return {
    limit,
    ...(cursors.length === 1 ? { cursor: cursors[0] } : {}),
  };
}

/** Owns one-use continuation sessions and closes every abandoned source. */
export class CursorRegistry {
  readonly #config: PaginationConfig;
  readonly #sessions = new Map<string, CursorSession>();
  #closed = false;

  constructor(config: PaginationConfig) {
    this.#config = config;
  }

  get activeCount(): number {
    return this.#sessions.size;
  }

  async page<T>(input: PageInput<T>): Promise<PageResult> {
    if (this.#closed) {
      throw new PaginationError('pagination_cursor_invalid');
    }
    const initialRevision = input.revisionNow();
    await this.#cleanupExpired();
    let source: BufferedPageSource<T>;
    let capturedRevision: number;
    if (input.request.cursor === undefined) {
      capturedRevision = initialRevision;
      source = new BufferedPageSource(await input.createSource());
    } else {
      const session = this.#take(input.request.cursor);
      if (session === undefined || session.binding !== input.binding) {
        if (session !== undefined) await session.source.close();
        throw new PaginationError('pagination_cursor_invalid');
      }
      capturedRevision = session.revision;
      source = session.source as BufferedPageSource<T>;
    }

    if (
      capturedRevision % 2 !== 0 ||
      input.revisionNow() !== capturedRevision
    ) {
      await source.close();
      throw new PaginationError('pagination_snapshot_changed');
    }

    try {
      const chunk = await source.read(input.request.limit);
      if (chunk.items.length > input.request.limit) {
        throw new Error('page source exceeded its read budget');
      }
      let items = [...chunk.items];
      let done = chunk.done;
      let body = input.render(items, done ? null : CURSOR_PLACEHOLDER);
      const maxBytes = input.maxBytes ?? this.#config.maxPageResponseBytes;
      while (
        encodedBytes(body) > maxBytes ||
        (input.isWithinLimit !== undefined && !input.isWithinLimit(body))
      ) {
        const item = items.pop();
        if (item === undefined) {
          throw new PaginationError('page_item_too_large');
        }
        source.prepend(item);
        done = false;
        if (items.length === 0) {
          throw new PaginationError('page_item_too_large');
        }
        body = input.render(items, CURSOR_PLACEHOLDER);
      }
      if (input.revisionNow() !== capturedRevision) {
        throw new PaginationError('pagination_snapshot_changed');
      }
      if (done) {
        await source.close();
        return { body: input.render(items, null), nextCursor: null };
      }
      const nextCursor = await this.#store({
        binding: input.binding,
        revision: capturedRevision,
        revisionNow: input.revisionNow,
        source: source as BufferedPageSource<unknown>,
        expiresAt: Date.now() + this.#config.cursorTtlMs,
      });
      return {
        body: input.render(items, nextCursor),
        nextCursor,
      };
    } catch (error) {
      await source.close();
      throw error;
    }
  }

  /** Idempotently invalidates every outstanding cursor and releases resources. */
  async close(): Promise<void> {
    if (this.#closed && this.#sessions.size === 0) return;
    this.#closed = true;
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(
      sessions.map(async (session) => {
        if (session.timer !== undefined) clearTimeout(session.timer);
        await session.source.close();
      })
    );
  }

  #take(token: string): CursorSession | undefined {
    const session = this.#sessions.get(token);
    if (session === undefined) return undefined;
    // Delete synchronously before any await so concurrent replay has one winner.
    this.#sessions.delete(token);
    if (session.timer !== undefined) clearTimeout(session.timer);
    if (session.expiresAt <= Date.now()) {
      void session.source.close();
      return undefined;
    }
    return session;
  }

  async #store(session: CursorSession): Promise<string> {
    await this.#cleanupExpired();
    if (this.#sessions.size >= this.#config.cursorCapacity) {
      await session.source.close();
      throw new PaginationError('pagination_capacity_exceeded');
    }
    let token: string;
    do {
      token = Buffer.from(
        crypto.getRandomValues(new Uint8Array(CURSOR_BYTES))
      ).toString('base64url');
    } while (this.#sessions.has(token));
    session.expiresAt = Date.now() + this.#config.cursorTtlMs;
    session.timer = setTimeout(
      () => {
        if (this.#sessions.get(token) !== session) return;
        this.#sessions.delete(token);
        void session.source.close();
      },
      this.#config.cursorTtlMs
    );
    session.timer.unref?.();
    this.#sessions.set(token, session);
    return token;
  }

  async #cleanupExpired(): Promise<void> {
    const current = Date.now();
    const expired: CursorSession[] = [];
    for (const [token, session] of this.#sessions) {
      if (session.expiresAt > current) continue;
      this.#sessions.delete(token);
      if (session.timer !== undefined) clearTimeout(session.timer);
      expired.push(session);
    }
    await Promise.all(expired.map((session) => session.source.close()));
  }
}

/** Adds pushback needed when response-byte packing stops before a source page. */
class BufferedPageSource<T> implements PageSource<T> {
  readonly #source: PageSource<T>;
  readonly #pending: T[] = [];
  #closed = false;

  constructor(source: PageSource<T>) {
    this.#source = source;
  }

  prepend(item: T): void {
    this.#pending.unshift(item);
  }

  async read(
    maxEntries: number
  ): Promise<{ items: readonly T[]; done: boolean }> {
    const items = this.#pending.splice(0, maxEntries);
    if (items.length === maxEntries) return { items, done: false };
    const page = await this.#source.read(maxEntries - items.length);
    items.push(...page.items);
    return { items, done: page.done && this.#pending.length === 0 };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending.length = 0;
    await this.#source.close();
  }
}

export function arrayPageSource<T>(items: readonly T[]): PageSource<T> {
  let offset = 0;
  return {
    read: async (maxEntries) => {
      const page = items.slice(offset, offset + maxEntries);
      offset += page.length;
      return { items: page, done: offset >= items.length };
    },
    close: async () => {
      offset = items.length;
    },
  };
}

/** Adapts an async generator while pulling no more than the requested budget. */
export function asyncIteratorPageSource<T>(
  iterator: AsyncIterator<T>
): PageSource<T> {
  let done = false;
  return {
    read: async (maxEntries) => {
      const items: T[] = [];
      for (let inspected = 0; inspected < maxEntries; inspected += 1) {
        const entry = await iterator.next();
        if (entry.done === true) {
          done = true;
          break;
        }
        items.push(entry.value);
      }
      return { items, done };
    },
    close: async () => {
      if (done) return;
      done = true;
      await iterator.return?.();
    },
  };
}

/** Maps one bounded backend scan page without ever falling back to `list()`. */
export function backendPageSource<T>(
  scan: BackendScan,
  map: (key: string) => Promise<T | undefined>
): PageSource<T> {
  return {
    read: async (maxEntries) => {
      const page = await scan.read(maxEntries);
      const items: T[] = [];
      for (const key of page.keys) {
        const item = await map(key);
        if (item !== undefined) items.push(item);
      }
      return { items, done: page.done };
    },
    close: () => scan.close(),
  };
}

export function paginationErrorBody(error: PaginationError): {
  error: string;
  code: PaginationErrorCode;
} {
  const messages: Record<PaginationErrorCode, string> = {
    invalid_pagination: 'invalid pagination parameters',
    pagination_cursor_invalid: 'pagination cursor is invalid',
    pagination_snapshot_changed: 'pagination snapshot changed',
    pagination_capacity_exceeded: 'pagination cursor capacity exceeded',
    page_item_too_large: 'stored page item is too large',
  };
  return { error: messages[error.code], code: error.code };
}

function encodedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}
