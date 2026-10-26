import { concatBytes } from '@noble/hashes/utils';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { cachedBuild } from '../fixtures/cache';
import { contentFor } from '../fixtures/content';
import { manifestHash } from '../fixtures/plan';
import type { FixturePlan } from '../fixtures/plan';

// The git side of the everyday suite: a serial fixture plan replayed into a
// bare git repository through `git fast-import`, so git and thaddeus see the
// same files and the same history shape.

// Bump when the stream or the repository layout changes for the same plan, so
// old cached repositories stop matching.
export const GIT_SEED_VERSION = 1;

// How much of a failed command's output goes into the error.
const OUTPUT_TAIL_CHARS = 2_000;

// How much `fast-import` input is gathered before it is written to git.
const INPUT_BATCH_BYTES = 1 << 20;

// Yields the `git fast-import` input for a serial plan, one chunk per write or
// remove step, so a caller can pipe it into git with bounded memory (a stress
// plan's whole stream is around 800 MB). Each write or remove step becomes one
// commit on its view's branch, with the step's author and time. A fork starts
// the view at main's current tip, and a land moves `main` to the view's tip,
// which is a fast-forward because a serial plan gives main no writes of its
// own. Throws on a base plan, like `mainTree`, when first read.
export function* fastImportChunks(plan: FixturePlan): Generator<Uint8Array> {
  if (plan.spec.variant !== 'serial') {
    throw new Error(
      `fastImportChunks needs a serial plan, got ${plan.spec.name}`
    );
  }
  const enc = new TextEncoder();
  // The mark of each view's latest commit; a view with no entry has none yet.
  const tips = new Map<string, number>();
  let mark = 0;
  for (const step of plan.steps) {
    if (step.kind === 'fork') {
      const tip = tips.get(step.from);
      if (tip === undefined) tips.delete(step.view);
      else tips.set(step.view, tip);
      continue;
    }
    if (step.kind === 'land') {
      const tip = tips.get(step.from);
      if (tip === undefined) continue;
      tips.set('main', tip);
      yield enc.encode(`reset refs/heads/main\nfrom :${tip}\n\n`);
      continue;
    }
    const when = Math.floor(Date.parse(step.at) / 1000);
    const who = `author-${step.author} <author-${step.author}@bench.invalid> ${when} +0000`;
    const message = `${step.kind} ${step.path}\n`;
    mark += 1;
    let head = `commit refs/heads/${step.view}\nmark :${mark}\nauthor ${who}\ncommitter ${who}\n`;
    head += `data ${enc.encode(message).length}\n${message}`;
    const parent = tips.get(step.view);
    if (parent !== undefined) head += `from :${parent}\n`;
    if (step.kind === 'write') {
      const bytes = contentFor(step);
      head += `M 100644 inline ${step.path}\ndata ${bytes.length}\n`;
      yield concatBytes(enc.encode(head), bytes, enc.encode('\n\n'));
    } else {
      yield enc.encode(`${head}D ${step.path}\n\n`);
    }
    tips.set(step.view, mark);
  }
}

// Git with no system or user config, so a developer's ~/.gitconfig cannot
// change what a case times.
export function gitEnv(home: string): Record<string, string> {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'bench',
    GIT_AUTHOR_EMAIL: 'bench@bench.invalid',
    GIT_COMMITTER_NAME: 'bench',
    GIT_COMMITTER_EMAIL: 'bench@bench.invalid',
  } as Record<string, string>;
}

// Runs one git command and returns its wall-clock time in milliseconds,
// process start included, because that is what a user waits for. Throws on a
// non-zero exit with the end of the command's output, so a refused push or
// pull is a case error and never a fast sample. The child is a normal
// (non-detached) one, so a budget kill of the case's process group takes it
// down too.
export async function timeGit(
  args: readonly string[],
  env: { home: string; cwd: string }
): Promise<number> {
  const started = performance.now();
  const proc = Bun.spawn(['git', ...args], {
    cwd: env.cwd,
    env: gitEnv(env.home),
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
      `git ${args.join(' ')} exited with code ${code}: ${output}`
    );
  }
  return elapsed;
}

// Runs `git <args>` in `cwd`, writing `input` chunks to its stdin, and throws
// on a non-zero exit with the end of the output. Used for setup, which is not
// timed. Chunks are gathered into batches of about INPUT_BATCH_BYTES and each
// batch is flushed before the next is built, so a slow git slows the producer
// instead of letting the pipe's backlog grow in memory.
async function runGit(
  args: readonly string[],
  cwd: string,
  input?: Iterable<Uint8Array>
): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: gitEnv(cwd),
    stdin: input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let feedError: unknown;
  if (input !== undefined && typeof proc.stdin === 'object') {
    const sink = proc.stdin;
    try {
      let batch: Uint8Array[] = [];
      let size = 0;
      const drain = async () => {
        if (batch.length === 0) return;
        await sink.write(concatBytes(...batch));
        batch = [];
        size = 0;
        await sink.flush();
      };
      for (const chunk of input) {
        batch.push(chunk);
        size += chunk.length;
        if (size >= INPUT_BATCH_BYTES) await drain();
      }
      await drain();
    } catch (error) {
      // A git that exited early closes the pipe; its own output explains why.
      feedError = error;
    } finally {
      await sink.end();
    }
  }
  const [stdout, stderr, code] = await output;
  if (code !== 0 || feedError !== undefined) {
    const tail = `${stdout}${stderr}`.trim().slice(-OUTPUT_TAIL_CHARS);
    const feed =
      feedError === undefined
        ? ''
        : ` (input: ${feedError instanceof Error ? feedError.message : 'write failed'})`;
    throw new Error(
      `git ${args.join(' ')} exited with code ${code}${feed}: ${tail}`
    );
  }
}

// Returns the path of a bare repository holding the plan's replay, building
// it on first use through `cachedBuild` as
// `<cacheRoot>/<manifest hash>-git-v<GIT_SEED_VERSION>/bench.git`, the same
// way the server root is cached. Refuses a non-serial plan.
export async function gitFixture(
  plan: FixturePlan,
  opts: { cacheRoot?: string } = {}
): Promise<string> {
  if (plan.spec.variant !== 'serial') {
    throw new Error(`gitFixture needs a serial plan, got ${plan.spec.name}`);
  }
  const hash = manifestHash(plan);
  const dir = await cachedBuild(
    `${hash}-git-v${GIT_SEED_VERSION}`,
    hash,
    async (tmp) => {
      mkdirSync(tmp, { recursive: true });
      const repo = join(tmp, 'bench.git');
      await runGit(['init', '--bare', '-q', '-b', 'main', repo], tmp);
      await runGit(['fast-import', '--quiet'], repo, fastImportChunks(plan));
    },
    opts
  );
  return join(dir, 'bench.git');
}
