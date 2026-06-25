import type { Identity } from '@thaddeus.run/identity';
import type { Repo } from '@thaddeus.run/platform';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

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

// Relative POSIX paths of every file under `root`, excluding `.thaddeus/`.
export function listWorkingFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.thaddeus') {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return out.sort();
}

// The decrypted snapshot of `view` (path -> bytes) the reader can read.
export async function baseSnapshot(
  repo: Repo,
  view: string,
  reader: Identity
): Promise<Map<string, Uint8Array>> {
  const snap = new Map<string, Uint8Array>();
  for (const [path, entry] of repo.log.materialize(view, reader)) {
    if (entry.ref !== null) {
      snap.set(path, await repo.store.get(entry.ref, reader));
    }
  }
  return snap;
}

// Write a view's materialized snapshot to disk under `root`.
export async function materializeToDisk(
  repo: Repo,
  view: string,
  reader: Identity,
  root: string
): Promise<void> {
  const snap = await baseSnapshot(repo, view, reader);
  for (const [path, bytes] of snap) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
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
