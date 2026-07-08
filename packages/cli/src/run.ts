import { signDelegation } from '@thaddeus.run/agent';
import { Client } from '@thaddeus.run/client';
import { Workspace } from '@thaddeus.run/fs';
import {
  HeuristicExtractor,
  SymbolGraph,
  SymbolOpLog,
} from '@thaddeus.run/graph';
import type { Identity } from '@thaddeus.run/identity';
import type { Op } from '@thaddeus.run/log';
import { FileBackend } from '@thaddeus.run/persist';
import { Platform, type Repo } from '@thaddeus.run/platform';
import { type Provenance, ProvenanceLog } from '@thaddeus.run/provenance';
import { type ContributionClaim, signClaim } from '@thaddeus.run/reputation';
import { signVeto, VetoLog } from '@thaddeus.run/review';
import { type Backend, scoped } from '@thaddeus.run/store';
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
  push   [-m "<why>"] [--no-land]  commit + upload (+ a signed why) + land
  log                              show main's history with the why per change
  why    <op>                      show the signed why for one op
  veto   <op> [-m "<reason>"]      lodge a standing veto that blocks a land
  vetoes <op>                      list the standing vetoes on one op
  rename <old> <new> [-m "<why>"]  rename a symbol as one signed SymbolOp
  history <symbol>                 show a symbol's signed rename chain
  land                             land uploaded-but-unmerged commits
  grant  <did> [--paths a,b] [--max-changes N]    grant push to a DID/agent
  revoke <did>                                     revoke a grant
  grants                                           list active grants
  reputation <did>                                 show a DID's server-wide reputation
  serve  [--port 4000] [--data ./dir] [--host] [--min-merges N]   run a server`;

// Re-open the local durable repo for a working copy at `root`.
async function openLocal(root: string, repoName: string): Promise<Repo> {
  return new Platform().openDurable(
    repoName,
    new FileBackend(join(root, '.thaddeus', 'store'))
  );
}

// The working copy's per-repo backend scope — the same `repo/<name>/` namespace
// openDurable uses — so a ProvenanceLog reads/writes the "why" alongside the code.
function repoScope(root: string, repoName: string): Backend {
  return scoped(
    new FileBackend(join(root, '.thaddeus', 'store')),
    `repo/${repoName}/`
  );
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
function opsAhead(repo: Repo, base: readonly string[]): Op[] {
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
  return opsOnView(repo, 'main').filter((o) => !baseClosure.has(o.id));
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
  identity: Identity
): Promise<{ heads: string[]; committed: boolean; ops: readonly Op[] }> {
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
    return { heads: [...repo.log.heads('main')], committed: false, ops: [] };
  }
  const heads = [...repo.log.heads('staging')];
  await repo.log.repoint('main', heads);
  return { heads, committed: true, ops };
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
        const identity = loadIdentity(env.home);
        const local = await openLocal(root, cfg.repo);
        const { heads, committed, ops } = await commitDiff(
          root,
          local,
          identity
        );
        const ahead = headsAhead(local, cfg.base);
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
        const whyTarget = ops.length > 0 ? ops : opsAhead(local, cfg.base);
        if (
          message !== undefined &&
          message.length > 0 &&
          whyTarget.length > 0
        ) {
          const provLog = new ProvenanceLog(
            local.store,
            repoScope(root, cfg.repo)
          );
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
          'main',
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
        // Mint a merge claim for each committed-but-unpublished op being landed.
        const claims = mergeClaims(
          cfg.repo,
          opsAhead(local, cfg.base),
          identity
        );
        const landed = await client.land(cfg.repo, heads, 'main', claims);
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
        const identity = loadIdentity(env.home);
        const local = await openLocal(root, cfg.repo);
        // Fold any pending disk edits into main first, so the rename operates on
        // the latest committed code.
        await commitDiff(root, local, identity);
        // Open a workspace over main and resolve the symbol by its current name.
        const ws = Workspace.open(local.log, local.store, {
          source: 'main',
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
        await local.log.repoint('main', heads);
        await materializeToDisk(local, 'main', identity, root);
        // Persist the SymbolOp locally so `history` reads it offline.
        const symopLog = new SymbolOpLog(repoScope(root, cfg.repo));
        await symopLog.ingest(symbolOp);
        // A `-m "<why>"` attaches a signed provenance record to each rendered op.
        const provenance: Provenance[] = [];
        const message = values.message;
        if (message !== undefined && message.length > 0) {
          const provLog = new ProvenanceLog(
            local.store,
            repoScope(root, cfg.repo)
          );
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
          'main',
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
      case 'history': {
        const arg = rest[0];
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
        const identity = loadIdentity(env.home);
        const local = await openLocal(root, cfg.repo);
        const symopLog = await SymbolOpLog.load(repoScope(root, cfg.repo));
        // Resolve `arg` as a current symbol name (via the graph); fall back to
        // treating it as a raw symbol id (e.g. an old, now-renamed name's id).
        const ws = Workspace.open(local.log, local.store, {
          source: 'main',
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
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const local = await openLocal(root, cfg.repo);
        const provLog = await ProvenanceLog.load(
          local.store,
          repoScope(root, cfg.repo)
        );
        const vetoLog = await VetoLog.load(repoScope(root, cfg.repo));
        const ops = opsOnView(local, 'main');
        if (ops.length === 0) {
          out('no history');
          return 0;
        }
        for (const op of ops) {
          const why = provLog.forOp(op.id);
          // A ⛔ marker flags an op under a verified standing veto — the reader
          // sees at a glance which changes a reviewer has blocked.
          const vetoed = vetoLog
            .forOp(op.id)
            .some((v) => vetoLog.status(v) === 'verified');
          out(
            `${op.id.slice(0, 10)}  ${op.at}  ${op.path}${vetoed ? '  ⛔ vetoed' : ''}`
          );
          out(
            `    ${why.length > 0 ? why.map((p) => p.intent).join('; ') : '(no why)'}`
          );
        }
        return 0;
      }
      case 'why': {
        const prefix = rest[0];
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
        const local = await openLocal(root, cfg.repo);
        const provLog = await ProvenanceLog.load(
          local.store,
          repoScope(root, cfg.repo)
        );
        // Resolve a short op-id prefix (as printed by `log`) to a full op.
        const matches = opsOnView(local, 'main').filter((o) =>
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
        out(`op ${op.id.slice(0, 10)}  ${op.at}  ${op.path}  by ${op.author}`);
        const records = provLog.forOp(op.id);
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
        const identity = loadIdentity(env.home);
        const local = await openLocal(root, cfg.repo);
        // Resolve a short op-id prefix (as printed by `log`) to a full op.
        const matches = opsOnView(local, 'main').filter((o) =>
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
        const vetoLog = new VetoLog(repoScope(root, cfg.repo));
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
        const prefix = rest[0];
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
        const local = await openLocal(root, cfg.repo);
        const vetoLog = await VetoLog.load(repoScope(root, cfg.repo));
        const matches = opsOnView(local, 'main').filter((o) =>
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
        const did = rest[0];
        if (did === undefined) {
          out('usage: thaddeus reputation <did>');
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
        const profile = await client.reputation(did);
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
