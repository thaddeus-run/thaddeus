import { ready } from '@thaddeus.run/identity';
import { FileBackend } from '@thaddeus.run/persist';
import { Platform, type Repo } from '@thaddeus.run/platform';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { CaseContext } from '../case';
import { fixtureDir, linkCopy } from '../fixtures/cache';

// Shared pieces of the library cases in this directory.

// The fixtures every library case runs on. `tiny` is there so the smoke tests
// may run each case; the record runs the other three.
export const LIBRARY_FIXTURES = ['tiny', 'small', 'medium', 'stress'] as const;

// Ops per timed repeat for the throughput cases. One op takes well under a
// millisecond, so a single op per sample would be mostly timer noise.
export const OPS_PER_SAMPLE = 50;

// Size of each new file a write case creates: about the mean write size of
// the fixture generator, whose writes are 200 to 8,000 bytes.
const NEW_FILE_BYTES = 4_096;

const NEW_FILE_EPOCH_MS = Date.UTC(2027, 0, 1);

// The path of the k-th file a write case creates. Every timed op writes a new
// one, so no op overwrites fixture data or an earlier op's file.
export function newFilePath(k: number): string {
  return `bench-new/${k}.ts`;
}

// Deterministic content of the k-th new file: one exported constant, padded
// with a comment to NEW_FILE_BYTES. Distinct per k, so each put stores a new
// plaintext.
export function newFileContent(k: number): Uint8Array {
  const head = `// ${newFilePath(k)}\nexport const value${k} = ${k};\n`;
  const pad = NEW_FILE_BYTES - head.length - 3;
  return new TextEncoder().encode(`${head}//${'.'.repeat(pad)}\n`);
}

// The pinned `at` of the k-th new op: one second apart from 2027-01-01, after
// every fixture timestamp.
export function newFileAt(k: number): string {
  return new Date(NEW_FILE_EPOCH_MS + k * 1_000)
    .toISOString()
    .replace('.000Z', 'Z');
}

// Sum of the sizes of the regular files under `root`, the bytes a FileBackend
// root holds. The cache's `.complete` marker belongs to the bench, not to the
// backend, so it is left out.
export function treeBytes(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !(dir === root && entry.name === '.complete'))
        total += lstatSync(path).size;
    }
  };
  walk(root);
  return total;
}

// A read-only case's state: the cached fixture root and the repository opened
// on it. Read-only cases open the cache directly, because nothing they call
// writes to the backend.
export interface OpenFixture {
  root: string;
  repo: Repo;
}

// Builds (or finds) the cached fixture and opens its `bench` repository.
// Loads the crypto first: opening verifies every op's signature.
export async function openCached(ctx: CaseContext): Promise<OpenFixture> {
  await ready();
  const root = await fixtureDir(ctx.plan);
  const repo = await new Platform().openDurable('bench', new FileBackend(root));
  return { root, repo };
}

// A write case's fixture: `cached` is the shared cache directory, measured
// for `diskBytes`; `root` is a hard-link copy of it in the case's workDir,
// which is what the case's FileBackend writes into. FileBackend replaces files
// by rename, so writes to the copy never reach the cache.
export interface WritableFixture {
  cached: string;
  root: string;
}

// Hard-link copies the cached fixture into `ctx.workDir`.
export async function writableCopy(ctx: CaseContext): Promise<WritableFixture> {
  await ready();
  const cached = await fixtureDir(ctx.plan);
  const root = join(ctx.workDir, 'root');
  await linkCopy(cached, root);
  return { cached, root };
}

// Like `openCached`, but on a writable copy of the fixture.
export async function openWritable(
  ctx: CaseContext
): Promise<WritableFixture & { repo: Repo }> {
  const fixture = await writableCopy(ctx);
  const repo = await new Platform().openDurable(
    'bench',
    new FileBackend(fixture.root)
  );
  return { ...fixture, repo };
}
