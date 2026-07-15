import type { Identity } from '@thaddeus.run/identity';
import { FileBackend } from '@thaddeus.run/persist';
import type { LandPolicy } from '@thaddeus.run/platform';
import type { AttestationSigner } from '@thaddeus.run/reputation';
import {
  createServer,
  DEFAULT_REPLAY_NONCE_CAPACITY,
  REQUEST_SKEW_MS,
  resolveLimits,
} from '@thaddeus.run/server';

// Pin Bun's documented default so slow-body protection cannot drift across
// runtime upgrades.
const REQUEST_IDLE_TIMEOUT_SECONDS = 10;

// Options for a local Thaddeus server.
export interface ServeOptions {
  dataDir: string; // FileBackend root (the durable cold tier)
  port?: number; // default 4000; pass 0 for an OS-assigned port (tests)
  policy?: LandPolicy; // default blockOnConflict (createServer's default)
  attester?: AttestationSigner; // production signer, normally managed KMS
  /** @deprecated Development-only local private-key signer. */
  host?: Identity;
  attestationRateLimit?: number;
  minMerges?: number; // gate land on this many attested merges per op author
  trustedReputationHosts?: readonly string[]; // exact foreign-host allowlist
  // Default 16 MiB; accepts positive integers through
  // Number.MAX_SAFE_INTEGER - 1.
  maxRequestBodyBytes?: number;
  maxReputationArchiveBytes?: number;
  maxReputationContributions?: number;
  maxFieldBytes?: number;
  defaultPageSize?: number;
  maxPageSize?: number;
  maxPageResponseBytes?: number;
  paginationCursorCapacity?: number;
  paginationCursorTtlMs?: number;
  // Bounded durable signed-envelope replay protection (default 100,000).
  replayNonceCapacity?: number;
  // Accepted request timestamp skew in milliseconds (default/max 300,000).
  requestSkewMs?: number;
  // Scheduler cadence. Public for deterministic integration tests; normal CLI
  // servers use one second.
  revealIntervalMs?: number;
}

// A running server handle.
export interface RunningServer {
  url: string; // http://localhost:<port>
  port: number; // the resolved (possibly OS-assigned) port
  stop(): Promise<void>; // release the port
}

/**
 * Starts a durable server without blocking so callers can stop it cleanly.
 * The CLI awaits the returned handle indefinitely; tests use its live URL.
 */
export function startServer(opts: ServeOptions): RunningServer {
  const limits = resolveLimits(opts);
  const { maxRequestBodyBytes } = limits;
  const srv = createServer({
    backend: new FileBackend(opts.dataDir),
    ...limits,
    policy: opts.policy,
    attester: opts.attester,
    host: opts.host,
    attestationRateLimit: opts.attestationRateLimit,
    minMerges: opts.minMerges,
    trustedReputationHosts: opts.trustedReputationHosts,
    replayNonceCapacity:
      opts.replayNonceCapacity ?? DEFAULT_REPLAY_NONCE_CAPACITY,
    requestSkewMs: opts.requestSkewMs ?? REQUEST_SKEW_MS,
    onError: (error, context) => {
      if (context.operation === 'nonce-consumption') {
        // Backend errors can carry opaque durable filenames. Keep operator
        // logging fixed and let callers attach their own privacy-safe telemetry.
        console.error('replay protection nonce consumption failed');
        return;
      }
      if (context.operation === 'attestation-sign') {
        console.error('reputation attestation signer unavailable');
        return;
      }
      if (context.operation === 'attestation-rate-store') {
        console.error('reputation attestation rate storage unavailable');
        return;
      }
      const scope = context.repo === undefined ? '' : ` for ${context.repo}`;
      console.error(`timed reveal ${context.operation} failed${scope}:`, error);
    },
  });
  const http = Bun.serve({
    port: opts.port ?? 4000,
    idleTimeout: REQUEST_IDLE_TIMEOUT_SECONDS,
    maxRequestBodySize: maxRequestBodyBytes + 1,
    fetch: srv.fetch,
  });
  const revealIntervalMs = opts.revealIntervalMs ?? 1_000;
  if (!Number.isFinite(revealIntervalMs) || revealIntervalMs <= 0) {
    void http.stop(true);
    throw new RangeError('revealIntervalMs must be greater than zero');
  }
  let revealTick: Promise<void> | undefined;
  const scanDueReveals = (): void => {
    if (revealTick !== undefined) {
      return;
    }
    revealTick = srv
      .revealDue()
      .then(() => undefined)
      // A transient backend failure must not stop future scans or surface as an
      // unhandled rejection from the timer. The next interval retries.
      .catch((error) => {
        console.error('timed reveal scan failed:', error);
      })
      .finally(() => {
        revealTick = undefined;
      });
  };
  const revealTimer = setInterval(scanDueReveals, revealIntervalMs);
  revealTimer.unref();
  scanDueReveals();
  // http.port is always defined after a successful Bun.serve() call; the type
  // is number | undefined only because Bun.serve can theoretically be called
  // before the socket is bound, but that can't happen synchronously here.
  const resolvedPort = http.port ?? 0;
  return {
    url: `http://localhost:${resolvedPort}`,
    port: resolvedPort,
    stop: async (): Promise<void> => {
      clearInterval(revealTimer);
      await revealTick;
      await http.stop(true);
      await srv.close();
    },
  };
}
