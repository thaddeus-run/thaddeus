import { FileBackend, MemoryBackend } from '@thaddeus.run/persist';
import type { Backend } from '@thaddeus.run/store';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { materializeFixture } from './materialize';
import { generateFixture, manifestHash } from './plan';
import type { FixturePlan } from './plan';
import { tinySpec } from './spec';

// bench/.cache, found from this file's location so the cache is the same
// directory no matter where the process was started.
const DEFAULT_CACHE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.cache'
);

// The marker a finished cache directory holds; its content is the hash.
export const COMPLETE = '.complete';
let tmpCounter = 0;

// Puts in flight at once while copying a filler repository to disk.
const FILLER_COPY_CONCURRENCY = 32;

// Scratch directories for running cases, on the same filesystem as the cache
// so `linkCopy` can hard-link a fixture into them (a hard link cannot cross
// filesystems, and /tmp is often a tmpfs). This also keeps write cases on the
// disk the fixture lives on instead of in RAM.
export const WORK_ROOT = join(DEFAULT_CACHE_ROOT, '.work');

// Materializes tiny filler repository `i` in memory, then copies its records
// into `backend`. Replaying straight onto a FileBackend would make every
// filler's createDurable list the whole root, which grows with each filler,
// so a 1,000-repository root would take minutes instead of seconds.
async function addFiller(backend: Backend, i: number): Promise<void> {
  const memory = new MemoryBackend();
  const filler = generateFixture({ ...tinySpec(), seed: i });
  await materializeFixture(filler, memory, `filler-${i}`);
  const keys = await memory.list('');
  for (let at = 0; at < keys.length; at += FILLER_COPY_CONCURRENCY) {
    await Promise.all(
      keys.slice(at, at + FILLER_COPY_CONCURRENCY).map(async (key) => {
        const bytes = await memory.get(key);
        if (bytes !== undefined) await backend.put(key, bytes);
      })
    );
  }
}

// Moves a finished temporary build to its final path without ever deleting a
// directory another process may have just published. If the rename loses to a
// complete directory, that one is kept. If it loses to a stale directory (no
// `.complete`, left by a killed build), the stale one is moved aside under a
// unique name and the rename is retried once.
async function publish(tmp: string, final: string): Promise<void> {
  try {
    await rename(tmp, final);
    return;
  } catch (error) {
    if (existsSync(join(final, COMPLETE))) return;
    if (!existsSync(final)) throw error;
  }
  const aside = `${final}.stale-${process.pid}-${tmpCounter++}`;
  await rename(final, aside);
  try {
    await rename(tmp, final);
  } catch (error) {
    if (!existsSync(join(final, COMPLETE))) throw error;
  } finally {
    await rm(aside, { recursive: true, force: true });
  }
}

// Returns `<cacheRoot>/<name>`, building it with `build` on first use. The
// build writes into a temporary directory that is renamed into place only
// after `.complete` (holding `hash`) is written, so a killed build never
// leaves a directory a later run would trust, and a directory without
// `.complete` is treated as stale and replaced. `beforePublish` is a test
// seam that runs after the build, before the rename.
export async function cachedBuild(
  name: string,
  hash: string,
  build: (tmp: string) => Promise<void>,
  opts: { cacheRoot?: string; beforePublish?: () => void | Promise<void> } = {}
): Promise<string> {
  const cacheRoot = opts.cacheRoot ?? DEFAULT_CACHE_ROOT;
  const final = join(cacheRoot, name);
  if (existsSync(join(final, COMPLETE))) return final;
  await mkdir(cacheRoot, { recursive: true });

  const tmp = join(cacheRoot, `.tmp-${process.pid}-${tmpCounter++}`);
  await rm(tmp, { recursive: true, force: true });
  try {
    await build(tmp);
    await writeFile(join(tmp, COMPLETE), hash);
    await opts.beforePublish?.();
    await publish(tmp, final);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return final;
}

// Returns the root of a finished FileBackend holding the plan's repository,
// building it on first use through `cachedBuild`, under the manifest hash.
// `repos` is the total repository count: `bench` plus tiny `filler-<i>` ones.
export async function fixtureDir(
  plan: FixturePlan,
  opts: {
    cacheRoot?: string;
    repos?: number;
    beforePublish?: () => void | Promise<void>;
  } = {}
): Promise<string> {
  const repos = opts.repos ?? 1;
  const hash = manifestHash(plan);
  return cachedBuild(
    repos > 1 ? `${hash}-r${repos}` : hash,
    hash,
    async (tmp) => {
      const backend = new FileBackend(tmp);
      await materializeFixture(plan, backend, 'bench');
      for (let i = 1; i < repos; i++) await addFiller(backend, i);
    },
    opts
  );
}

// Copies a directory tree using hard links (`cp -al`), so a large fixture is
// duplicated in milliseconds without using more disk. This is safe because
// FileBackend never writes in place: it writes a temp file and renames it.
export async function linkCopy(src: string, dst: string): Promise<void> {
  await mkdir(dirname(dst), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('cp', ['-al', src, dst], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`cp -al exited with ${code}`))
    );
  });
}
