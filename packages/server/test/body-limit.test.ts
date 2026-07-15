import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { beforeAll, describe, expect, test } from 'bun:test';

import { createServer, DEFAULT_MAX_REQUEST_BODY_BYTES } from '../src/server';
import { signRequest } from '../src/sign';
import { createRepoBody } from './heads';

beforeAll(async () => {
  await ready();
});

/** Builds a controllable request stream for boundary and cancellation tests. */
function chunkedBody(
  chunks: readonly Uint8Array[],
  hooks: { cancelled?: () => void } = {}
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(chunk);
      }
    },
    cancel() {
      hooks.cancelled?.();
    },
  });
}

function serverWithBodyLimit(maxRequestBodyBytes: number) {
  return createServer({
    backend: new MemoryBackend(),
    maxRequestBodyBytes,
    maxReputationArchiveBytes: maxRequestBodyBytes,
    maxFieldBytes: maxRequestBodyBytes,
  });
}

describe('request body limits', () => {
  test('uses a 16 MiB default and rejects unsafe configuration', () => {
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBe(16 * 1024 * 1024);

    for (const value of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(() =>
        createServer({
          backend: new MemoryBackend(),
          maxRequestBodyBytes: value,
        })
      ).toThrow(RangeError);
    }
    expect(() =>
      createServer({
        backend: new MemoryBackend(),
        maxRequestBodyBytes: null as unknown as number,
      })
    ).toThrow(TypeError);
  });

  test('rejects a declared oversize body without pulling it and cancels cleanup', async () => {
    const server = serverWithBodyLimit(4);
    let pulls = 0;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulls += 1;
        throw new Error('the body must not be pulled');
      },
      cancel() {
        cancellations += 1;
      },
    });

    const response = await server.fetch(
      new Request('http://t/repos', {
        method: 'POST',
        headers: { 'content-length': '5' },
        body,
      })
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: 'request body too large',
      maxBytes: 4,
    });
    expect(pulls).toBe(0);
    expect(cancellations).toBe(1);
    expect(
      await (await server.fetch(new Request('http://t/repos'))).json()
    ).toEqual({ repos: [], owners: {}, nextCursor: null });

    const metrics = await (
      await server.fetch(new Request('http://t/metrics'))
    ).text();
    expect(metrics.split('\n')).toContain(
      'thaddeus_http_request_body_rejections_total{reason="declared_too_large"} 1'
    );
  });

  test('fails closed on malformed Content-Length without reading bodies', async () => {
    const server = serverWithBodyLimit(8);
    const invalidValues = [
      '-1',
      '1.5',
      '+1',
      '1, 2',
      'not-a-number',
      '9007199254740992',
    ];
    let pulls = 0;
    let cancellations = 0;

    for (const contentLength of invalidValues) {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          pulls += 1;
          throw new Error('an invalid declaration must not be pulled');
        },
        cancel() {
          cancellations += 1;
        },
      });
      const response = await server.fetch(
        new Request('http://t/repos', {
          method: 'POST',
          headers: { 'content-length': contentLength },
          body,
        })
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'invalid content-length header',
      });
    }

    expect(pulls).toBe(0);
    expect(cancellations).toBe(invalidValues.length);
    const metrics = await (
      await server.fetch(new Request('http://t/metrics'))
    ).text();
    expect(metrics.split('\n')).toContain(
      `thaddeus_http_request_body_rejections_total{reason="invalid_content_length"} ${invalidValues.length}`
    );
  });

  test('streams through the inclusive boundary and rejects overflow or an understated declaration', async () => {
    const server = serverWithBodyLimit(4);

    const boundary = await server.fetch(
      new Request('http://t/repos', {
        method: 'POST',
        body: chunkedBody([new Uint8Array(2), new Uint8Array(2)]),
      })
    );
    expect(boundary.status).toBe(401);

    let overflowCancelled = 0;
    const overflow = await server.fetch(
      new Request('http://t/repos', {
        method: 'POST',
        body: chunkedBody([new Uint8Array(2), new Uint8Array(3)], {
          cancelled: () => {
            overflowCancelled += 1;
          },
        }),
      })
    );
    expect(overflow.status).toBe(413);
    expect(overflowCancelled).toBe(1);

    const understated = await server.fetch(
      new Request('http://t/repos', {
        method: 'POST',
        headers: { 'content-length': '4' },
        body: chunkedBody([new Uint8Array(4), new Uint8Array(1)]),
      })
    );
    expect(understated.status).toBe(413);

    const metrics = await (
      await server.fetch(new Request('http://t/metrics'))
    ).text();
    expect(metrics.split('\n')).toContain(
      'thaddeus_http_request_body_rejections_total{reason="streamed_too_large"} 2'
    );
  });

  test('coalesces many tiny reads without changing the signed body', async () => {
    const maxRequestBodyBytes = 160 * 1_024 + 17;
    const server = serverWithBodyLimit(maxRequestBodyBytes);
    const signer = Identity.create();
    const base = { ...createRepoBody('boundary', signer), padding: '' };
    const prefix = new TextEncoder().encode(JSON.stringify(base));
    const body = new TextEncoder().encode(
      JSON.stringify({
        ...base,
        padding: 'x'.repeat(maxRequestBodyBytes - prefix.length),
      })
    );
    const signed = signRequest(
      'POST',
      '/repos',
      body,
      signer,
      new Date().toISOString()
    );
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === body.byteLength) {
          controller.close();
          return;
        }
        const nextOffset =
          offset < 4_096
            ? offset + 1
            : offset < 60 * 1_024
              ? 60 * 1_024
              : offset < 130 * 1_024
                ? 130 * 1_024
                : body.byteLength;
        controller.enqueue(body.subarray(offset, nextOffset));
        offset = nextOffset;
      },
    });

    const response = await server.fetch(
      new Request('http://t/repos', {
        method: 'POST',
        headers: {
          'x-thaddeus-did': signed.did,
          'x-thaddeus-timestamp': signed.timestamp,
          'x-thaddeus-nonce': signed.nonce,
          'x-thaddeus-signature': signed.signature,
        },
        body: stream,
      })
    );

    expect(body.byteLength).toBe(maxRequestBodyBytes);
    expect(offset).toBe(maxRequestBodyBytes);
    expect(response.status).toBe(201);
  });

  test('cancels bodies on non-POST and malformed-path exits', async () => {
    const server = serverWithBodyLimit(8);
    let cancellations = 0;
    let pulls = 0;
    const body = () =>
      new ReadableStream<Uint8Array>({
        pull() {
          pulls += 1;
          throw new Error('route exits must not pull the body');
        },
        cancel() {
          cancellations += 1;
        },
      });

    const deleteResponse = await server.fetch(
      new Request('http://t/repos/example', {
        method: 'DELETE',
        body: body(),
      })
    );
    const malformedResponse = await server.fetch(
      new Request('http://t/repos/%E0%A4%A/push', {
        method: 'POST',
        body: body(),
      })
    );

    expect(deleteResponse.status).toBe(401);
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toEqual({ error: 'malformed path' });
    expect(pulls).toBe(0);
    expect(cancellations).toBe(2);
  });

  test('turns a failing body stream into a stable 400 and remains healthy', async () => {
    const server = serverWithBodyLimit(8);
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('adversarial stream failure');
      },
    });

    const response = await server.fetch(
      new Request('http://t/repos', { method: 'POST', body })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid request body' });
    expect(
      await (await server.fetch(new Request('http://t/repos'))).json()
    ).toEqual({ repos: [], owners: {}, nextCursor: null });
  });

  test('exposes fixed-label Prometheus metrics without request data', async () => {
    const marker = 'private-request-marker';
    const server = serverWithBodyLimit(8);
    await server.fetch(
      new Request('http://t/repos', {
        method: 'POST',
        headers: { 'content-length': '9', 'x-marker': marker },
        body: new Uint8Array(9),
      })
    );

    const response = await server.fetch(new Request('http://t/metrics'));
    const metrics = await response.text();
    expect(response.headers.get('content-type')).toBe(
      'text/plain; version=0.0.4; charset=utf-8'
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(metrics).toContain('thaddeus_http_request_body_limit_bytes 8');
    expect(metrics).toContain(
      'thaddeus_http_request_body_transport_limit_bytes 9'
    );
    expect(metrics).not.toContain(marker);
    expect(metrics).not.toContain('/repos');
  });
});
