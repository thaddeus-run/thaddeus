import { Client } from '@thaddeus.run/client';
import { Workspace } from '@thaddeus.run/fs';
import type { Identity } from '@thaddeus.run/identity';
import { FileBackend } from '@thaddeus.run/persist';
import { Platform, type Repo } from '@thaddeus.run/platform';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';

import { initIdentity, loadIdentity } from './identity';
import { startServer } from './serve';
import {
  baseSnapshot,
  type Config,
  diffWorkingTree,
  equalBytes,
  findRoot,
  listWorkingFiles,
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
  land                             land uploaded-but-unmerged commits
  serve  [--port 4000] [--data ./thaddeus-data]   run a server`;

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

// Stage the working-tree diff into a workspace over local main and commit it,
// advancing local main. Returns the new local main heads and whether anything
// was committed.
async function commitDiff(
  root: string,
  repo: Repo,
  identity: Identity
): Promise<{ heads: string[]; committed: boolean }> {
  const ws = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: identity,
    name: 'staging',
  });
  const disk = listWorkingFiles(root);
  const diskSet = new Set(disk);
  for (const path of disk) {
    const bytes = new Uint8Array(readFileSync(join(root, path)));
    const current = await ws.read(path);
    if (current === null || !equalBytes(current, bytes)) {
      ws.write(path, bytes);
    }
  }
  for (const path of await ws.list()) {
    if (!diskSet.has(path)) {
      ws.rm(path);
    }
  }
  const ops = await ws.commit(identity);
  if (ops.length === 0) {
    return { heads: [...repo.log.heads('main')], committed: false };
  }
  const heads = [...repo.log.heads('staging')];
  await repo.log.repoint('main', heads);
  return { heads, committed: true };
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
      case 'push': {
        const { values } = parseArgs({
          args: [...rest],
          options: { 'no-land': { type: 'boolean' } },
          allowPositionals: true,
        });
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const identity = loadIdentity(env.home);
        const local = await openLocal(root, cfg.repo);
        const { heads, committed } = await commitDiff(root, local, identity);
        const ahead = headsAhead(local, cfg.base);
        if (!committed && ahead === 0) {
          out('nothing to publish');
          return 0;
        }
        const client = new Client(cfg.server, identity, env.fetchImpl);
        const pushed = await client.push(cfg.repo, local, heads);
        out(
          `uploaded ${pushed.accepted.ops} op(s), ${pushed.accepted.objects} object(s)`
        );
        if (pushed.rejected.length > 0) {
          out(
            `rejected ${pushed.rejected.length} item(s): ${pushed.rejected.map((r) => r.reason).join('; ')}`
          );
        }
        if (values['no-land'] === true) {
          out("uploaded (not landed — run 'thaddeus land' to publish)");
          return 0;
        }
        const landed = await client.land(cfg.repo, heads, 'main');
        if (!landed.landed) {
          out(
            `not landed: ${landed.reason ?? 'blocked by policy'} (content uploaded)`
          );
          return 1;
        }
        const localOps = new Set(local.log.ops().map((o) => o.id));
        const allPresent = landed.heads.every((h) => localOps.has(h));
        if (allPresent) {
          await local.log.repoint('main', landed.heads);
          saveConfig(root, { ...cfg, base: [...landed.heads] });
          out(`published to main (${landed.heads.length} head(s))`);
        } else {
          out(
            'published, but the remote has changes not in your clone — re-clone to sync'
          );
        }
        return 0;
      }
      case 'land': {
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const identity = loadIdentity(env.home);
        const local = await openLocal(root, cfg.repo);
        const heads = [...local.log.heads('main')];
        const client = new Client(cfg.server, identity, env.fetchImpl);
        const landed = await client.land(cfg.repo, heads, 'main');
        if (!landed.landed) {
          out(`not landed: ${landed.reason ?? 'nothing to land'}`);
          return 1;
        }
        const localOps = new Set(local.log.ops().map((o) => o.id));
        const allPresent = landed.heads.every((h) => localOps.has(h));
        if (allPresent) {
          await local.log.repoint('main', landed.heads);
          saveConfig(root, { ...cfg, base: [...landed.heads] });
          out(`landed to main (${landed.heads.length} head(s))`);
        } else {
          out(
            'published, but the remote has changes not in your clone — re-clone to sync'
          );
        }
        return 0;
      }
      case 'serve': {
        const { values } = parseArgs({
          args: [...rest],
          options: { port: { type: 'string' }, data: { type: 'string' } },
          allowPositionals: true,
        });
        const dataDir = values.data ?? join(env.cwd, 'thaddeus-data');
        const port = values.port !== undefined ? Number(values.port) : 4000;
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          out(`invalid --port: ${values.port}`);
          return 2;
        }
        const server = startServer({ dataDir, port });
        out(`thaddeus serving on ${server.url} (data: ${dataDir})`);
        process.on('SIGINT', () => {
          server
            .stop()
            .then(() => process.exit(0))
            .catch(() => process.exit(1));
        });
        await new Promise<never>(() => {}); // block until interrupted
        return 0; // unreachable
      }
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
    const msg = e instanceof Error ? e.message : String(e);
    out(`error: ${msg}`);
    return 1;
  }
}
