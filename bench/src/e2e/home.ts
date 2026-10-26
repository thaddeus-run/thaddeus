import { Identity } from '@thaddeus.run/identity';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The pieces of the end-to-end suite that deal with the CLI as a program: which
// command runs it, the identity home it reads, and timing one invocation.

// The compiled binary `cli:compile` writes, found from this file's location.
const RELEASE_BINARY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'cli',
  'release',
  'thaddeus'
);

// How much of a failed command's output goes into the error.
const OUTPUT_TAIL_CHARS = 2_000;

// The command prefix that runs the CLI: `BENCH_CLI` split on whitespace, or
// the compiled release binary. Tests set `bun <abs>/packages/cli/src/bin.ts`
// so they need no compile step. A relative path in it (such as
// `packages/cli/release/thaddeus`) is made absolute against this process's
// directory, because every command runs in its own working directory.
export function cliCommand(): string[] {
  const raw = process.env.BENCH_CLI?.trim();
  if (raw === undefined || raw === '') return [RELEASE_BINARY];
  return raw
    .split(/\s+/)
    .map((part) =>
      part.includes('/') && !isAbsolute(part) && existsSync(part)
        ? resolve(part)
        : part
    );
}

// Writes the identity file the CLI reads from `<home>/.config/thaddeus`, so a
// command run with HOME=<home> acts as the identity with this 32-byte seed.
// Same layout and modes as `thaddeus identity init`.
export function writeCliHome(home: string, seed: Uint8Array): void {
  const identity = Identity.fromSeed(seed);
  const dir = join(home, '.config', 'thaddeus');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'identity.json');
  writeFileSync(
    path,
    `${JSON.stringify({ seed: Buffer.from(seed).toString('base64'), did: identity.did }, null, 2)}\n`,
    { mode: 0o600 }
  );
  chmodSync(path, 0o600);
}

// Runs one CLI command as the identity in `env.home`, in `env.cwd`, and
// returns its wall-clock time in milliseconds, process start included,
// because that is what a user waits for. Throws on a non-zero exit with the
// end of the command's output, so a refused push or land is a case error and
// never a fast sample. The child is a normal (non-detached) one, so a budget
// kill of the case's process group takes it down too.
export async function timeCli(
  cli: readonly string[],
  args: readonly string[],
  env: { home: string; cwd: string }
): Promise<number> {
  const started = performance.now();
  const proc = Bun.spawn([...cli, ...args], {
    cwd: env.cwd,
    env: { ...process.env, HOME: env.home },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const elapsed = performance.now() - started;
  if (code !== 0) {
    const output = `${stdout}${stderr}`.trim().slice(-OUTPUT_TAIL_CHARS);
    throw new Error(
      `thaddeus ${args.join(' ')} exited with code ${code}: ${output}`
    );
  }
  return elapsed;
}
