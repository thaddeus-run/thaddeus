import { signDelegation } from '@thaddeus.run/agent';
import { Client, reachablePids, reshareObjects } from '@thaddeus.run/client';
import { Workspace } from '@thaddeus.run/fs';
import {
  HeuristicExtractor,
  SymbolGraph,
  SymbolOpLog,
} from '@thaddeus.run/graph';
import { type Identity, PublicIdentity } from '@thaddeus.run/identity';
import type { Op } from '@thaddeus.run/log';
import { FileBackend } from '@thaddeus.run/persist';
import { Platform, type Repo } from '@thaddeus.run/platform';
import { type Provenance, ProvenanceLog } from '@thaddeus.run/provenance';
import { type ContributionClaim, signClaim } from '@thaddeus.run/reputation';
import { signVeto, VetoLog } from '@thaddeus.run/review';
import { type Backend, scoped } from '@thaddeus.run/store';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { parseArgs } from 'node:util';

import {
  HOSTED_SERVER,
  isServerUrl,
  loadCliConfig,
  noServerHint,
  saveCliConfig,
} from './config';
import { type FileDiff, fileDiff } from './diff';
import { HELP, USAGE } from './help';
import { initIdentity, loadIdentity } from './identity';
import { startServer } from './serve';
import { VERSION } from './version';
import {
  baseSnapshot,
  type Config,
  diffWorkingTree,
  equalBytes,
  findRoot,
  listWorkingFiles,
  loadConfig,
  materializeToDisk,
  safeTarget,
  saveConfig,
  storePath,
  viewOf,
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

// Detect the `--json` flag a read verb offers for scripting/TUI. Kept simple so
// verbs that take a bare positional don't all need full parseArgs plumbing.
function wantsJson(rest: readonly string[]): boolean {
  return rest.includes('--json');
}

// Re-open the durable repo for a working copy — over its own store, or the
// shared one a `workspace` points at.
async function openLocal(root: string, cfg: Config): Promise<Repo> {
  return new Platform().openDurable(
    cfg.repo,
    new FileBackend(storePath(root, cfg))
  );
}

// The working copy's per-repo backend scope — the same `repo/<name>/` namespace
// openDurable uses — so a ProvenanceLog reads/writes the "why" alongside the code.
function repoScope(root: string, cfg: Config): Backend {
  return scoped(new FileBackend(storePath(root, cfg)), `repo/${cfg.repo}/`);
}

// Ops reachable from a view's heads, newest-first (descending lamport, id).
function opsOnView(repo: Repo, view: string): Op[] {
  const all = repo.log.ops();
  const byId = new Map(all.map((o) => [o.id, o]));
  const seen = new Set<string>();
  const stack = [...repo.log.heads(view)];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const op = byId.get(id);
    if (op !== undefined) stack.push(...op.parents);
  }
  return all
    .filter((o) => seen.has(o.id))
    .sort((x, y) =>
      x.lamport !== y.lamport ? y.lamport - x.lamport : x.id < y.id ? 1 : -1
    );
}

// The ops reachable from local `main` but not from `base` — i.e. every
// committed-but-unpublished op, newest-first. `push -m` annotates these when no
// new op was committed this invocation (so the why is never silently dropped).
function opsAhead(repo: Repo, base: readonly string[], view: string): Op[] {
  const byId = new Map(repo.log.ops().map((o) => [o.id, o]));
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
  return opsOnView(repo, view).filter((o) => !baseClosure.has(o.id));
}

// How many ops are reachable from local `main` but not from `base` (the last
// synced server heads) — i.e. committed-but-unpublished.
function headsAhead(repo: Repo, base: readonly string[], view: string): number {
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
  for (const id of closure(repo.log.heads(view))) {
    if (!baseClosure.has(id)) n += 1;
  }
  return n;
}

// Build a subject-signed merge claim (P07) for each op the author is publishing,
// so an attesting host can co-sign it on land. Only the author's own ops earn a
// merge (the server re-checks subject === op.author before attesting), and a
// non-attesting server simply ignores the claims — so this is always safe to send.
function mergeClaims(
  repoName: string,
  ops: readonly Op[],
  identity: Identity
): ContributionClaim[] {
  const at = new Date().toISOString();
  return ops
    .filter((op) => op.author === identity.did)
    .map((op) =>
      signClaim({ repo: repoName, ref: op.id, kind: 'merge', at }, identity)
    );
}

