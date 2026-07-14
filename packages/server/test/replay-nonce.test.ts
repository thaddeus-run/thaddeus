import { Identity, ready } from '@thaddeus.run/identity';
import { FileBackend, MemoryBackend } from '@thaddeus.run/persist';
import type {
  Backend,
  ConsumeNonceInput,
  ConsumeNonceResult,
  ReplayNonceBackend,
} from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../src/server';
import { REQUEST_SKEW_MS, type SignedHeaders, signRequest } from '../src/sign';
import { createRepoBody } from './heads';

beforeAll(async () => {
  await ready();
});

const encoder = new TextEncoder();

function envelope(
  body: Uint8Array,
  signer: Identity,
  timestamp: string,
  nonce: string = crypto.randomUUID()
): SignedHeaders {
  return signRequest('POST', '/repos', body, signer, timestamp, nonce);
}

function request(body: Uint8Array, signed: SignedHeaders): Request {
  return new Request('http://t/repos', {
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

class FailingNonceBackend implements Backend, ReplayNonceBackend {
  readonly inner = new MemoryBackend();
  fail = true;

  put(key: string, bytes: Uint8Array): Promise<void> {
    return this.inner.put(key, bytes);
  }

  putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    return this.inner.putIfAbsent(key, bytes);
  }

  get(key: string): Promise<Uint8Array | undefined> {
    return this.inner.get(key);
  }

  list(prefix: string): Promise<readonly string[]> {
    return this.inner.list(prefix);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  consumeNonce(input: ConsumeNonceInput): Promise<ConsumeNonceResult> {
    return this.fail
      ? Promise.reject(new Error('adversarial-nonce-store-filename-marker'))
      : this.inner.consumeNonce(input);
  }
}

describe('durable signed-route replay protection', () => {
  test('restart rejects the exact live envelope before duplicate mutation logic', async () => {
    const root = mkdtempSync(join(tmpdir(), 'thaddeus-server-replay-'));
    const signer = Identity.create();
    const timestamp = new Date().toISOString();
    const body = encoder.encode(
      JSON.stringify(createRepoBody('restart', signer))
    );
    const signed = envelope(body, signer, timestamp, 'captured-restart-nonce');

    const first = createServer({ backend: new FileBackend(root) });
    expect((await first.fetch(request(body, signed))).status).toBe(201);

    const restarted = createServer({ backend: new FileBackend(root) });
    const replay = await restarted.fetch(request(body, signed));
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({
      error: 'unsigned or invalid request',
    });

    const fresh = envelope(body, signer, timestamp, 'fresh-duplicate-nonce');
    expect((await restarted.fetch(request(body, fresh))).status).toBe(409);
  });

  test('concurrent copies yield one mutation and replay rejections', async () => {
    const signer = Identity.create();
    const timestamp = new Date().toISOString();
    const body = encoder.encode(JSON.stringify(createRepoBody('race', signer)));
    const signed = envelope(body, signer, timestamp, 'concurrent-copy');
    const server = createServer({ backend: new MemoryBackend() });

    const responses = await Promise.all(
      Array.from({ length: 12 }, () => server.fetch(request(body, signed)))
    );
    expect(
      responses.filter((response) => response.status === 201)
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.status === 401)
    ).toHaveLength(11);
  });

  test('saturation returns stable 429 JSON and the exact-boundary Retry-After', async () => {
    const signer = Identity.create();
    const timestamp = '2026-07-14T00:00:00.000Z';
    const body = encoder.encode('{"marker":"capacity-body"}');
    const server = createServer({
      backend: new MemoryBackend(),
      now: () => timestamp,
      replayNonceCapacity: 1,
    });

    expect(
      (
        await server.fetch(
          request(body, envelope(body, signer, timestamp, 'one'))
        )
      ).status
    ).toBe(400);
    const full = await server.fetch(
      request(body, envelope(body, signer, timestamp, 'two'))
    );
    expect(full.status).toBe(429);
    expect(full.headers.get('retry-after')).toBe('301');
    expect(await full.json()).toEqual({
      error: 'replay protection capacity exceeded',
      code: 'replay_capacity_exceeded',
    });
  });

  test('storage failure is a stable 503, reports only its operation, and does not mutate', async () => {
    const backend = new FailingNonceBackend();
    const contexts: string[] = [];
    const signer = Identity.create();
    const timestamp = new Date().toISOString();
    const body = encoder.encode(
      JSON.stringify(createRepoBody('must-not-exist', signer))
    );
    const server = createServer({
      backend,
      onError: (_error, context) => contexts.push(context.operation),
    });

    const response = await server.fetch(
      request(body, envelope(body, signer, timestamp, 'store-failure'))
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'replay protection unavailable',
      code: 'replay_store_unavailable',
    });
    expect(contexts).toEqual(['nonce-consumption']);
    expect(
      await (await server.fetch(new Request('http://t/repos'))).json()
    ).toEqual({ repos: [], owners: {} });
  });

  test('exact expiry stays full and one millisecond later cleanup admits the request', async () => {
    const signer = Identity.create();
    const start = Date.parse('2026-07-14T00:00:00.000Z');
    let nowMs = start;
    const body = encoder.encode('{"marker":"boundary"}');
    const server = createServer({
      backend: new MemoryBackend(),
      now: () => new Date(nowMs).toISOString(),
      replayNonceCapacity: 1,
    });
    const first = envelope(
      body,
      signer,
      new Date(start).toISOString(),
      'boundary-a'
    );
    expect((await server.fetch(request(body, first))).status).toBe(400);

    nowMs = start + REQUEST_SKEW_MS;
    const second = envelope(
      body,
      signer,
      new Date(nowMs).toISOString(),
      'boundary-b'
    );
    expect((await server.fetch(request(body, second))).status).toBe(429);

    nowMs += 1;
    expect((await server.fetch(request(body, second))).status).toBe(400);
    const metrics = await (
      await server.fetch(new Request('http://t/metrics'))
    ).text();
    expect(metrics).toContain('thaddeus_replay_nonce_records_cleaned_total 1');
  });

  test('invalid signatures and malformed nonces cannot poison capacity', async () => {
    const signer = Identity.create();
    const timestamp = new Date().toISOString();
    const body = encoder.encode('{"marker":"invalid"}');
    const server = createServer({
      backend: new MemoryBackend(),
      replayNonceCapacity: 1,
    });

    const badSignature = envelope(body, signer, timestamp, 'bad-signature');
    badSignature.signature = Buffer.from(new Uint8Array(64)).toString('base64');
    expect((await server.fetch(request(body, badSignature))).status).toBe(401);

    const oversized = envelope(body, signer, timestamp, 'x'.repeat(129));
    expect((await server.fetch(request(body, oversized))).status).toBe(401);

    const valid = envelope(body, signer, timestamp, 'still-has-capacity');
    expect((await server.fetch(request(body, valid))).status).toBe(400);
  });

  test('the same nonce text is independent across signers', async () => {
    const timestamp = new Date().toISOString();
    const body = encoder.encode('{"marker":"signer-domain"}');
    const first = Identity.create();
    const second = Identity.create();
    const server = createServer({
      backend: new MemoryBackend(),
      replayNonceCapacity: 2,
    });

    expect(
      (
        await server.fetch(
          request(body, envelope(body, first, timestamp, 'same'))
        )
      ).status
    ).toBe(400);
    expect(
      (
        await server.fetch(
          request(body, envelope(body, second, timestamp, 'same'))
        )
      ).status
    ).toBe(400);
  });

  test('narrow request skew accepts its exact boundary and rejects one ms beyond', async () => {
    const signer = Identity.create();
    const nowMs = Date.parse('2026-07-14T00:00:10.000Z');
    const body = encoder.encode('{"marker":"narrow-skew"}');
    const server = createServer({
      backend: new MemoryBackend(),
      now: () => new Date(nowMs).toISOString(),
      requestSkewMs: 1_000,
    });

    const boundary = envelope(
      body,
      signer,
      new Date(nowMs - 1_000).toISOString(),
      'skew-boundary'
    );
    expect((await server.fetch(request(body, boundary))).status).toBe(400);
    const outside = envelope(
      body,
      signer,
      new Date(nowMs - 1_001).toISOString(),
      'skew-outside'
    );
    expect((await server.fetch(request(body, outside))).status).toBe(401);
  });

  test('narrowing then widening skew cannot reopen a consumed nonce', async () => {
    const backend = new MemoryBackend();
    const signer = Identity.create();
    const start = Date.parse('2026-07-14T00:00:00.000Z');
    const body = encoder.encode('{"marker":"narrow-then-wide"}');
    const signed = envelope(
      body,
      signer,
      new Date(start).toISOString(),
      'one-shot'
    );
    const narrow = createServer({
      backend,
      now: () => new Date(start).toISOString(),
      requestSkewMs: 1_000,
    });
    expect((await narrow.fetch(request(body, signed))).status).toBe(400);

    const widened = createServer({
      backend,
      now: () => new Date(start + 2_000).toISOString(),
    });
    expect((await widened.fetch(request(body, signed))).status).toBe(401);
  });

  test('metrics count fixed outcomes without exposing adversarial marker values', async () => {
    const backend = new FailingNonceBackend();
    backend.fail = false;
    const signer = Identity.create();
    const start = Date.parse('2026-07-14T00:00:00.000Z');
    let nowMs = start;
    const marker = 'private-path-did-nonce-signature-body-filename-marker';
    const body = encoder.encode(JSON.stringify({ marker }));
    const server = createServer({
      backend,
      now: () => new Date(nowMs).toISOString(),
      replayNonceCapacity: 1,
      requestSkewMs: REQUEST_SKEW_MS,
    });
    const accepted = envelope(
      body,
      signer,
      new Date(nowMs).toISOString(),
      marker
    );
    expect((await server.fetch(request(body, accepted))).status).toBe(400);
    expect((await server.fetch(request(body, accepted))).status).toBe(401);
    expect(
      (
        await server.fetch(
          request(
            body,
            envelope(
              body,
              signer,
              new Date(nowMs).toISOString(),
              `${marker}-full`
            )
          )
        )
      ).status
    ).toBe(429);

    const invalid = envelope(
      body,
      signer,
      new Date(nowMs).toISOString(),
      'invalid'
    );
    invalid.signature = 'invalid';
    expect((await server.fetch(request(body, invalid))).status).toBe(401);

    nowMs += REQUEST_SKEW_MS + 1;
    const cleaned = envelope(
      body,
      signer,
      new Date(nowMs).toISOString(),
      `${marker}-cleaned`
    );
    expect((await server.fetch(request(body, cleaned))).status).toBe(400);
    backend.fail = true;
    const failed = envelope(
      body,
      signer,
      new Date(nowMs).toISOString(),
      `${marker}-failed`
    );
    expect((await server.fetch(request(body, failed))).status).toBe(503);

    const metrics = await (
      await server.fetch(new Request('http://t/metrics'))
    ).text();
    expect(metrics).toContain('thaddeus_replay_nonce_capacity 1');
    expect(metrics).toContain(`thaddeus_request_skew_ms ${REQUEST_SKEW_MS}`);
    expect(metrics).toContain(
      'thaddeus_signed_request_outcomes_total{outcome="accepted"} 2'
    );
    expect(metrics).toContain(
      'thaddeus_signed_request_outcomes_total{outcome="invalid"} 1'
    );
    expect(metrics).toContain(
      'thaddeus_signed_request_outcomes_total{outcome="replayed"} 1'
    );
    expect(metrics).toContain(
      'thaddeus_signed_request_outcomes_total{outcome="capacity"} 1'
    );
    expect(metrics).toContain(
      'thaddeus_signed_request_outcomes_total{outcome="store_error"} 1'
    );
    expect(metrics).not.toContain(marker);
    expect(metrics).not.toContain(signer.did);
  });

  test('configuration aliases and limits validate eagerly', () => {
    expect(() =>
      createServer({
        backend: new MemoryBackend(),
        replayNonceCapacity: 1,
        replayCacheCapacity: 1,
      })
    ).toThrow('cannot both be set');
    for (const requestSkewMs of [0, 1.5, REQUEST_SKEW_MS + 1]) {
      expect(() =>
        createServer({ backend: new MemoryBackend(), requestSkewMs })
      ).toThrow(RangeError);
    }
  });
});
