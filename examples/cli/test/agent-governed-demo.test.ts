import { afterAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'thaddeus-demo-tests-'));
const sentinel = join(sandbox, 'keep');
writeFileSync(sentinel, 'outside the demo root');
const children = new Set<ReturnType<typeof Bun.spawn>>();
type DemoServer = { pid: number; url: string };
afterAll(async () => {
  for (const child of children) {
    child.kill('SIGKILL');
    await child.exited;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

// Observe the real driver's startup output before injecting a process failure.
async function demo(
  interrupt?: 'server' | 'SIGINT' | 'SIGTERM' | 'SIGKILL',
  onServer?: (server: DemoServer) => void
) {
  const child = Bun.spawn({
    cmd: [process.execPath, 'src/agent-governed-demo.ts'],
    cwd: resolve(import.meta.dir, '..'),
    env: { ...process.env, TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.add(child);
  let stdout = '';
  let server: DemoServer | undefined;
  let injected = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 140_000);
  const read = async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      stdout += decoder.decode(chunk, { stream: true });
      const match = /^Demo server: (.+)$/m.exec(stdout);
      if (match !== null && server === undefined) {
        server = JSON.parse(match[1]) as DemoServer;
        onServer?.(server);
      }
      if (interrupt !== undefined && server !== undefined && !injected) {
        injected = true;
        if (interrupt === 'server') process.kill(server.pid, 'SIGKILL');
        else child.kill(interrupt);
      }
    }
  };
  try {
    const [code, , stderr] = await Promise.all([
      child.exited,
      read(),
      new Response(child.stderr).text(),
    ]);
    const run = /^Demo run: (.+)$/m.exec(stdout);
    expect(run, stdout + stderr).not.toBeNull();
    const root = (JSON.parse(run![1]) as { root: string }).root;
    expect(server, stdout + stderr).toBeDefined();
    if (server !== undefined) {
      await assert.rejects(
        fetch(`${server.url}/repos`, { signal: AbortSignal.timeout(1000) })
      );
    }
    expect(readFileSync(sentinel, 'utf8')).toBe('outside the demo root');
    if (interrupt) expect(injected).toBe(true);
    return { code, stdout, stderr, root };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      if (server !== undefined) {
        try {
          process.kill(server.pid, 'SIGKILL');
        } catch {
          /* Already reaped. */
        }
      }
    }
    await child.exited;
    children.delete(child);
  }
}

test('the test helper stops the server after an abrupt driver exit', async () => {
  let server: DemoServer | undefined;
  try {
    await assert.rejects(
      demo('SIGKILL', (started) => {
        server = started;
      }),
      { code: 'ERR_ASSERTION' }
    );
    assert.ok(
      server !== undefined,
      'the real server started before the driver was killed'
    );
    await assert.rejects(
      fetch(`${server.url}/repos`, { signal: AbortSignal.timeout(1000) })
    );
  } finally {
    // Keep a failing regression from leaking the server it was written to catch.
    if (server !== undefined) {
      try {
        process.kill(server.pid, 'SIGKILL');
      } catch {
        /* Already stopped by the helper. */
      }
    }
  }
}, 150_000);

test('two compiled CLI demos prove each policy and remove their isolated state', async () => {
  const first = await demo();
  const second = await demo();
  expect(first.root).not.toBe(second.root);
  for (const result of [first, second]) {
    expect(result.code, result.stdout + result.stderr).toBe(0);
    for (const outcome of [
      'accepted agent history',
      'protected-path rejection',
      'independent budget exhaustion',
      'reviewer veto',
    ]) {
      expect(result.stdout).toContain(`Verified: ${outcome}`);
    }
    expect(existsSync(result.root)).toBe(false);
    expect(result.stdout).toContain('Demo complete');
  }
}, 300_000);

for (const interruption of ['server', 'SIGINT', 'SIGTERM'] as const) {
  test(`a real ${interruption} interruption stops children and retains evidence`, async () => {
    const result = await demo(interruption);
    expect(result.code, result.stdout + result.stderr).toBe(
      interruption === 'SIGINT' ? 130 : interruption === 'SIGTERM' ? 143 : 1
    );
    expect(existsSync(result.root)).toBe(true);
    expect(result.stdout).toContain(`Demo evidence retained: ${result.root}`);
    expect(readFileSync(join(result.root, 'transcript.log'), 'utf8')).toContain(
      'Demo failed:'
    );
    rmSync(result.root, { recursive: true, force: true });
  }, 150_000);
}
