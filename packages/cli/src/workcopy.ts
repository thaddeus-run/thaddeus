import type { Identity } from '@thaddeus.run/identity';
import type { Repo } from '@thaddeus.run/platform';
import { AccessDenied } from '@thaddeus.run/store';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { loadIgnore } from './ignore';

export interface Config {
  server: string;
  repo: string;
  base: string[];
}

// Walk up from `cwd` to the nearest directory containing a `.thaddeus/` dir.
export function findRoot(cwd: string): string | undefined {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.thaddeus'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export function loadConfig(root: string): Config {
  return JSON.parse(
    readFileSync(join(root, '.thaddeus', 'config.json'), 'utf8')
  ) as Config;
}

export function saveConfig(root: string, cfg: Config): void {
  mkdirSync(join(root, '.thaddeus'), { recursive: true });
  writeFileSync(
    join(root, '.thaddeus', 'config.json'),
    `${JSON.stringify(cfg, null, 2)}\n`
  );
}

// Relative POSIX paths of every file under `root` that is not ignored. Honors
// the repo's `.gitignore`/`.thaddeusignore` and always prunes `.git`,
// `.thaddeus`, and `node_modules` — so `status`/`diff`/`push` never walk or
// upload dependency/build trees (the source of the pre-ignore slowness + 413s).
export function listWorkingFiles(root: string): string[] {
  const ig = loadIgnore(root);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (!ig.ignored(rel, true)) walk(full); // prune ignored subtrees
      } else if (entry.isFile() && !ig.ignored(rel, false)) {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

// The decrypted snapshot of `view` (path -> bytes) the reader can read. Reads
// are decryption-bounded: a member holding no capability for an object simply
// cannot see it, so such a path is SKIPPED (as `Workspace.read` does) rather
// than failing the whole status/diff/materialize. `onDenied` observes the skips.
export async function baseSnapshot(
  repo: Repo,
  view: string,
  reader: Identity,
  onDenied?: (path: string) => void
): Promise<Map<string, Uint8Array>> {
  const snap = new Map<string, Uint8Array>();
  for (const [path, entry] of repo.log.materialize(view, reader)) {
    if (entry.ref !== null) {
      try {
        snap.set(path, await repo.store.get(entry.ref, reader));
      } catch (err) {
        if (!(err instanceof AccessDenied)) {
          throw err;
        }
        onDenied?.(path);
      }
    }
  }
  return snap;
}

// Resolve `path` under `root`, or return null if it escapes the worktree /
// is absolute / targets the .thaddeus metadata dir. A repo path is untrusted
// input and must be validated before being written to disk.
function safeTarget(root: string, path: string): string | null {
  if (isAbsolute(path)) return null;
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  if (
    rel === '.thaddeus' ||
    rel.startsWith('.thaddeus/') ||
    rel.split('/')[0] === '.thaddeus'
  )
    return null;
  return target;
}

// Export safeTarget for tests.
export { safeTarget };

// Write a view's materialized snapshot to disk under `root`.
export async function materializeToDisk(
  repo: Repo,
  view: string,
  reader: Identity,
  root: string
): Promise<void> {
  const snap = await baseSnapshot(repo, view, reader);
  for (const [path, bytes] of snap) {
    const full = safeTarget(root, path);
    if (full === null) {
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
  }
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

// Compare the working tree on disk to a base snapshot.
export function diffWorkingTree(
  root: string,
  base: ReadonlyMap<string, Uint8Array>
): { added: string[]; modified: string[]; deleted: string[] } {
  const disk = listWorkingFiles(root);
  const diskSet = new Set(disk);
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const path of disk) {
    const baseBytes = base.get(path);
    const diskBytes = new Uint8Array(readFileSync(join(root, path)));
    if (baseBytes === undefined) {
      added.push(path);
    } else if (!equalBytes(baseBytes, diskBytes)) {
      modified.push(path);
    }
  }
  for (const path of base.keys()) {
    if (!diskSet.has(path)) {
      deleted.push(path);
    }
  }
  return { added, modified, deleted };
}
