import { Client } from '@thaddeus.run/client';
import { FileBackend } from '@thaddeus.run/persist';
import { Platform, type Repo } from '@thaddeus.run/platform';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';

import { initIdentity, loadIdentity } from './identity';
import {
  baseSnapshot,
  type Config,
  diffWorkingTree,
  findRoot,
  loadConfig,
  materializeToDisk,
  saveConfig,
} from './workcopy';

export interface CliEnv {
  cwd: string;
  home: string;
  // FetchLike matches the server's fetch(req: Request) shape, keeping it
  // structurally compatible with both the injected server handler and global
  // fetch (which also accepts Request). NOT `typeof fetch` to avoid the
  // overloaded global type mismatch with createServer(...).fetch.
  fetchImpl?: (req: Request) => Promise<Response>;
  out?: (line: string) => void;
}

const USAGE = `thaddeus — the Thaddeus CLI
  init                              create a self-owned identity
  create <server> <repo>           create a repo on a server
  clone  <server> <repo> [dir]     clone a repo to a working tree
  status                           show working-tree changes
  push   [--no-land]               commit + upload + land into main
  land                             land uploaded-but-unmerged commits`;

// Re-open the local durable repo for a working copy at `root`.
async function openLocal(root: string, repoName: string): Promise<Repo> {
  return new Platform().openDurable(
    repoName,
    new FileBackend(join(root, '.thaddeus', 'store'))
  );
}

// How many ops are reachable from local `main` but not from `base` (the last
// synced server heads) — i.e. committed-but-unpublished.
function headsAhead(repo: Repo, base: readonly string[]): number {
  const all = repo.log.ops();
  const byId = new Map(all.map((o) => [o.id, o]));
  const closure = (heads: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const stack = [...heads];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      const op = byId.get(id);
      if (op !== undefined) stack.push(...op.parents);
    }
    return seen;
  };
  const baseClosure = closure(base);
  let n = 0;
  for (const id of closure(repo.log.heads('main'))) {
    if (!baseClosure.has(id)) n += 1;
  }
  return n;
}

// The injectable entry point. Returns a process exit code.
export async function run(
  argv: readonly string[],
  env: CliEnv
): Promise<number> {
  const out = env.out ?? ((l: string): void => console.log(l));
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case 'init': {
        const { values } = parseArgs({
          args: [...rest],
          options: { force: { type: 'boolean' } },
          allowPositionals: true,
        });
        const { did, created } = initIdentity(env.home, values.force === true);
        out(created ? `created identity ${did}` : `identity ${did}`);
        return 0;
      }
      case 'create': {
        const [server, repo] = rest;
        if (server === undefined || repo === undefined) {
          out('usage: thaddeus create <server> <repo>');
          return 2;
        }
        const client = new Client(
          server,
          loadIdentity(env.home),
          env.fetchImpl
        );
        const created = await client.createRepo(repo);
        out(`created ${created.name} (owner ${created.owner})`);
        return 0;
      }
      case 'clone': {
        const [server, repo, dirArg] = rest;
        if (server === undefined || repo === undefined) {
          out('usage: thaddeus clone <server> <repo> [dir]');
          return 2;
        }
        const dir = dirArg ?? repo.split('/').pop() ?? repo;
        // Resolve relative dirs against cwd; absolute paths are used as-is.
        const target = isAbsolute(dir) ? dir : join(env.cwd, dir);
        const identity = loadIdentity(env.home);
        const client = new Client(server, identity, env.fetchImpl);
        const { repo: local, heads } = await client.clone(
          repo,
          new FileBackend(join(target, '.thaddeus', 'store'))
        );
        await materializeToDisk(local, 'main', identity, target);
        const cfg: Config = { server, repo, base: [...heads] };
        saveConfig(target, cfg);
        out(
          `cloned ${repo} into ${dir} (${heads.length === 0 ? 'empty' : `${heads.length} head(s)`})`
        );
        return 0;
      }
      case 'status': {
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const identity = loadIdentity(env.home);
        const local = await openLocal(root, cfg.repo);
        const snap = await baseSnapshot(local, 'main', identity);
        const { added, modified, deleted } = diffWorkingTree(root, snap);
        const ahead = headsAhead(local, cfg.base);
        if (
          added.length + modified.length + deleted.length === 0 &&
          ahead === 0
        ) {
          out('clean');
          return 0;
        }
        for (const p of added) out(`added:    ${p}`);
        for (const p of modified) out(`modified: ${p}`);
        for (const p of deleted) out(`deleted:  ${p}`);
        if (ahead > 0)
          out(
            `(${ahead} commit(s) not published — run 'thaddeus push' or 'land')`
          );
        return 0;
      }
      // push / land are added in Task 6.
      case undefined:
      case 'help':
      case '--help':
        out(USAGE);
        return 0;
      default:
        out(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    out(`error: ${(e as Error).message}`);
    return 1;
  }
}