// Stage the working-tree diff into a workspace over local main and commit it,
// advancing local main. Returns the new local main heads and whether anything
// was committed.
async function commitDiff(
  root: string,
  repo: Repo,
  identity: Identity,
  view: string
): Promise<{ heads: string[]; committed: boolean; ops: readonly Op[] }> {
  const ws = Workspace.open(repo.log, repo.store, {
    source: view,
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
    return { heads: [...repo.log.heads(view)], committed: false, ops: [] };
  }
  const heads = [...repo.log.heads('staging')];
  await repo.log.repoint(view, heads);
  return { heads, committed: true, ops };
}

// Share read-capabilities for everything reachable from `heads` with the repo's
// OTHER members (owner + non-revoked delegates). `store.put` seals a new object
// only to its author, so without this nobody else — not even the repo owner —
// can decrypt what we are about to publish.
//
// Fails CLOSED: if the member list can't be read we throw rather than upload
// objects sealed to us alone, which would publish content no collaborator can
// decrypt while `push` still reported success. Nothing is uploaded; retry.
async function reshareToMembers(
  client: Client,
  repoName: string,
  local: Repo,
  heads: readonly string[],
  identity: Identity
): Promise<number> {
  let dids: string[];
  try {
    dids = await client.members(repoName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not read the repo's members (${msg}) — refusing to publish content collaborators could not decrypt; nothing was uploaded, please retry`
    );
  }
  const members = dids
    .filter((did) => did !== identity.did)
    .map((did) => PublicIdentity.fromDid(did));
  if (members.length === 0) {
    return 0;
  }
  return reshareObjects(local, reachablePids(local, heads), members, identity);
}

// The snapshot of `view` this working copy can read, or null when the tree is
// dirty / holds unpublished commits. `pull`, `checkout` and `merge` only ever
// advance a clean, not-ahead copy in v1 — merging a divergent local history is
// deferred. Paths we hold no key for are never materialized, so they must not be
// mistaken for local additions (a copy left on disk from before a key rotation
// would otherwise wedge these commands on a phantom dirty tree).
async function readyToSwitch(
  root: string,
  local: Repo,
  cfg: Config,
  view: string,
  identity: Identity,
  out: (line: string) => void
): Promise<Map<string, Uint8Array> | null> {
  const denied = new Set<string>();
  const before = await baseSnapshot(local, view, identity, (p) =>
    denied.add(p)
  );
  const { added, modified, deleted } = diffWorkingTree(root, before);
  const dirty =
    added.filter((p) => !denied.has(p)).length +
    modified.length +
    deleted.length;
  if (dirty > 0) {
    out('uncommitted changes — commit and push (or discard) first');
    return null;
  }
  if (headsAhead(local, cfg.base, view) > 0) {
    out("unpublished commits — run 'thaddeus push' or 'land' first");
    return null;
  }
  return before;
}

// Make the on-disk tree mirror `view`: drop what `before` had and `view` lacks,
// then write out everything the reader can decrypt.
async function retree(
  root: string,
  local: Repo,
  view: string,
  identity: Identity,
  before: ReadonlyMap<string, Uint8Array>
): Promise<void> {
  const after = await baseSnapshot(local, view, identity);
  for (const path of before.keys()) {
    if (!after.has(path)) {
      const full = safeTarget(root, path);
      if (full !== null) {
        rmSync(full, { force: true });
      }
    }
  }
  await materializeToDisk(local, view, identity, root);
}

// Resolve the server for create/clone and strip it from the positionals.
// Precedence: an explicit --server flag (validated by the caller) > a leading
// `https://` positional (back-compat with `create <server> <repo>`) > the saved
// default (`thaddeus use`). Returns null when none is available — the caller
// prints noServerHint. Since every provided path is an http(s) URL, a null here
// unambiguously means "no server set", not "invalid server".
function resolveServer(
  flag: string | undefined,
  positionals: string[],
  home: string
): { server: string; rest: string[] } | null {
  let server = flag;
  let rest = positionals;
  if (server === undefined && isServerUrl(positionals[0])) {
    server = positionals[0];
    rest = positionals.slice(1);
  }
  server ??= loadCliConfig(home).defaultServer;
  if (server === undefined || !isServerUrl(server)) {
    return null;
  }
  return { server, rest };
}

// The injectable entry point. Returns a process exit code.
export async function run(
  argv: readonly string[],
  env: CliEnv
): Promise<number> {
  const out = env.out ?? ((l: string): void => console.log(l));
  const [command, ...rest] = argv;

  // Global flags, handled before dispatch so they work with or without a repo.
  if (command === '--version' || command === '-v' || command === 'version') {
    out(VERSION);
    return 0;
  }
  // `thaddeus help [<cmd>]`, bare `thaddeus`, and `thaddeus --help` show the
  // overview or a specific command's detailed help.
  if (command === undefined || command === 'help' || command === '--help') {
    const topic = command === 'help' ? rest[0] : undefined;
    out(topic !== undefined && HELP[topic] !== undefined ? HELP[topic] : USAGE);
    return 0;
  }
  // `thaddeus <cmd> --help/-h` prints that command's detailed help.
  if (
    (rest.includes('--help') || rest.includes('-h')) &&
    HELP[command] !== undefined
  ) {
    out(HELP[command]);
    return 0;
  }

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
      case 'whoami': {
        const identity = loadIdentity(env.home);
        out(
          wantsJson(rest) ? JSON.stringify({ did: identity.did }) : identity.did
        );
        return 0;
      }
      case 'use': {
        const { values, positionals } = parseArgs({
          args: [...rest],
          options: {
            hosted: { type: 'boolean' },
            clear: { type: 'boolean' },
            json: { type: 'boolean' },
          },
          allowPositionals: true,
        });
        const cfg = loadCliConfig(env.home);
        if (values.clear === true) {
          saveCliConfig(env.home, { ...cfg, defaultServer: undefined });
          out('cleared the default server');
          return 0;
        }
        // `use --hosted` opts in to the official server; `use <url>` sets a
        // custom one; bare `use` shows the current default (never pre-filled).
        // Passing both is ambiguous — reject rather than silently pick one.
        if (values.hosted === true && positionals[0] !== undefined) {
          out('use either --hosted or a <url>, not both');
          return 2;
        }
        const url = values.hosted === true ? HOSTED_SERVER : positionals[0];
        if (url === undefined) {
          if (values.json === true) {
            out(JSON.stringify({ defaultServer: cfg.defaultServer ?? null }));
            return 0;
          }
          out(
            cfg.defaultServer ??
              `no default server — set one with 'thaddeus use <url>', or the hosted server with 'thaddeus use --hosted' (${HOSTED_SERVER})`
          );
          return 0;
        }
        if (!isServerUrl(url)) {
          out(`invalid server url: ${url}`);
          return 2;
        }
        saveCliConfig(env.home, { ...cfg, defaultServer: url });
        out(`default server set to ${url}`);
        return 0;
      }
      case 'repos': {
        const { values } = parseArgs({
          args: [...rest],
          options: {
            server: { type: 'string' },
            mine: { type: 'boolean' },
            json: { type: 'boolean' },
          },
          allowPositionals: true,
        });
        if (values.server !== undefined && !isServerUrl(values.server)) {
          out(`invalid --server url: ${values.server}`);
          return 2;
        }
        const resolved = resolveServer(values.server, [], env.home);
        if (resolved === null) {
          out(noServerHint('repos'));
          return 2;
        }
        const identity = loadIdentity(env.home);
        const client = new Client(resolved.server, identity, env.fetchImpl);
        let repos = await client.listReposWithOwners();
        if (values.mine === true) {
          repos = repos.filter((r) => r.owner === identity.did);
        }
        if (values.json === true) {
          out(JSON.stringify(repos));
          return 0;
        }
        if (repos.length === 0) {
          out(values.mine === true ? 'no repos owned by you' : 'no repos');
          return 0;
        }
        for (const r of repos) {
          out(`${r.name}${r.owner !== null ? `  (owner ${r.owner})` : ''}`);
        }
        return 0;
      }
      case 'delete': {
        const { values, positionals } = parseArgs({
          args: [...rest],
          options: { server: { type: 'string' }, yes: { type: 'boolean' } },
          allowPositionals: true,
        });
        if (values.server !== undefined && !isServerUrl(values.server)) {
          out(`invalid --server url: ${values.server}`);
          return 2;
        }
        const resolved = resolveServer(values.server, positionals, env.home);
        if (resolved === null) {
          out(noServerHint('delete'));
          return 2;
        }
        const repo = resolved.rest[0];
        if (repo === undefined) {
          out('usage: thaddeus delete <repo> [--server <url>] --yes');
          return 2;
        }
        // Destructive and irreversible (no undo/GC yet), so require an explicit
        // --yes; the server independently gates the delete on repo ownership.
        if (values.yes !== true) {
          out(
            `refusing to delete ${repo} without --yes (this is irreversible)`
          );
          return 2;
        }
        const client = new Client(
          resolved.server,
          loadIdentity(env.home),
          env.fetchImpl
        );
        await client.deleteRepo(repo);
        out(`deleted ${repo}`);
        return 0;
      }
      case 'create': {
        const { values, positionals } = parseArgs({
          args: [...rest],
          options: { server: { type: 'string' } },
          allowPositionals: true,
        });
        if (values.server !== undefined && !isServerUrl(values.server)) {
          out(`invalid --server url: ${values.server}`);
          return 2;
        }
        const resolved = resolveServer(values.server, positionals, env.home);
        if (resolved === null) {
          out(noServerHint('create'));
          return 2;
        }
        const { server, rest: args } = resolved;
        const repo = args[0];
        if (repo === undefined) {
          out('usage: thaddeus create <repo> [--server <url>]');
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
        const { values, positionals } = parseArgs({
          args: [...rest],
          options: { server: { type: 'string' } },
          allowPositionals: true,
        });
        if (values.server !== undefined && !isServerUrl(values.server)) {
          out(`invalid --server url: ${values.server}`);
          return 2;
        }
        const resolved = resolveServer(values.server, positionals, env.home);
        if (resolved === null) {
          out(noServerHint('clone'));
          return 2;
        }
        const { server, rest: args } = resolved;
        const [repo, dirArg] = args;
        if (repo === undefined) {
          out('usage: thaddeus clone <repo> [dir] [--server <url>]');
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
        const cfg: Config = { server, repo, base: [...heads], view: 'main' };
        saveConfig(target, cfg);
        out(
          `cloned ${repo} into ${dir} (${heads.length === 0 ? 'empty' : `${heads.length} head(s)`})`
        );
        return 0;
      }
      case 'pull': {
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const view = viewOf(cfg);
        const identity = loadIdentity(env.home);
        const backend = new FileBackend(storePath(root, cfg));
        const local = await new Platform().openDurable(cfg.repo, backend);
        const before = await readyToSwitch(
          root,
          local,
          cfg,
          view,
          identity,
          out
        );
        if (before === null) {
          return 2;
        }
        const client = new Client(cfg.server, identity, env.fetchImpl);
        const { heads } = await client.pull(cfg.repo, local, backend, view);
        await retree(root, local, view, identity, before);
        saveConfig(root, { ...cfg, base: [...heads] });
        out(`pulled ${cfg.repo}@${view} (${heads.length} head(s))`);
        return 0;
      }
      case 'branch': {
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const view = viewOf(cfg);
        const identity = loadIdentity(env.home);
        const client = new Client(cfg.server, identity, env.fetchImpl);
        const name = rest.find((a) => !a.startsWith('-'));
        if (name === undefined) {
          const views = await client.listViews(cfg.repo);
          const names = Object.keys(views).sort();
          if (wantsJson(rest)) {
            out(JSON.stringify({ current: view, branches: names }));
            return 0;
          }
          for (const b of names) {
            out(`${b === view ? '*' : ' '} ${b}`);
          }
          return 0;
        }
        // A branch is a name over the current head-set — copy-on-write, never a
        // copy of files. It carries no new ops, so it needs no land policy.
        const local = await openLocal(root, cfg);
        // The server only accepts heads it has ingested; local-only commits
        // would fail with a cryptic "unknown head". Ask for a push instead.
        if (headsAhead(local, cfg.base, view) > 0) {
          out("unpublished commits — run 'thaddeus push' first");
          return 2;
        }
        const heads = [...local.log.heads(view)];
        const created = await client.createView(cfg.repo, name, heads);
        await local.log.repoint(name, created.heads);
        out(
          `created branch ${name} at ${created.heads.length} head(s) — open it with 'thaddeus workspace ${name}'`
        );
        return 0;
      }
      case 'workspace': {
        const { positionals } = parseArgs({
          args: [...rest],
          options: { json: { type: 'boolean' } },
          allowPositionals: true,
        });
        const [name, dirArg] = positionals;
        if (name === undefined) {
          out('usage: thaddeus workspace <branch> [dir]');
          return 2;
        }
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const identity = loadIdentity(env.home);
        // Workspaces share the ORIGIN's object store: if this copy is itself a
        // workspace, follow its pointer instead of nesting another level. The
        // new directory holds a config + materialized files, never a store —
        // that is what makes a working copy per branch effectively free.
        const store = storePath(root, cfg);
        const fallback = join(
          dirname(root),
          `${basename(root)}-${name.replaceAll('/', '-')}`
        );
        const dir = dirArg ?? fallback;
        const target = isAbsolute(dir) ? dir : join(env.cwd, dir);
        // Inside a working copy it would be tracked as working files; and the
        // same directory twice would clobber someone's tree.
        const rel = relative(root, target);
        if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
          out(
            'a workspace cannot live inside another working copy — pick a sibling directory'
          );
          return 2;
        }
        const backend = new FileBackend(store);
        const local = await new Platform().openDurable(cfg.repo, backend);
        const client = new Client(cfg.server, identity, env.fetchImpl);
        // The branch must exist server-side ('branch' always registers it
        // there); pulling an unknown view would silently repoint to empty.
        const views = await client.listViews(cfg.repo);
        if (views[name] === undefined) {
          out(`no branch ${name} — create it with 'thaddeus branch ${name}'`);
          return 1;
        }
        // `base` must be the heads the pull ACTUALLY fetched — a collaborator
        // could land between the existence check and the pull, and a stale base
        // would make the fresh workspace read as "ahead" of the server.
        const { heads } = await client.pull(cfg.repo, local, backend, name);
        // Atomic create: a non-recursive mkdir throws EEXIST instead of
        // accepting a directory created meanwhile, so we can never materialize
        // into someone else's path.
        try {
          mkdirSync(dirname(target), { recursive: true });
          mkdirSync(target);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            out(`${target} already exists`);
            return 2;
          }
          throw err;
        }
        await materializeToDisk(local, name, identity, target);
        saveConfig(target, {
          server: cfg.server,
          repo: cfg.repo,
          view: name,
          base: [...heads],
          store,
        });
        out(
          `workspace ${target} on ${name} (${heads.length} head(s), shared store — copy-on-write)`
        );
        return 0;
      }
      case 'checkout':
      case 'switch': {
        // Deliberately not a command: switching implies ONE tree that a branch
        // can hijack, plus a clean-tree gate — the worktree model. Working
        // copies here are cheap, so you open another one instead.
        out(
          'thaddeus has no checkout — you never switch a tree, you open another:\n' +
            '  thaddeus workspace <branch> [dir]   # a second working copy, copy-on-write\n' +
            'Each branch gets its own directory over the same store; the same branch\ncan be open in several at once.'
        );
        return 2;
      }
      case 'merge': {
        out(
          'thaddeus has no merge ceremony — landing IS the merge, under policy:\n' +
            '  thaddeus land <branch>   # land that branch into the one you are on'
        );
        return 2;
      }
      case 'status': {
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const view = viewOf(cfg);
        const identity = loadIdentity(env.home);
        const local = await openLocal(root, cfg);
        // Files this identity holds no capability for are skipped, not fatal.
        const skipped: string[] = [];
        const snap = await baseSnapshot(local, view, identity, (p) =>
          skipped.push(p)
        );
        // A path we hold no key for is absent from the snapshot, so a leftover
        // copy on disk would read as `added`; it is skipped, not new work.
        const skippedSet = new Set(skipped);
        const diff = diffWorkingTree(root, snap);
        const added = diff.added.filter((p) => !skippedSet.has(p));
        const { modified, deleted } = diff;
        const ahead = headsAhead(local, cfg.base, view);
        const clean =
          added.length + modified.length + deleted.length === 0 && ahead === 0;
        if (wantsJson(rest)) {
          out(
            JSON.stringify({
              branch: view,
              clean,
              added,
              modified,
              deleted,
              ahead,
              skipped,
            })
          );
          return 0;
        }
        out(`on branch ${view}`);
        if (clean && skipped.length === 0) {
          out('clean');
          return 0;
        }
        if (clean) {
          out('clean');
        }
        for (const p of added) out(`added:    ${p}`);
        for (const p of modified) out(`modified: ${p}`);
        for (const p of deleted) out(`deleted:  ${p}`);
        if (ahead > 0)
          out(
            `(${ahead} commit(s) not published — run 'thaddeus push' or 'land')`
          );
        if (skipped.length > 0)
          out(
            `(${skipped.length} file(s) not readable with your keys — skipped)`
          );
        return 0;
      }
      case 'diff': {
        const { values, positionals } = parseArgs({
          args: [...rest],
          options: {
            staged: { type: 'boolean' },
            json: { type: 'boolean' },
          },
          allowPositionals: true,
        });
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const view = viewOf(cfg);
        const identity = loadIdentity(env.home);
        const local = await openLocal(root, cfg);
        // Two modes. Default: the base 'main' snapshot vs the working tree on
        // disk. --staged: the last-synced base heads vs local 'main' — i.e. the
        // committed-but-unpublished changes.
        let base: Map<string, Uint8Array>;
        let target: Map<string, Uint8Array>;
        if (values.staged === true) {
          local.log.view('_diffbase', cfg.base);
          base = await baseSnapshot(local, '_diffbase', identity);
          target = await baseSnapshot(local, view, identity);
        } else {
          base = await baseSnapshot(local, view, identity);
          target = new Map<string, Uint8Array>();
          for (const p of listWorkingFiles(root)) {
            target.set(p, new Uint8Array(readFileSync(join(root, p))));
          }
        }
        const only = new Set(positionals);
        const changed: FileDiff[] = [];
        for (const p of [
          ...new Set([...base.keys(), ...target.keys()]),
        ].sort()) {
          if (only.size > 0 && !only.has(p)) {
            continue;
          }
          const b = base.get(p);
          const t = target.get(p);
          if (b !== undefined && t !== undefined && equalBytes(b, t)) {
            continue; // unchanged
          }
          changed.push(fileDiff(p, b, t));
        }
        if (values.json === true) {
          out(JSON.stringify(changed));
          return 0;
        }
        if (changed.length === 0) {
          out('no changes');
          return 0;
        }
        for (const fd of changed) {
          out(`diff ${fd.path} (${fd.status})`);
          if (fd.binary) {
            out('  binary file differs');
            continue;
          }
          if (fd.truncated) {
            out('  file too large to diff');
            continue;
          }
          for (const line of fd.lines) {
            out(`${line.tag}${line.text}`);
          }
        }
        return 0;
      }
      case 'push': {
        const { values } = parseArgs({
          args: [...rest],
          options: {
            'no-land': { type: 'boolean' },
            message: { type: 'string', short: 'm' },
          },
          allowPositionals: true,
        });
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const view = viewOf(cfg);
        const identity = loadIdentity(env.home);
        const local = await openLocal(root, cfg);
        const { heads, committed, ops } = await commitDiff(
          root,
          local,
          identity,
          view
        );
        const ahead = headsAhead(local, cfg.base, view);
        if (!committed && ahead === 0) {
          out('nothing to publish');
          return 0;
        }
        // A `-m "<why>"` attaches a signed provenance record (the reason for the
        // change) to the op(s) this push publishes — the ops just committed, or
        // (when nothing new was staged) the already-committed-but-unpublished
        // ops — persisted locally and shipped with the push, so the why is never
        // silently dropped and every clone carries it.
        const message = values.message;
        const provenance: Provenance[] = [];
        const whyTarget =
          ops.length > 0 ? ops : opsAhead(local, cfg.base, view);
        if (
          message !== undefined &&
          message.length > 0 &&
          whyTarget.length > 0
        ) {
          const provLog = new ProvenanceLog(local.store, repoScope(root, cfg));
          for (const op of whyTarget) {
            provenance.push(
              await provLog.record(
                op,
                { intent: message, reasoning: message, actorKind: 'human' },
                identity
              )
            );
          }
        }
        const client = new Client(cfg.server, identity, env.fetchImpl);
        // Give every other member a key to what we publish, before uploading —
        // the bundle carries whatever caps the store holds at build time.
        await reshareToMembers(client, cfg.repo, local, heads, identity);
        const pushed = await client.push(cfg.repo, local, heads, provenance);
        out(
          `uploaded ${pushed.accepted.ops} op(s), ${pushed.accepted.objects} object(s)${
            pushed.accepted.prov > 0 ? `, ${pushed.accepted.prov} why` : ''
          }`
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
        // Ship a merge claim per published op; an attesting host co-signs it.
        const landed = await client.land(
          cfg.repo,
          heads,
          view,
          mergeClaims(cfg.repo, whyTarget, identity)
        );
        if (!landed.landed) {
          out(
            `not landed: ${landed.reason ?? 'blocked by policy'} (content uploaded)`
          );
          return 1;
        }
        const localOps = new Set(local.log.ops().map((o) => o.id));
        const allPresent = landed.heads.every((h) => localOps.has(h));
        if (allPresent) {
          await local.log.repoint(view, landed.heads);
          saveConfig(root, { ...cfg, base: [...landed.heads] });
          out(`published to ${view} (${landed.heads.length} head(s))`);
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
        const view = viewOf(cfg);
        const identity = loadIdentity(env.home);
        const client = new Client(cfg.server, identity, env.fetchImpl);
        const branch = rest.find((a) => !a.startsWith('-'));
        // `land <branch>`: land that branch's ops into the current view, under
        // the server's policy. There is no merge ceremony — landing IS the
        // merge; the ops were signed at commit, this is one governed re-point.
        if (branch !== undefined) {
          if (branch === view) {
            out(`cannot land ${branch} into itself`);
            return 2;
          }
          const backend = new FileBackend(storePath(root, cfg));
          const local = await new Platform().openDurable(cfg.repo, backend);
          const before = await readyToSwitch(
            root,
            local,
            cfg,
            view,
            identity,
            out
          );
          if (before === null) {
            return 2;
          }
          // A typo'd branch would pull as empty and exit "nothing to land" —
          // check it exists so the failure is loud and actionable.
          const views = await client.listViews(cfg.repo);
          if (views[branch] === undefined) {
            out(
              `no branch ${branch} — create it with 'thaddeus branch ${branch}'`
            );
            return 1;
          }
          // Fetch the branch's ops so the landing (and its claims) can be
          // computed locally — creating a branch is free, landing is governed.
          await client.pull(cfg.repo, local, backend, branch);
          const branchHeads = [...local.log.heads(branch)];
          if (branchHeads.length === 0) {
            out(`branch ${branch} has nothing to land`);
            return 0;
          }
          const incoming = opsAhead(local, local.log.heads(view), branch);
          const landed = await client.land(
            cfg.repo,
            branchHeads,
            view,
            mergeClaims(cfg.repo, incoming, identity)
          );
          if (!landed.landed) {
            out(`not landed: ${landed.reason ?? 'blocked by policy'}`);
            return 1;
          }
          const localOps = new Set(local.log.ops().map((o) => o.id));
          if (!landed.heads.every((h) => localOps.has(h))) {
            out('landed, but the remote has changes not in your clone — pull');
            return 0;
          }
          await local.log.repoint(view, landed.heads);
          await retree(root, local, view, identity, before);
          saveConfig(root, { ...cfg, base: [...landed.heads] });
          out(
            `landed ${branch} into ${view} (${incoming.length} op(s), ${landed.heads.length} head(s))`
          );
          return 0;
        }
        const local = await openLocal(root, cfg);
        const heads = [...local.log.heads(view)];
        // Mint a merge claim for each committed-but-unpublished op being landed.
        const claims = mergeClaims(
          cfg.repo,
          opsAhead(local, cfg.base, view),
          identity
        );
        const landed = await client.land(cfg.repo, heads, view, claims);
        if (!landed.landed) {
          out(`not landed: ${landed.reason ?? 'nothing to land'}`);
          return 1;
        }
        const localOps = new Set(local.log.ops().map((o) => o.id));
        const allPresent = landed.heads.every((h) => localOps.has(h));
        if (allPresent) {
          await local.log.repoint(view, landed.heads);
          saveConfig(root, { ...cfg, base: [...landed.heads] });
          out(`landed to ${view} (${landed.heads.length} head(s))`);
        } else {
          out(
            'published, but the remote has changes not in your clone — re-clone to sync'
          );
        }
        return 0;
      }
      case 'rename': {
        const { values, positionals } = parseArgs({
          args: [...rest],
          options: {
            message: { type: 'string', short: 'm' },
            'no-land': { type: 'boolean' },
          },
          allowPositionals: true,
        });
        const [oldName, newName] = positionals;
        if (oldName === undefined || newName === undefined) {
          out('usage: thaddeus rename <old> <new> [-m "<why>"]');
          return 2;
        }
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const view = viewOf(cfg);
        const identity = loadIdentity(env.home);
        const local = await openLocal(root, cfg);
        // Fold any pending disk edits into main first, so the rename operates on
        // the latest committed code.
        await commitDiff(root, local, identity, view);
        // Open a workspace over main and resolve the symbol by its current name.
        const ws = Workspace.open(local.log, local.store, {
          source: view,
          reader: identity,
          name: 'rename',
        });
        const graph = SymbolGraph.over(ws, {
          extractor: new HeuristicExtractor(),
        });
        const symbolId = await graph.resolve(oldName);
        if (symbolId === null) {
          out(`no symbol named ${oldName}`);
          return 1;
        }
        // rename mints one signed SymbolOp + rewrites the text as P03 ops.
        const { symbolOp, ops } = await graph.rename(
          symbolId,
          newName,
          identity
        );
        if (ops.length === 0) {
          out('nothing renamed');
          return 0;
        }
        // Advance local main to the rename commit and write the renamed code to
        // disk so the working tree reflects it.
        const heads = [...local.log.heads('rename')];
        await local.log.repoint(view, heads);
        await materializeToDisk(local, view, identity, root);
        // Persist the SymbolOp locally so `history` reads it offline.
        const symopLog = new SymbolOpLog(repoScope(root, cfg));
        await symopLog.ingest(symbolOp);
        // A `-m "<why>"` attaches a signed provenance record to each rendered op.
        const provenance: Provenance[] = [];
        const message = values.message;
        if (message !== undefined && message.length > 0) {
          const provLog = new ProvenanceLog(local.store, repoScope(root, cfg));
          for (const op of ops) {
            provenance.push(
              await provLog.record(
                op,
                { intent: message, reasoning: message, actorKind: 'human' },
                identity
              )
            );
          }
        }
        const client = new Client(cfg.server, identity, env.fetchImpl);
        // The rewritten files are new objects, sealed to us alone — share them.
        await reshareToMembers(client, cfg.repo, local, heads, identity);
        const pushed = await client.push(cfg.repo, local, heads, provenance, [
          symbolOp,
        ]);
        out(
          `renamed ${oldName} → ${newName} (symbol ${symbolOp.symbol.slice(0, 10)}, ${ops.length} edit(s), ${pushed.accepted.symop} symbol op)`
        );
        if (values['no-land'] === true) {
          out("uploaded (not landed — run 'thaddeus land' to publish)");
          return 0;
        }
        const landed = await client.land(
          cfg.repo,
          heads,
          view,
          mergeClaims(cfg.repo, ops, identity)
        );
        if (!landed.landed) {
          out(
            `not landed: ${landed.reason ?? 'blocked by policy'} (content uploaded)`
          );
          return 1;
        }
        const localOps = new Set(local.log.ops().map((o) => o.id));
        if (landed.heads.every((h) => localOps.has(h))) {
          await local.log.repoint(view, landed.heads);
          saveConfig(root, { ...cfg, base: [...landed.heads] });
          out(`published to ${view} (${landed.heads.length} head(s))`);
        } else {
          out(
            'published, but the remote has changes not in your clone — re-clone to sync'
          );
        }
        return 0;
      }
      case 'history': {
        const arg = rest.find((a) => !a.startsWith('-'));
        if (arg === undefined) {
          out('usage: thaddeus history <symbol>');
          return 2;
        }
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const view = viewOf(cfg);
        const identity = loadIdentity(env.home);
        const local = await openLocal(root, cfg);
        const symopLog = await SymbolOpLog.load(repoScope(root, cfg));
        // Resolve `arg` as a current symbol name (via the graph); fall back to
        // treating it as a raw symbol id (e.g. an old, now-renamed name's id).
        const ws = Workspace.open(local.log, local.store, {
          source: view,
          reader: identity,
          name: 'history',
        });
        const graph = SymbolGraph.over(ws, {
          extractor: new HeuristicExtractor(),
        });
        // Resolve `arg` to a symbol id. A rename changes a symbol's name, so its
        // id (content-addressed from the OLD name) is not recoverable from the
        // current name in a fresh session — cross-peer id convergence is deferred
        // (spec §11). So resolve in three ways: a live symbol NAME, a full symbol
        // id, or an id PREFIX (as `rename` prints), matched against known records.
        let symbolId = await graph.resolve(arg);
        if (symbolId === null) {
          const ids = [...new Set(symopLog.all().map((o) => o.symbol))];
          const matches = ids.filter((id) => id.startsWith(arg));
          if (matches.length > 1) {
            out(`ambiguous symbol prefix ${arg} (${matches.length} matches)`);
            return 2;
          }
          symbolId = matches.length === 1 ? matches[0] : arg;
        }
        const chain = symopLog.forSymbol(symbolId);
        if (wantsJson(rest)) {
          out(
            JSON.stringify({
              symbol: symbolId,
              renames: chain.map((op) => ({
                from: op.from,
                to: op.to,
                verified: symopLog.verify(op),
                author: op.author,
              })),
            })
          );
          return 0;
        }
        if (chain.length === 0) {
          out(`no rename history for ${arg}`);
          return 0;
        }
        for (const op of chain) {
          out(
            `  ${op.from} → ${op.to}  [${symopLog.verify(op) ? 'verified' : 'unverified'}]  by ${op.author}`
          );
        }
        return 0;
      }
      case 'log': {
        const { values } = parseArgs({
          args: [...rest],
          options: {
            since: { type: 'string' },
            until: { type: 'string' },
            json: { type: 'boolean' },
          },
          allowPositionals: true,
        });
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const view = viewOf(cfg);
        const local = await openLocal(root, cfg);
        const provLog = await ProvenanceLog.load(
          local.store,
          repoScope(root, cfg)
        );
        const vetoLog = await VetoLog.load(repoScope(root, cfg));
        // --since/--until filter by the op's signed wall-clock timestamp
        // (op.at), both bounds inclusive. Parse the bounds AND op.at to instants
        // (epoch ms) and compare those — a lexical string compare would misorder
        // a non-UTC offset like `+05:30` against op.at's canonical `…Z` form.
        const sinceMs =
          values.since !== undefined ? Date.parse(values.since) : undefined;
        const untilMs =
          values.until !== undefined ? Date.parse(values.until) : undefined;
        if (sinceMs !== undefined && Number.isNaN(sinceMs)) {
          out(`invalid --since: ${values.since}`);
          return 2;
        }
        if (untilMs !== undefined && Number.isNaN(untilMs)) {
          out(`invalid --until: ${values.until}`);
          return 2;
        }
        const ops = opsOnView(local, view).filter((op) => {
          const t = Date.parse(op.at);
          return (
            (sinceMs === undefined || t >= sinceMs) &&
            (untilMs === undefined || t <= untilMs)
          );
        });
        const isVetoed = (op: Op): boolean =>
          vetoLog.forOp(op.id).some((v) => vetoLog.status(v) === 'verified');
        if (values.json === true) {
          out(
            JSON.stringify(
              ops.map((op) => ({
                id: op.id,
                at: op.at,
                path: op.path,
                author: op.author,
                vetoed: isVetoed(op),
                why: provLog.forOp(op.id).map((p) => ({
                  status: provLog.status(p),
                  actor_kind: p.actor_kind,
                  intent: p.intent,
                })),
              }))
            )
          );
          return 0;
        }
        if (ops.length === 0) {
          out('no history');
          return 0;
        }
        for (const op of ops) {
          const why = provLog.forOp(op.id);
          // A ⛔ marker flags an op under a verified standing veto — the reader
          // sees at a glance which changes a reviewer has blocked.
          out(
            `${op.id.slice(0, 10)}  ${op.at}  ${op.path}${isVetoed(op) ? '  ⛔ vetoed' : ''}`
          );
          out(
            `    ${why.length > 0 ? why.map((p) => p.intent).join('; ') : '(no why)'}`
          );
        }
        return 0;
      }
      case 'why': {
        const prefix = rest.find((a) => !a.startsWith('-'));
        if (prefix === undefined) {
          out('usage: thaddeus why <op>');
          return 2;
        }
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const view = viewOf(cfg);
        const local = await openLocal(root, cfg);
        const provLog = await ProvenanceLog.load(
          local.store,
          repoScope(root, cfg)
        );
        // Resolve a short op-id prefix (as printed by `log`) to a full op.
        const matches = opsOnView(local, view).filter((o) =>
          o.id.startsWith(prefix)
        );
        if (matches.length === 0) {
          out(`no op matching ${prefix}`);
          return 1;
        }
        if (matches.length > 1) {
          out(`ambiguous op prefix ${prefix} (${matches.length} matches)`);
          return 2;
        }
        const op = matches[0];
        const records = provLog.forOp(op.id);
        if (wantsJson(rest)) {
          out(
            JSON.stringify({
              op: { id: op.id, at: op.at, path: op.path, author: op.author },
              records: records.map((p) => ({
                status: provLog.status(p),
                actor_kind: p.actor_kind,
                intent: p.intent,
                reasoning: p.reasoning,
              })),
            })
          );
          return 0;
        }
        out(`op ${op.id.slice(0, 10)}  ${op.at}  ${op.path}  by ${op.author}`);
        if (records.length === 0) {
          out('  (no why recorded)');
          return 0;
        }
        for (const p of records) {
          out(`  [${provLog.status(p)}] ${p.actor_kind}: ${p.intent}`);
          if (p.reasoning.length > 0 && p.reasoning !== p.intent) {
            out(`    reasoning: ${p.reasoning}`);
          }
        }
        return 0;
      }
      case 'veto': {
        const { values, positionals } = parseArgs({
          args: [...rest],
          options: { message: { type: 'string', short: 'm' } },
          allowPositionals: true,
        });
        const prefix = positionals[0];
        if (prefix === undefined) {
          out('usage: thaddeus veto <op> [-m "<reason>"]');
          return 2;
        }
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const view = viewOf(cfg);
        const identity = loadIdentity(env.home);
        const local = await openLocal(root, cfg);
        // Resolve a short op-id prefix (as printed by `log`) to a full op.
        const matches = opsOnView(local, view).filter((o) =>
          o.id.startsWith(prefix)
        );
        if (matches.length === 0) {
          out(`no op matching ${prefix}`);
          return 1;
        }
        if (matches.length > 1) {
          out(`ambiguous op prefix ${prefix} (${matches.length} matches)`);
          return 2;
        }
        const op = matches[0];
        const reason = values.message ?? 'vetoed';
        const veto = signVeto(
          { op: op.id, reason, at: new Date().toISOString() },
          identity
        );
        // Persist locally (so `log`/`vetoes` show it offline) then push a
        // veto-only bundle. A verified veto blocks any subsequent land of the op.
        const vetoLog = new VetoLog(repoScope(root, cfg));
        await vetoLog.ingest(veto);
        const client = new Client(cfg.server, identity, env.fetchImpl);
        const pushed = await client.pushVetoes(cfg.repo, [veto]);
        if (pushed.accepted.veto === 0) {
          out(
            `veto not accepted${
              pushed.rejected.length > 0
                ? `: ${pushed.rejected.map((r) => r.reason).join('; ')}`
                : ''
            }`
          );
          return 1;
        }
        out(`vetoed ${op.id.slice(0, 10)}: ${reason}`);
        return 0;
      }
      case 'vetoes': {
        const prefix = rest.find((a) => !a.startsWith('-'));
        if (prefix === undefined) {
          out('usage: thaddeus vetoes <op>');
          return 2;
        }
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const view = viewOf(cfg);
        const local = await openLocal(root, cfg);
        const vetoLog = await VetoLog.load(repoScope(root, cfg));
        const matches = opsOnView(local, view).filter((o) =>
          o.id.startsWith(prefix)
        );
        if (matches.length === 0) {
          out(`no op matching ${prefix}`);
          return 1;
        }
        if (matches.length > 1) {
          out(`ambiguous op prefix ${prefix} (${matches.length} matches)`);
          return 2;
        }
        const op = matches[0];
        const records = vetoLog.forOp(op.id);
        if (wantsJson(rest)) {
          out(
            JSON.stringify({
              op: { id: op.id, path: op.path },
              vetoes: records.map((v) => ({
                status: vetoLog.status(v),
                reviewer: v.reviewer,
                reason: v.reason,
                at: v.at,
              })),
            })
          );
          return 0;
        }
        if (records.length === 0) {
          out('no vetoes');
          return 0;
        }
        out(`op ${op.id.slice(0, 10)}  ${op.path}`);
        for (const v of records) {
          out(`  [${vetoLog.status(v)}] ${v.reviewer}: ${v.reason}`);
        }
        return 0;
      }
      case 'grant': {
        const { values, positionals } = parseArgs({
          args: [...rest],
          options: {
            paths: { type: 'string' },
            'max-changes': { type: 'string' },
          },
          allowPositionals: true,
        });
        const did = positionals[0];
        if (did === undefined) {
          out('usage: thaddeus grant <did> [--paths a,b] [--max-changes N]');
          return 2;
        }
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const view = viewOf(cfg);
        const identity = loadIdentity(env.home);
        const paths =
          values.paths !== undefined
            ? values.paths
                .split(',')
                .map((p) => p.trim())
                .filter(Boolean)
            : ['**'];
        const maxChanges =
          values['max-changes'] !== undefined
            ? Number(values['max-changes'])
            : 1_000_000;
        if (!Number.isInteger(maxChanges) || maxChanges < 0) {
          out(`invalid --max-changes: ${values['max-changes']}`);
          return 2;
        }
        const delegation = signDelegation(
          { agent: did, paths, maxChanges, maxSpend: 1_000_000 },
          identity
        );
        const client = new Client(cfg.server, identity, env.fetchImpl);
        const g = await client.grant(cfg.repo, delegation);
        out(
          `granted ${g.agent} → ${g.paths.join(', ')} (max ${g.maxChanges} changes)`
        );
        // A delegation conveys WRITE authority only. To actually collaborate the
        // delegate also needs the decryption capability, so re-wrap every object
        // we can read for them and publish the new caps (reusing push). We can
        // only share what this working copy can decrypt — pull first if stale.
        const local = await openLocal(root, cfg);
        const heads = [...local.log.heads(view)];
        const shared = await reshareObjects(
          local,
          reachablePids(local, heads),
          [PublicIdentity.fromDid(did)],
          identity
        );
        if (shared > 0) {
          await client.push(cfg.repo, local, heads);
        }
        out(
          shared > 0
            ? `shared ${shared} object(s) — ${g.agent} can now read this repo`
            : 'nothing to share yet (no landed content this copy can read)'
        );
        return 0;
      }
      case 'revoke': {
        const did = rest[0];
        if (did === undefined) {
          out('usage: thaddeus revoke <did>');
          return 2;
        }
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const identity = loadIdentity(env.home);
        const client = new Client(cfg.server, identity, env.fetchImpl);
        await client.revoke(cfg.repo, did);
        out(`revoked ${did}`);
        return 0;
      }
      case 'grants': {
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const identity = loadIdentity(env.home);
        const client = new Client(cfg.server, identity, env.fetchImpl);
        const grants = await client.listGrants(cfg.repo);
        if (wantsJson(rest)) {
          out(
            JSON.stringify(
              grants.map((g) => ({
                agent: g.agent,
                paths: [...g.paths],
                maxChanges: g.maxChanges,
                maxSpend: g.maxSpend,
              }))
            )
          );
          return 0;
        }
        if (grants.length === 0) {
          out('no grants');
          return 0;
        }
        for (const g of grants) {
          out(
            `${g.agent} → ${g.paths.join(', ')} (max ${g.maxChanges} changes)`
          );
        }
        return 0;
      }
      case 'reputation': {
        // Reputation is SERVER-wide, not repo-scoped, so it resolves the server
        // like `repos`/`delete` (--server, else your default) and needs no
        // working copy — ask any server about any DID from anywhere.
        const { values, positionals } = parseArgs({
          args: [...rest],
          options: {
            server: { type: 'string' },
            // Declared so parseArgs accepts the flag rather than throwing on it;
            // the JSON path below reads it via wantsJson, like every other verb.
            json: { type: 'boolean' },
          },
          allowPositionals: true,
        });
        const did = positionals[0];
        if (did === undefined) {
          out('usage: thaddeus reputation <did> [--server <url>]');
          return 2;
        }
        if (values.server !== undefined && !isServerUrl(values.server)) {
          out(`invalid --server url: ${values.server}`);
          return 2;
        }
        // --server, else the server of the working copy you're standing in,
        // else your saved default.
        let repServer = values.server;
        if (repServer === undefined) {
          const root = findRoot(env.cwd);
          if (root !== undefined) repServer = loadConfig(root).server;
        }
        if (repServer === undefined) {
          const resolved = resolveServer(undefined, [], env.home);
          if (resolved === null) {
            out(noServerHint('reputation'));
            return 2;
          }
          repServer = resolved.server;
        }
        const identity = loadIdentity(env.home);
        const client = new Client(repServer, identity, env.fetchImpl);
        const profile = await client.reputation(did);
        if (wantsJson(rest)) {
          out(JSON.stringify(profile));
          return 0;
        }
        out(profile.subject);
        out(`  attested: ${profile.attested}  claimed: ${profile.claimed}`);
        const kinds = Object.entries(profile.byKind)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}=${n}`)
          .join(', ');
        out(`  by kind: ${kinds.length > 0 ? kinds : '(none)'}`);
        return 0;
      }
      case 'serve': {
        const { values } = parseArgs({
          args: [...rest],
          options: {
            port: { type: 'string' },
            data: { type: 'string' },
            host: { type: 'boolean' },
            'min-merges': { type: 'string' },
          },
          allowPositionals: true,
        });
        const dataDir = values.data ?? join(env.cwd, 'thaddeus-data');
        const port = values.port !== undefined ? Number(values.port) : 4000;
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          out(`invalid --port: ${values.port}`);
          return 2;
        }
        // `--host` makes this an attesting instance, co-signing reputation
        // claims with the operator's own identity; `--min-merges` gates land on
        // that many attested merges per op author.
        const host = values.host === true ? loadIdentity(env.home) : undefined;
        let minMerges: number | undefined;
        if (values['min-merges'] !== undefined) {
          minMerges = Number(values['min-merges']);
          if (!Number.isInteger(minMerges) || minMerges < 0) {
            out(`invalid --min-merges: ${values['min-merges']}`);
            return 2;
          }
        }
        const server = startServer({ dataDir, port, host, minMerges });
        out(
          `thaddeus serving on ${server.url} (data: ${dataDir}${
            host !== undefined ? `, attesting as ${host.did}` : ''
          })`
        );
        process.on('SIGINT', () => {
          server
            .stop()
            .then(() => process.exit(0))
            .catch(() => process.exit(1));
        });
        await new Promise<never>(() => {}); // block until interrupted
        return 0; // unreachable
      }
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
