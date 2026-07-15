import { Identity, ready } from '@thaddeus.run/identity';
import { encodeHeadRecord, signHead } from '@thaddeus.run/log';
import {
  type Bundle,
  decodeBundle,
  DEFAULT_ATTESTATION_RATE_LIMIT,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  MAX_ATTESTATION_RATE_LIMIT,
  MAX_REPLAY_NONCE_CAPACITY,
  REQUEST_SKEW_MS,
  signRequest,
} from '@thaddeus.run/server';
import { publicDid } from '@thaddeus.run/store';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/run';
import { startServer } from '../src/serve';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-serve-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const encoder = new TextEncoder();

/** Produces the exact signed-header set used by live POST route tests. */
function signedHeaders(path: string, body: Uint8Array, signer: Identity) {
  const signed = signRequest(
    'POST',
    path,
    body,
    signer,
    new Date().toISOString()
  );
  return {
    'x-thaddeus-did': signed.did,
    'x-thaddeus-timestamp': signed.timestamp,
    'x-thaddeus-nonce': signed.nonce,
    'x-thaddeus-signature': signed.signature,
  };
}

/** Produces a valid repository JSON body at an exact byte boundary. */
function exactRepoBody(
  limit: number,
  fill: string,
  signer: Identity,
  name: string
): Uint8Array {
  const head = encodeHeadRecord(
    signHead(
      {
        repo: name,
        view: 'main',
        version: 0,
        previous: null,
        heads: [],
      },
      signer
    )
  );
  const base = { name, head, padding: '' };
  const emptyLength = encoder.encode(JSON.stringify(base)).byteLength;
  return encoder.encode(
    JSON.stringify({
      ...base,
      padding: fill.repeat(limit - emptyLength),
    })
  );
}

