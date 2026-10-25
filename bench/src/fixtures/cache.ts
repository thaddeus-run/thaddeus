import { FileBackend } from '@thaddeus.run/persist';
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

const COMPLETE = '.complete';
let tmpCounter = 0;

// Scratch directories for running cases, on the same filesystem as the cache
// so `linkCopy` can hard-link a fixture into them (a hard link cannot cross
// filesystems, and /tmp is often a tmpfs). This also keeps write cases on the
// disk the fixture lives on instead of in RAM.
export const WORK_ROOT = join(DEFAULT_CACHE_ROOT, '.work');

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

// Returns the root of a finished FileBackend holding the plan's repository,
// building it on first use. The build happens in a temporary directory that is
// renamed into place only after `.complete` (holding the manifest hash) is
// written, so a killed build never leaves a directory a later run would trust,
// and a directory without `.complete` is treated as stale and replaced.
// `repos` is the total repository count: `bench` plus tiny `filler-<i>` ones.
// `beforePublish` is a test seam that runs after the build, before the rename.
export async function fixtureDir(
  plan: FixturePlan,
  opts: {
    cacheRoot?: string;
    repos?: number;
    beforePublish?: () => void | Promise<void>;
  } = {}
): Promise<string> {
  const cacheRoot = opts.cacheRoot ?? DEFAULT_CACHE_ROOT;
  const repos = opts.repos ?? 1;
  const hash = manifestHash(plan);
  const final = join(cacheRoot, repos > 1 ? `${hash}-r${repos}` : hash);

  if (existsSync(join(final, COMPLETE))) return final;
  await mkdir(cacheRoot, { recursive: true });

  const tmp = join(cacheRoot, `.tmp-${process.pid}-${tmpCounter++}`);
  await rm(tmp, { recursive: true, force: true });
  try {
    const backend = new FileBackend(tmp);
    await materializeFixture(plan, backend, 'bench');
    for (let i = 1; i < repos; i++) {
      const filler = generateFixture({ ...tinySpec(), seed: i });
      await materializeFixture(filler, backend, `filler-${i}`);
    }
    await writeFile(join(tmp, COMPLETE), hash);
    await opts.beforePublish?.();
    await publish(tmp, final);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return final;
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
