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

// Returns the root of a finished FileBackend holding the plan's repository,
// building it on first use. The build happens in a temporary directory that is
// renamed into place only after `.complete` (holding the manifest hash) is
// written, so a killed build never leaves a directory a later run would trust.
// A final directory without `.complete` is stale and gets rebuilt.
// `repos` is the total repository count: `bench` plus tiny `filler-<i>` ones.
export async function fixtureDir(
  plan: FixturePlan,
  opts: { cacheRoot?: string; repos?: number } = {}
): Promise<string> {
  const cacheRoot = opts.cacheRoot ?? DEFAULT_CACHE_ROOT;
  const repos = opts.repos ?? 1;
  const hash = manifestHash(plan);
  const final = join(cacheRoot, repos > 1 ? `${hash}-r${repos}` : hash);

  if (existsSync(join(final, COMPLETE))) return final;
  await mkdir(cacheRoot, { recursive: true });
  await rm(final, { recursive: true, force: true });

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
    try {
      await rename(tmp, final);
    } catch (error) {
      // Another process finished the same fixture first; keep its copy.
      if (!existsSync(join(final, COMPLETE))) throw error;
    }
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
