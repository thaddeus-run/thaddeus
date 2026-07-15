import { Identity, ready } from '@thaddeus.run/identity';
import { FileBackend, MemoryBackend } from '@thaddeus.run/persist';
import type { Backend, ReplayNonceBackend } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeBundle } from '../src/dto';
import {
  DEFAULT_MAX_FIELD_BYTES,
  DEFAULT_MAX_PAGE_RESPONSE_BYTES,
  DEFAULT_MAX_PAGE_SIZE,
  DEFAULT_MAX_REPUTATION_ARCHIVE_BYTES,
  DEFAULT_MAX_REPUTATION_CONTRIBUTIONS,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  DEFAULT_PAGE_SIZE,
  DEFAULT_PAGINATION_CURSOR_CAPACITY,
  DEFAULT_PAGINATION_CURSOR_TTL_MS,
  resolveLimits,
} from '../src/limits';
import { CursorRegistry, type PageSource } from '../src/pagination';
import { createServer } from '../src/server';
import { signRequest } from '../src/sign';
import { createRepoBody } from './heads';

beforeAll(async () => {
  await ready();
});

function createRequest(name: string, owner: Identity): Request {
  const path = '/repos';
  const body = new TextEncoder().encode(
    JSON.stringify(createRepoBody(name, owner))
  );
  const signed = signRequest(
    'POST',
    path,
    body,
    owner,
    new Date().toISOString()
  );
  return new Request(`http://t${path}`, {
    method: 'POST',
    body,
    headers: {
      'x-thaddeus-did': signed.did,
      'x-thaddeus-timestamp': signed.timestamp,
      'x-thaddeus-nonce': signed.nonce,
      'x-thaddeus-signature': signed.signature,
    },
  });
}

function signedPost(path: string, value: unknown, signer: Identity): Request {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const signed = signRequest(
    'POST',
    path,
    body,
    signer,
    new Date().toISOString()
  );
  return new Request(`http://t${path}`, {
    method: 'POST',
    body,
    headers: {
      'x-thaddeus-did': signed.did,
      'x-thaddeus-timestamp': signed.timestamp,
      'x-thaddeus-nonce': signed.nonce,
      'x-thaddeus-signature': signed.signature,
    },
  });
}

