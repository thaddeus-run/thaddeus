import { FileBackend } from '@thaddeus.run/persist';
import type { LandPolicy } from '@thaddeus.run/platform';
import { createServer } from '@thaddeus.run/server';

// Options for a local Thaddeus server.
export interface ServeOptions {
  dataDir: string; // FileBackend root (the durable cold tier)
  port?: number; // default 4000; pass 0 for an OS-assigned port (tests)
  policy?: LandPolicy; // default blockOnConflict (createServer's default)
}

// A running server handle.
export interface RunningServer {
  url: string; // http://localhost:<port>
  port: number; // the resolved (possibly OS-assigned) port
  stop(): Promise<void>; // release the port
}

// Start a durable Thaddeus server over a FileBackend at `dataDir`. Does NOT
// block — returns a handle. The CLI `serve` command awaits indefinitely; tests
// call this directly, fetch against `url`, then `stop()`.
export function startServer(opts: ServeOptions): RunningServer {
  const srv = createServer({
    backend: new FileBackend(opts.dataDir),
    policy: opts.policy,
  });
  const http = Bun.serve({ port: opts.port ?? 4000, fetch: srv.fetch });
  // http.port is always defined after a successful Bun.serve() call; the type
  // is number | undefined only because Bun.serve can theoretically be called
  // before the socket is bound, but that can't happen synchronously here.
  const resolvedPort = http.port ?? 0;
  return {
    url: `http://localhost:${resolvedPort}`,
    port: resolvedPort,
    stop: async (): Promise<void> => {
      await http.stop(true);
    },
  };
}
