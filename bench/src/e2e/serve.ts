import { createServer } from 'node:net';

// Starting and stopping a real `thaddeus serve` for one end-to-end case.

// How long `startServe` waits for GET /version to answer.
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 50;

// How long `stop` waits after SIGTERM before it sends SIGKILL.
const STOP_GRACE_MS = 5_000;

// How much of the server's output goes into a startup error.
const OUTPUT_TAIL_CHARS = 2_000;

export interface RunningServe {
  url: string;
  stop(): Promise<void>;
}

// A TCP port that was free a moment ago: bind port 0, read the port the
// kernel picked, close. Another process could take it before serve binds it,
// in which case serve exits and `startServe` reports its output.
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port =
        address !== null && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

// Keeps the last OUTPUT_TAIL_CHARS of a stream as it is read, so a chatty
// server can never fill its pipe and block.
function tailOf(stream: ReadableStream<Uint8Array>): () => string {
  let tail = '';
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) {
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(
        -OUTPUT_TAIL_CHARS
      );
    }
  })().catch(() => {});
  return () => tail;
}

// Starts `<cli> serve --data <root> --port <free port> ...flags` as a normal
// child of this process (never detached, so the runner's group kill reaches
// it) and resolves once GET /version answers. Rejects with the server's
// output if it exits or does not answer within READY_TIMEOUT_MS. `stop`
// sends SIGTERM, then SIGKILL after STOP_GRACE_MS, and waits for the exit.
export async function startServe(opts: {
  cli: readonly string[];
  root: string;
  flags: readonly string[];
}): Promise<RunningServe> {
  const port = await freePort();
  const proc = Bun.spawn(
    [
      ...opts.cli,
      'serve',
      '--data',
      opts.root,
      '--port',
      String(port),
      ...opts.flags,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
  );
  const stdout = tailOf(proc.stdout);
  const stderr = tailOf(proc.stderr);
  const url = `http://127.0.0.1:${port}`;

  const stop = async (): Promise<void> => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill('SIGTERM');
    const timer = setTimeout(() => proc.kill('SIGKILL'), STOP_GRACE_MS);
    await proc.exited;
    clearTimeout(timer);
  };

  const deadline = performance.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `thaddeus serve exited with ${proc.exitCode ?? proc.signalCode} before answering: ${`${stdout()}${stderr()}`.trim()}`
      );
    }
    try {
      const res = await fetch(`${url}/version`);
      if (res.ok) {
        await res.body?.cancel();
        return { url, stop };
      }
      await res.body?.cancel();
    } catch {
      // Not listening yet.
    }
    if (performance.now() > deadline) {
      await stop();
      throw new Error(
        `thaddeus serve did not answer GET /version within ${READY_TIMEOUT_MS} ms: ${`${stdout()}${stderr()}`.trim()}`
      );
    }
    await Bun.sleep(READY_POLL_MS);
  }
}