describe('THA-9 limits and pagination', () => {
  test('exports balanced defaults and rejects types, ranges, and relationships', () => {
    expect(resolveLimits({})).toEqual({
      maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
      maxReputationArchiveBytes: DEFAULT_MAX_REPUTATION_ARCHIVE_BYTES,
      maxReputationContributions: DEFAULT_MAX_REPUTATION_CONTRIBUTIONS,
      maxFieldBytes: DEFAULT_MAX_FIELD_BYTES,
      defaultPageSize: DEFAULT_PAGE_SIZE,
      maxPageSize: DEFAULT_MAX_PAGE_SIZE,
      maxPageResponseBytes: DEFAULT_MAX_PAGE_RESPONSE_BYTES,
      paginationCursorCapacity: DEFAULT_PAGINATION_CURSOR_CAPACITY,
      paginationCursorTtlMs: DEFAULT_PAGINATION_CURSOR_TTL_MS,
    });
    const properties = Object.keys(resolveLimits({})) as Array<
      keyof ReturnType<typeof resolveLimits>
    >;
    for (const property of properties) {
      expect(() => resolveLimits({ [property]: '1' } as never)).toThrow(
        TypeError
      );
      expect(() => resolveLimits({ [property]: null } as never)).toThrow(
        TypeError
      );
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => resolveLimits({ [property]: value } as never)).toThrow(
          RangeError
        );
      }
    }
    expect(() => resolveLimits({ defaultPageSize: 2, maxPageSize: 1 })).toThrow(
      RangeError
    );
    expect(() =>
      resolveLimits({
        maxRequestBodyBytes: 10,
        maxReputationArchiveBytes: 11,
        maxFieldBytes: 1,
        maxPageResponseBytes: 11,
      })
    ).toThrow(RangeError);
    expect(() =>
      resolveLimits({
        maxReputationArchiveBytes: 10,
        maxFieldBytes: 11,
      })
    ).toThrow(RangeError);
    expect(() =>
      resolveLimits({
        maxReputationArchiveBytes: 11,
        maxFieldBytes: 1,
        maxPageResponseBytes: 10,
      })
    ).toThrow(RangeError);
  });

  test('real repo pages rotate one-use cursors across empty scan pages', async () => {
    const server = createServer({
      backend: new MemoryBackend(),
      defaultPageSize: 1,
      maxPageSize: 2,
    });
    const owner = Identity.create();
    await server.fetch(createRequest('z', owner));
    await server.fetch(createRequest('a', owner));

    const first = await server.fetch(new Request('http://t/repos?limit=1'));
    const firstBody = (await first.json()) as {
      repos: string[];
      nextCursor: string | null;
    };
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(firstBody.repos.length).toBeLessThanOrEqual(1);
    expect(typeof firstBody.nextCursor).toBe('string');
    const token = firstBody.nextCursor!;

    const continued = await server.fetch(
      new Request(`http://t/repos?cursor=${token}`)
    );
    expect(continued.status).toBe(200);
    const replay = await server.fetch(
      new Request(`http://t/repos?cursor=${token}`)
    );
    expect(replay.status).toBe(410);
    expect(await replay.json()).toMatchObject({
      code: 'pagination_cursor_invalid',
    });
    await server.close();
  });

  test('opaque cursors are not constrained by the logical-field byte limit', async () => {
    const backend = new MemoryBackend();
    const owner = Identity.create();
    const seed = createServer({ backend });
    await seed.fetch(createRequest('a', owner));
    await seed.fetch(createRequest('b', owner));
    await seed.close();

    const server = createServer({
      backend,
      defaultPageSize: 1,
      maxPageSize: 1,
      maxFieldBytes: 42,
    });
    const first = (await (
      await server.fetch(new Request('http://t/repos'))
    ).json()) as { nextCursor: string };
    expect(first.nextCursor.length).toBeGreaterThan(42);
    expect(
      (
        await server.fetch(
          new Request(`http://t/repos?cursor=${first.nextCursor}`)
        )
      ).status
    ).toBe(200);
    await server.close();
  });

  test('rejected writes do not invalidate an authorized repository snapshot', async () => {
    const server = createServer({
      backend: new MemoryBackend(),
      defaultPageSize: 1,
      maxPageSize: 1,
    });
    const owner = Identity.create();
    const attacker = Identity.create();
    await server.fetch(createRequest('guarded', owner));
    const first = (await (
      await server.fetch(new Request('http://t/repos/guarded/views'))
    ).json()) as { nextCursor: string };
    const rejected = await server.fetch(
      signedPost('/repos/guarded/push', encodeBundle([], [], []), attacker)
    );
    expect(rejected.status).toBe(403);
    expect(
      (
        await server.fetch(
          new Request(`http://t/repos/guarded/views?cursor=${first.nextCursor}`)
        )
      ).status
    ).toBe(200);
    await server.close();
  });

  test('concurrent cursor use has one winner and capacity/TTL release resources', async () => {
    const server = createServer({
      backend: new MemoryBackend(),
      defaultPageSize: 1,
      maxPageSize: 1,
      paginationCursorCapacity: 1,
      paginationCursorTtlMs: 10,
    });
    const owner = Identity.create();
    await server.fetch(createRequest('one', owner));
    await server.fetch(createRequest('two', owner));

    const first = (await (
      await server.fetch(new Request('http://t/repos'))
    ).json()) as { nextCursor: string };
    const full = await server.fetch(new Request('http://t/repos'));
    expect(full.status).toBe(429);
    expect(full.headers.get('retry-after')).not.toBeNull();

    const concurrent = await Promise.all([
      server.fetch(new Request(`http://t/repos?cursor=${first.nextCursor}`)),
      server.fetch(new Request(`http://t/repos?cursor=${first.nextCursor}`)),
    ]);
    expect(
      concurrent.map((response) => response.status).sort((a, b) => a - b)
    ).toEqual([200, 410]);
    await server.close();

    const expiring = createServer({
      backend: new MemoryBackend(),
      defaultPageSize: 1,
      maxPageSize: 1,
      paginationCursorCapacity: 1,
      paginationCursorTtlMs: 5,
    });
    await expiring.fetch(createRequest('ttl', owner));
    const expiringFirst = (await (
      await expiring.fetch(new Request('http://t/repos'))
    ).json()) as { nextCursor: string };
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(
      (
        await expiring.fetch(
          new Request(`http://t/repos?cursor=${expiringFirst.nextCursor}`)
        )
      ).status
    ).toBe(410);
    const metrics = await (
      await expiring.fetch(new Request('http://t/metrics'))
    ).text();
    expect(metrics).toContain('thaddeus_pagination_active_cursors 0');
    await expiring.close();
  });

  test('response bytes are inclusive and an irreducible item returns 422', async () => {
    const backend = new MemoryBackend();
    const owner = Identity.create();
    const roomy = createServer({
      backend,
      defaultPageSize: 1,
      maxPageSize: 1,
    });
    await roomy.fetch(createRequest('x'.repeat(64), owner));
    const empty = (await (
      await roomy.fetch(new Request('http://t/repos'))
    ).json()) as { nextCursor: string };
    const itemResponse = await roomy.fetch(
      new Request(`http://t/repos?cursor=${empty.nextCursor}`)
    );
    const itemText = await itemResponse.text();
    const exactBytes = new TextEncoder().encode(itemText).length;
    await roomy.close();

    const exact = createServer({
      backend,
      defaultPageSize: 1,
      maxPageSize: 1,
      maxReputationArchiveBytes: 43,
      maxFieldBytes: 43,
      maxPageResponseBytes: exactBytes,
    });
    const exactEmpty = (await (
      await exact.fetch(new Request('http://t/repos'))
    ).json()) as { nextCursor: string };
    const exactItem = await exact.fetch(
      new Request(`http://t/repos?cursor=${exactEmpty.nextCursor}`)
    );
    expect(exactItem.status).toBe(200);
    expect(new TextEncoder().encode(await exactItem.text())).toHaveLength(
      exactBytes
    );
    await exact.close();

    const tooSmall = createServer({
      backend,
      defaultPageSize: 1,
      maxPageSize: 1,
      maxReputationArchiveBytes: 43,
      maxFieldBytes: 43,
      maxPageResponseBytes: exactBytes - 1,
    });
    const smallEmpty = (await (
      await tooSmall.fetch(new Request('http://t/repos'))
    ).json()) as { nextCursor: string };
    const rejected = await tooSmall.fetch(
      new Request(`http://t/repos?cursor=${smallEmpty.nextCursor}`)
    );
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({
      code: 'page_item_too_large',
    });
    await tooSmall.close();
  });

  test('rejects malformed queries, wrong-route cursors, and changed snapshots', async () => {
    const server = createServer({
      backend: new MemoryBackend(),
      defaultPageSize: 1,
      maxPageSize: 2,
    });
    const owner = Identity.create();
    await server.fetch(createRequest('one', owner));
    await server.fetch(createRequest('two', owner));

    for (const query of [
      'limit=0',
      'limit=+1',
      'limit=01',
      'limit=3',
      'limit=1&limit=1',
      'cursor=',
    ]) {
      const response = await server.fetch(
        new Request(`http://t/repos?${query}`)
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'invalid_pagination',
      });
    }

    const wrongFirst = (await (
      await server.fetch(new Request('http://t/repos?limit=1'))
    ).json()) as { nextCursor: string };
    const wrongRoute = await server.fetch(
      new Request(`http://t/repos/one/views?cursor=${wrongFirst.nextCursor}`)
    );
    expect(wrongRoute.status).toBe(410);

    const changedFirst = (await (
      await server.fetch(new Request('http://t/repos?limit=1'))
    ).json()) as { nextCursor: string };
    await server.fetch(createRequest('three', owner));
    const changed = await server.fetch(
      new Request(`http://t/repos?cursor=${changedFirst.nextCursor}`)
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({
      code: 'pagination_snapshot_changed',
    });
    await server.close();
  });

  test('FileBackend restart invalidates old cursors and serves a fresh scan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'thaddeus-pagination-'));
    try {
      const backend = new FileBackend(root);
      const owner = Identity.create();
      const first = createServer({
        backend,
        defaultPageSize: 1,
        maxPageSize: 1,
      });
      await first.fetch(createRequest('restart', owner));
      const page = (await (
        await first.fetch(new Request('http://t/repos'))
      ).json()) as { nextCursor: string };
      await first.close();

      const restarted = createServer({
        backend: new FileBackend(root),
        defaultPageSize: 1,
        maxPageSize: 1,
      });
      expect(
        (
          await restarted.fetch(
            new Request(`http://t/repos?cursor=${page.nextCursor}`)
          )
        ).status
      ).toBe(410);
      const names: string[] = [];
      let cursor: string | null = null;
      do {
        const response = await restarted.fetch(
          new Request(
            `http://t/repos${cursor === null ? '' : `?cursor=${cursor}`}`
          )
        );
        const body = (await response.json()) as {
          repos: string[];
          nextCursor: string | null;
        };
        names.push(...body.repos);
        cursor = body.nextCursor;
      } while (cursor !== null);
      expect(names).toEqual(['restart']);
      await restarted.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('server shutdown wins a race with cursor registration', async () => {
    const registry = new CursorRegistry({
      defaultPageSize: 1,
      maxPageSize: 1,
      maxPageResponseBytes: 1_024,
      cursorCapacity: 1,
      cursorTtlMs: 1_000,
    });
    let releaseRead: (() => void) | undefined;
    let closeCalls = 0;
    const source: PageSource<string> = {
      read: () =>
        new Promise((resolve) => {
          releaseRead = () => resolve({ items: ['item'], done: false });
        }),
      close: () => {
        closeCalls += 1;
        return Promise.resolve();
      },
    };
    const page = registry.page({
      request: { limit: 1 },
      binding: 'shutdown-race',
      revisionNow: () => 0,
      createSource: () => Promise.resolve(source),
      render: (items, nextCursor) => ({ items, nextCursor }),
    });
    while (releaseRead === undefined) await Promise.resolve();
    await registry.close();
    releaseRead();
    let error: unknown;
    try {
      await page;
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'pagination_cursor_invalid' });
    expect(registry.activeCount).toBe(0);
    expect(closeCalls).toBe(1);
  });

  test('reputation storage failures are not mislabeled as invalid DIDs', async () => {
    const memory = new MemoryBackend();
    const backend: Backend & ReplayNonceBackend = {
      put: (key, bytes) => memory.put(key, bytes),
      get: (key) => memory.get(key),
      openScan: (prefix) => memory.openScan(prefix),
      list: (prefix) =>
        prefix === 'rep/'
          ? Promise.reject(new Error('reputation storage unavailable'))
          : memory.list(prefix),
      delete: (key) => memory.delete(key),
      consumeNonce: (input) => memory.consumeNonce(input),
    };
    const server = createServer({ backend });
    const subject = Identity.create();
    let error: unknown;
    try {
      await server.fetch(
        new Request(`http://t/reputation/${subject.did}/export`)
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('reputation storage unavailable');
    await server.close();
  });
});