describe('startServer', () => {
  test('serves over a real port and stops cleanly', async () => {
    const s = startServer({
      dataDir: mkdtempSync(join(tmp, 'data-')),
      port: 0,
    });
    try {
      expect(s.url).toContain('http://localhost:');
      const res = await fetch(`${s.url}/repos`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        repos: [],
        owners: {},
        nextCursor: null,
      });
    } finally {
      await s.stop();
    }
  });

  test('rejects invalid body limits before opening a listener', () => {
    for (const maxRequestBodyBytes of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(() =>
        startServer({
          dataDir: mkdtempSync(join(tmp, 'invalid-limit-')),
          port: 0,
          maxRequestBodyBytes,
        })
      ).toThrow(RangeError);
    }
    expect(() =>
      startServer({
        dataDir: mkdtempSync(join(tmp, 'invalid-limit-type-')),
        port: 0,
        maxRequestBodyBytes: null as unknown as number,
      })
    ).toThrow(TypeError);
  });

  test('rejects invalid pagination and nested limits before opening a listener', () => {
    expect(() =>
      startServer({
        dataDir: mkdtempSync(join(tmp, 'invalid-limit-relation-')),
        port: 0,
        maxRequestBodyBytes: 1_024,
        maxReputationArchiveBytes: 1_025,
      })
    ).toThrow(RangeError);
    expect(() =>
      startServer({
        dataDir: mkdtempSync(join(tmp, 'invalid-page-relation-')),
        port: 0,
        defaultPageSize: 2,
        maxPageSize: 1,
      })
    ).toThrow(RangeError);
    expect(() =>
      startServer({
        dataDir: mkdtempSync(join(tmp, 'invalid-field-limit-type-')),
        port: 0,
        maxFieldBytes: null as unknown as number,
      })
    ).toThrow(TypeError);
  });

  test('rejects invalid replay controls before opening a listener', () => {
    for (const replayNonceCapacity of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_REPLAY_NONCE_CAPACITY + 1,
    ]) {
      expect(() =>
        startServer({
          dataDir: mkdtempSync(join(tmp, 'invalid-replay-capacity-')),
          port: 0,
          replayNonceCapacity,
        })
      ).toThrow(RangeError);
    }
    for (const requestSkewMs of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      REQUEST_SKEW_MS + 1,
    ]) {
      expect(() =>
        startServer({
          dataDir: mkdtempSync(join(tmp, 'invalid-request-skew-')),
          port: 0,
          requestSkewMs,
        })
      ).toThrow(RangeError);
    }
  });

  test('rejects invalid --max-request-body-bytes values', async () => {
    for (const value of [
      '0',
      '-1',
      '1.5',
      '64.0',
      '1e3',
      '0x40',
      ' 64',
      'NaN',
      'Infinity',
      String(Number.MAX_SAFE_INTEGER),
    ]) {
      const output: string[] = [];
      const option = value.startsWith('-')
        ? `--max-request-body-bytes=${value}`
        : '--max-request-body-bytes';
      expect(
        await run(
          ['serve', option, ...(value.startsWith('-') ? [] : [value])],
          {
            cwd: tmp,
            home: tmp,
            out: (line) => output.push(line),
          }
        )
      ).toBe(2);
      expect(output).toEqual([`invalid --max-request-body-bytes: ${value}`]);
    }
  });

  test('explains invalid cross-limit CLI configurations', async () => {
    const output: string[] = [];
    expect(
      await run(
        [
          'serve',
          '--max-reputation-archive-bytes',
          '10',
          '--max-field-bytes',
          '11',
        ],
        {
          cwd: tmp,
          home: tmp,
          out: (line) => output.push(line),
        }
      )
    ).toBe(2);
    expect(output).toEqual([
      'invalid server limit configuration: maxFieldBytes must not exceed maxReputationArchiveBytes',
    ]);
  });

  test('validates attestation signer and rate-limit options before startup', async () => {
    const keyArn =
      'arn:aws:kms:eu-west-1:123456789012:key/12345678-1234-1234-1234-123456789012';
    const conflicting: string[] = [];
    expect(
      await run(['serve', '--host', '--attestation-aws-kms-key-arn', keyArn], {
        cwd: tmp,
        home: tmp,
        out: (line) => conflicting.push(line),
      })
    ).toBe(2);
    expect(conflicting).toEqual([
      'use either --host or --attestation-aws-kms-key-arn, not both',
    ]);

    for (const value of [
      '-1',
      '1.5',
      '1e1',
      String(MAX_ATTESTATION_RATE_LIMIT + 1),
    ]) {
      const output: string[] = [];
      const option = value.startsWith('-')
        ? `--attestation-rate-limit=${value}`
        : '--attestation-rate-limit';
      expect(
        await run(
          ['serve', option, ...(value.startsWith('-') ? [] : [value])],
          {
            cwd: tmp,
            home: tmp,
            out: (line) => output.push(line),
          }
        )
      ).toBe(2);
      expect(output).toEqual([`invalid --attestation-rate-limit: ${value}`]);
    }

    const missingSigner: string[] = [];
    expect(
      await run(
        [
          'serve',
          '--attestation-rate-limit',
          String(DEFAULT_ATTESTATION_RATE_LIMIT),
        ],
        {
          cwd: tmp,
          home: tmp,
          out: (line) => missingSigner.push(line),
        }
      )
    ).toBe(2);
    expect(missingSigner).toEqual([
      '--attestation-rate-limit requires --host or --attestation-aws-kms-key-arn',
    ]);
  });

  test('warns before starting with the development-only local host seed', async () => {
    const home = mkdtempSync(join(tmp, 'local-host-home-'));
    expect(
      await run(['init'], {
        cwd: tmp,
        home,
        out: () => {},
      })
    ).toBe(0);
    const occupied = Bun.serve({
      port: 0,
      fetch: () => new Response('occupied'),
    });
    const errors: string[] = [];
    try {
      expect(
        await run(['serve', '--host', '--port', String(occupied.port)], {
          cwd: tmp,
          home,
          out: () => {},
          err: (line) => errors.push(line),
        })
      ).toBe(1);
    } finally {
      await occupied.stop(true);
    }
    expect(errors).toContain(
      'warning: serve --host loads a local private signing seed; use AWS KMS in production'
    );
  });

  test('keeps KMS startup failures free of infrastructure identifiers', async () => {
    const output: string[] = [];
    const sensitiveKeyId = 'alias/private-infrastructure-name';
    expect(
      await run(['serve', '--attestation-aws-kms-key-arn', sensitiveKeyId], {
        cwd: tmp,
        home: tmp,
        out: (line) => output.push(line),
      })
    ).toBe(1);
    expect(output).toEqual([
      'error: AWS KMS attester startup validation failed',
    ]);
    expect(output.join('\n')).not.toContain(sensitiveKeyId);
  });

  test('rejects non-decimal and out-of-range replay CLI values', async () => {
    for (const [flag, values] of [
      [
        '--replay-nonce-capacity',
        [
          '0',
          '-1',
          '1.5',
          '1e3',
          '0x40',
          ' 64',
          String(Number.MAX_SAFE_INTEGER),
          String(MAX_REPLAY_NONCE_CAPACITY + 1),
        ],
      ],
      [
        '--request-skew-ms',
        [
          '0',
          '-1',
          '1.5',
          '1e3',
          '0x40',
          ' 64',
          String(Number.MAX_SAFE_INTEGER),
          String(REQUEST_SKEW_MS + 1),
        ],
      ],
    ] as const) {
      for (const value of values) {
        const output: string[] = [];
        const option = value.startsWith('-') ? `${flag}=${value}` : flag;
        expect(
          await run(
            ['serve', option, ...(value.startsWith('-') ? [] : [value])],
            {
              cwd: tmp,
              home: tmp,
              out: (line) => output.push(line),
            }
          )
        ).toBe(2);
        expect(output).toEqual([`invalid ${flag}: ${value}`]);
      }
    }
  });

  test('enforces application and Bun limits on the real route with metrics and concurrency', async () => {
    const limit = 1_024;
    const server = startServer({
      dataDir: mkdtempSync(join(tmp, 'body-limit-')),
      port: 0,
      maxRequestBodyBytes: limit,
      maxReputationArchiveBytes: limit,
      maxFieldBytes: limit,
    });
    const signer = Identity.create();
    const path = '/repos';
    try {
      const boundaryBody = exactRepoBody(limit, 'a', signer, 'boundary-a');
      expect(boundaryBody.byteLength).toBe(limit);
      const boundary = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: signedHeaders(path, boundaryBody, signer),
        body: boundaryBody,
      });
      expect(boundary.status).toBe(201);

      const streamedBody = exactRepoBody(limit, 'b', signer, 'boundary-b');
      const streamedBoundary = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: {
          ...signedHeaders(path, streamedBody, signer),
          connection: 'close',
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(streamedBody.subarray(0, 31));
            controller.enqueue(streamedBody.subarray(31));
            controller.close();
          },
        }),
      });
      expect(streamedBoundary.status).toBe(201);

      const declaredOverflow = await fetch(`${server.url}${path}`, {
        method: 'POST',
        body: new Uint8Array(limit + 1),
      });
      expect(declaredOverflow.status).toBe(413);
      expect(await declaredOverflow.json()).toEqual({
        error: 'request body too large',
        maxBytes: limit,
      });

      const streamedOverflow = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { connection: 'close' },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(512));
            controller.enqueue(new Uint8Array(513));
            controller.close();
          },
        }),
      });
      expect(streamedOverflow.status).toBe(413);
      expect(await streamedOverflow.json()).toEqual({
        error: 'request body too large',
        maxBytes: limit,
      });

      // A distinct origin forces a fresh connection so this observes Bun's
      // transport rejection rather than a keep-alive connection just cancelled
      // by the preceding streamed overflow.
      const nativeOverflow = await fetch(
        `http://127.0.0.1:${server.port}${path}`,
        {
          method: 'POST',
          body: new Uint8Array(limit + 2),
        }
      );
      expect(nativeOverflow.status).toBe(413);
      expect(await nativeOverflow.text()).toBe('');

      const metricsResponse = await fetch(`${server.url}/metrics`);
      const metrics = await metricsResponse.text();
      expect(metricsResponse.headers.get('content-type')).toBe(
        'text/plain; version=0.0.4; charset=utf-8'
      );
      expect(metrics).toContain('thaddeus_http_request_body_limit_bytes 1024');
      expect(metrics).toContain(
        'thaddeus_http_request_body_transport_limit_bytes 1025'
      );
      expect(metrics.split('\n')).toContain(
        'thaddeus_http_request_body_rejections_total{reason="declared_too_large"} 1'
      );
      expect(metrics.split('\n')).toContain(
        'thaddeus_http_request_body_rejections_total{reason="streamed_too_large"} 1'
      );

      const health = await fetch(`${server.url}/repos`);
      expect(health.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  test('rejects concurrent oversize requests and remains healthy', async () => {
    const limit = 64;
    const server = startServer({
      dataDir: mkdtempSync(join(tmp, 'body-concurrency-')),
      port: 0,
      maxRequestBodyBytes: limit,
      maxReputationArchiveBytes: limit,
      maxFieldBytes: limit,
    });
    try {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          fetch(`${server.url}/repos`, {
            method: 'POST',
            headers: { connection: 'close' },
            body: new Uint8Array(limit + 1),
          })
        )
      );
      expect(responses.map((response) => response.status)).toEqual(
        Array.from({ length: 8 }, () => 413)
      );

      const metrics = await (await fetch(`${server.url}/metrics`)).text();
      expect(metrics.split('\n')).toContain(
        'thaddeus_http_request_body_rejections_total{reason="declared_too_large"} 8'
      );
      expect((await fetch(`${server.url}/repos`)).status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  test('restarts on the same port with durable state, enforcement, and fresh counters', async () => {
    const root = mkdtempSync(join(tmp, 'body-restart-'));
    const signer = Identity.create();
    const body = exactRepoBody(1_024, 'p', signer, 'persisted');
    const capturedHeaders = signedHeaders('/repos', body, signer);
    let server = startServer({
      dataDir: root,
      port: 0,
      maxRequestBodyBytes: 1_024,
      maxReputationArchiveBytes: 1_024,
      maxFieldBytes: 1_024,
    });
    const port = server.port;
    try {
      const created = await fetch(`${server.url}/repos`, {
        method: 'POST',
        headers: capturedHeaders,
        body,
      });
      expect(created.status).toBe(201);
      const metrics = await (await fetch(`${server.url}/metrics`)).text();
      expect(metrics.split('\n')).toContain(
        'thaddeus_http_request_body_rejections_total{reason="declared_too_large"} 0'
      );
    } finally {
      await server.stop();
    }

    server = startServer({
      dataDir: root,
      port,
      maxRequestBodyBytes: 1_024,
      maxReputationArchiveBytes: 1_024,
      maxFieldBytes: 1_024,
    });
    try {
      const before = await (await fetch(`${server.url}/metrics`)).text();
      expect(before.split('\n')).toContain(
        'thaddeus_http_request_body_rejections_total{reason="declared_too_large"} 0'
      );

      const replayed = await fetch(`${server.url}/repos`, {
        method: 'POST',
        headers: capturedHeaders,
        body,
      });
      expect(replayed.status).toBe(401);
      expect(await replayed.json()).toEqual({
        error: 'unsigned or invalid request',
      });

      const rejected = await fetch(`${server.url}/repos`, {
        method: 'POST',
        body: new Uint8Array(1_025),
      });
      expect(rejected.status).toBe(413);

      const repos = (await (await fetch(`${server.url}/repos`)).json()) as {
        repos: string[];
      };
      expect(repos.repos).toContain('persisted');
    } finally {
      await server.stop();
    }
  });

  test('exports the production default for programmatic hosts', () => {
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBe(16 * 1024 * 1024);
  });

  test('a full CLI flow works against a live served port', async () => {
    const s = startServer({ dataDir: mkdtempSync(join(tmp, 'srv-')), port: 0 });
    try {
      const home = mkdtempSync(join(tmp, 'home-'));
      const e = (cwd: string) => ({ cwd, home, out: () => {} });
      expect(await run(['init'], e(home))).toBe(0);
      expect(await run(['create', s.url, 'proj'], e(home))).toBe(0);
      const a = mkdtempSync(join(tmp, 'a-'));
      expect(await run(['clone', s.url, 'proj', a], e(a))).toBe(0);
      writeFileSync(join(a, 'readme.md'), '# hi');
      expect(await run(['push'], e(a))).toBe(0);
      const b = mkdtempSync(join(tmp, 'b-'));
      expect(await run(['clone', s.url, 'proj', b], e(b))).toBe(0);
      expect(readFileSync(join(b, 'readme.md'), 'utf8')).toBe('# hi');
    } finally {
      await s.stop();
    }
  });

  test('promotes scheduled reveals without a read or manual trigger', async () => {
    const s = startServer({
      dataDir: mkdtempSync(join(tmp, 'reveal-srv-')),
      port: 0,
      revealIntervalMs: 10,
    });
    try {
      const home = mkdtempSync(join(tmp, 'reveal-home-'));
      const work = mkdtempSync(join(tmp, 'reveal-work-'));
      const e = (cwd: string) => ({ cwd, home, out: () => {} });
      expect(await run(['init'], e(home))).toBe(0);
      expect(await run(['create', s.url, 'reveal'], e(home))).toBe(0);
      expect(await run(['clone', s.url, 'reveal', work], e(work))).toBe(0);
      writeFileSync(join(work, 'news.md'), 'public now');
      expect(await run(['push'], e(work))).toBe(0);
      const at = new Date(Date.now() + 50).toISOString();
      expect(
        await run(['schedule-reveal', 'news.md', '--at', at], e(work))
      ).toBe(0);

      let publicCapability = false;
      const deadline = Date.now() + 2_000;
      while (!publicCapability && Date.now() < deadline) {
        const response = await fetch(`${s.url}/repos/reveal/pull?view=main`);
        const bundle = decodeBundle((await response.json()) as Bundle);
        publicCapability = bundle.caps.some(
          (capability) => capability.grantee === publicDid()
        );
        if (!publicCapability) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(publicCapability).toBe(true);

      const outsiderHome = mkdtempSync(join(tmp, 'outsider-home-'));
      const outsider = mkdtempSync(join(tmp, 'outsider-work-'));
      const outsiderEnv = (cwd: string) => ({
        cwd,
        home: outsiderHome,
        out: () => {},
      });
      expect(await run(['init'], outsiderEnv(outsiderHome))).toBe(0);
      expect(
        await run(['clone', s.url, 'reveal', outsider], outsiderEnv(outsider))
      ).toBe(0);
      expect(readFileSync(join(outsider, 'news.md'), 'utf8')).toBe(
        'public now'
      );
    } finally {
      await s.stop();
    }
  });
});
