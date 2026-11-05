import { createPrng } from '../prng';
import type { RequestFaults } from './schedule';

// An HTTP proxy between the workload's CLI processes and `thaddeus serve`.
// Clients keep one address while the server behind it is killed and
// restarted. It counts the traffic and injects request faults: a delay that
// reorders a request behind later ones, and a duplicate that replays a signed
// write after the original answered, as a client retry or a network replay
// would. Faults are drawn from a seeded generator in arrival order.

// Headers the proxy must not copy: hop-by-hop ones, and the length and
// encoding of a body it has already read and decoded.
const DROPPED_HEADERS = [
  'connection',
  'content-encoding',
  'content-length',
  'host',
  'keep-alive',
  'transfer-encoding',
];

// The outcome of one replayed write: the path and the status the server
// gave the copy, or null when the server could not be reached.
export interface DuplicateOutcome {
  method: string;
  path: string;
  status: number | null;
}

export interface ProxyStats {
  requests: number;
  requestBytes: number;
  responseBytes: number;
  delayed: number;
  unreachable: number;
  duplicates: DuplicateOutcome[];
}

export interface FaultProxy {
  url: string;
  /** Points the proxy at a server; null answers every request with 502. */
  setUpstream(url: string | null): void;
  stats(): ProxyStats;
  /** Waits for replayed requests still in flight. */
  settle(): Promise<void>;
  stop(): Promise<void>;
}

function copyHeaders(from: Headers): Headers {
  const headers = new Headers(from);
  for (const name of DROPPED_HEADERS) headers.delete(name);
  return headers;
}

// A signed write is one the server checks for replay: anything but GET or
// HEAD that carries a request nonce.
function isSignedWrite(req: Request): boolean {
  return (
    req.method !== 'GET' &&
    req.method !== 'HEAD' &&
    req.headers.has('x-thaddeus-nonce')
  );
}

// Starts the proxy on a free loopback port, initially with no upstream.
export function startProxy(seed: number, faults: RequestFaults): FaultProxy {
  const prng = createPrng(seed);
  let upstream: string | null = null;
  const pending = new Set<Promise<void>>();
  const stats: ProxyStats = {
    requests: 0,
    requestBytes: 0,
    responseBytes: 0,
    delayed: 0,
    unreachable: 0,
    duplicates: [],
  };

  const forward = (
    target: string,
    req: Request,
    path: string,
    body: Uint8Array
  ): Promise<Response> =>
    fetch(`${target}${path}`, {
      method: req.method,
      headers: copyHeaders(req.headers),
      body: body.length === 0 ? undefined : body,
      redirect: 'manual',
    });

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    // Large pushes pass through, so the proxy accepts what serve does.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    fetch: async (req) => {
      stats.requests++;
      const url = new URL(req.url);
      const path = `${url.pathname}${url.search}`;
      const body = new Uint8Array(await req.arrayBuffer());
      stats.requestBytes += body.length;
      // Three draws for every request, in this order: delay or not, the
      // delay in ms, duplicate or not. Drawing all three every time keeps one
      // fault's rate from shifting which requests the other picks.
      const delay = prng.next() < faults.delayRate;
      const delayMs = 1 + prng.int(Math.max(1, faults.maxDelayMs));
      const duplicate = prng.next() < faults.duplicateRate;
      if (delay) {
        stats.delayed++;
        await Bun.sleep(delayMs);
      }
      const target = upstream;
      if (target === null) {
        stats.unreachable++;
        return Response.json(
          { error: 'workload proxy: server is down' },
          { status: 502 }
        );
      }
      let res: Response;
      try {
        res = await forward(target, req, path, body);
      } catch {
        stats.unreachable++;
        return Response.json(
          { error: 'workload proxy: server unreachable' },
          { status: 502 }
        );
      }
      const resBody = new Uint8Array(await res.arrayBuffer());
      stats.responseBytes += resBody.length;
      if (duplicate && isSignedWrite(req)) {
        // Replayed after the original answered, without holding up the
        // client, so the copy races the client's next request.
        const replay = forward(target, req, path, body)
          .then(async (copy) => {
            await copy.arrayBuffer();
            stats.duplicates.push({
              method: req.method,
              path: url.pathname,
              status: copy.status,
            });
          })
          .catch(() => {
            stats.duplicates.push({
              method: req.method,
              path: url.pathname,
              status: null,
            });
          });
        pending.add(replay);
        void replay.finally(() => pending.delete(replay));
      }
      return new Response(resBody, {
        status: res.status,
        headers: copyHeaders(res.headers),
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    setUpstream: (url) => {
      upstream = url;
    },
    stats: () => ({ ...stats, duplicates: [...stats.duplicates] }),
    settle: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
