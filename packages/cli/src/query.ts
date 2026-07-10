import { Workspace } from '@thaddeus.run/fs';
import { HeuristicExtractor, SymbolGraph } from '@thaddeus.run/graph';
import type { Op } from '@thaddeus.run/log';
import { FileBackend } from '@thaddeus.run/persist';
import { Platform, type Repo } from '@thaddeus.run/platform';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import { CodeDB } from '@thaddeus.run/query';
import { type Backend, scoped } from '@thaddeus.run/store';
import { parseArgs } from 'node:util';

import { loadIdentity } from './identity';
import type { CliEnv } from './run';
import {
  type Config,
  findRoot,
  loadConfig,
  storePath,
  viewOf,
} from './workcopy';

interface QueryContext {
  readonly db: CodeDB;
  readonly graph: SymbolGraph;
  readonly provenance: ProvenanceLog;
  readonly ops: readonly Op[];
  readonly reachable: ReadonlySet<string>;
}

interface QueryOp {
  readonly id: string;
  readonly path: string;
  readonly at: string;
  readonly author: string;
  readonly lamport: number;
  readonly kind: 'write' | 'delete';
}

const QUERY_USAGE =
  'usage: thaddeus query <why|touched-since|by|callers|references> ...';

// The working copy's durable metadata shares the same per-repo namespace as
// Platform.openDurable, so query can join code, history, and provenance offline.
function repoScope(root: string, cfg: Config): Backend {
  return scoped(new FileBackend(storePath(root, cfg)), `repo/${cfg.repo}/`);
}

async function openLocal(root: string, cfg: Config): Promise<Repo> {
  return new Platform().openDurable(
    cfg.repo,
    new FileBackend(storePath(root, cfg))
  );
}

// Return only ops reachable from the current branch, newest-first. A working
// copy can cache other branches and inspect views in the same durable log; they
// must not leak into a query whose scope is the branch the user is standing on.
function opsOnView(repo: Repo, view: string): Op[] {
  const all = repo.log.ops();
  const byId = new Map(all.map((op) => [op.id, op]));
  const seen = new Set<string>();
  const stack = [...repo.log.heads(view)];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const op = byId.get(id);
    if (op !== undefined) {
      stack.push(...op.parents);
    }
  }
  return all
    .filter((op) => seen.has(op.id))
    .sort((a, b) =>
      a.lamport !== b.lamport ? b.lamport - a.lamport : a.id < b.id ? 1 : -1
    );
}

// Build the live CodeDB over the current committed view. Workspace.open forks
// only an in-memory view in this short-lived process: it never persists, pulls,
// commits, or overlays dirty files from disk.
async function openQueryContext(
  env: CliEnv,
  out: (line: string) => void
): Promise<QueryContext | null> {
  const root = findRoot(env.cwd);
  if (root === undefined) {
    out("not a thaddeus working copy — run 'thaddeus clone' first");
    return null;
  }
  const cfg = loadConfig(root);
  const view = viewOf(cfg);
  const identity = loadIdentity(env.home);
  const local = await openLocal(root, cfg);
  const provenance = await ProvenanceLog.load(
    local.store,
    repoScope(root, cfg)
  );
  const workspace = Workspace.open(local.log, local.store, {
    source: view,
    reader: identity,
    name: 'query',
  });
  const graph = SymbolGraph.over(workspace, {
    extractor: new HeuristicExtractor(),
  });
  const ops = opsOnView(local, view);
  return {
    db: CodeDB.over({ graph, log: local.log, provenance }),
    graph,
    provenance,
    ops,
    reachable: new Set(ops.map((op) => op.id)),
  };
}

function queryOp(op: Op): QueryOp {
  return {
    id: op.id,
    path: op.path,
    at: op.at,
    author: op.author,
    lamport: op.lamport,
    kind: op.payload === null ? 'delete' : 'write',
  };
}

function outputOps(
  ops: readonly Op[],
  json: boolean,
  out: (line: string) => void
): void {
  if (json) {
    out(JSON.stringify(ops.map(queryOp)));
    return;
  }
  if (ops.length === 0) {
    out('no matches');
    return;
  }
  for (const op of ops) {
    out(
      `${op.id.slice(0, 10)}  ${op.at}  ${op.path}  by ${op.author}${
        op.payload === null ? '  (delete)' : ''
      }`
    );
  }
}

function parseInstant(
  label: string,
  value: string | undefined,
  out: (line: string) => void
): value is string | undefined {
  if (value !== undefined && Number.isNaN(Date.parse(value))) {
    out(`invalid ${label}: ${value}`);
    return false;
  }
  return true;
}

function scopedNewest(context: QueryContext, ops: readonly Op[]): Op[] {
  const rank = new Map(context.ops.map((op, index) => [op.id, index]));
  return ops
    .filter((op) => context.reachable.has(op.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

async function whyQuery(
  args: readonly string[],
  env: CliEnv,
  out: (line: string) => void
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { json: { type: 'boolean' } },
    allowPositionals: true,
  });
  const prefix = positionals[0];
  if (prefix === undefined || positionals.length !== 1) {
    out('usage: thaddeus query why <op> [--json]');
    return 2;
  }
  const context = await openQueryContext(env, out);
  if (context === null) {
    return 2;
  }
  const matches = context.ops.filter((op) => op.id.startsWith(prefix));
  if (matches.length === 0) {
    out(`no op matching ${prefix}`);
    return 1;
  }
  if (matches.length > 1) {
    out(`ambiguous op prefix ${prefix} (${matches.length} matches)`);
    return 2;
  }
  const answer = context.db.why(matches[0].id);
  const op = answer.op;
  if (op === null) {
    out(`no op matching ${prefix}`);
    return 1;
  }
  const records = answer.why.map((record) => ({
    status: context.provenance.status(record),
    actor: record.actor,
    actor_kind: record.actor_kind,
    intent: record.intent,
    reasoning: record.reasoning,
    task: record.task,
  }));
  if (values.json === true) {
    out(
      JSON.stringify({
        op: queryOp(op),
        verified: answer.verified,
        records,
      })
    );
    return 0;
  }
  out(`op ${op.id.slice(0, 10)}  ${op.at}  ${op.path}  by ${op.author}`);
  if (records.length === 0) {
    out('  (no why recorded)');
    return 0;
  }
  for (const record of records) {
    out(`  [${record.status}] ${record.actor_kind}: ${record.intent}`);
    if (record.reasoning.length > 0 && record.reasoning !== record.intent) {
      out(`    reasoning: ${record.reasoning}`);
    }
    if (record.task !== null) {
      out(`    task: ${record.task}`);
    }
  }
  return 0;
}

async function touchedSinceQuery(
  args: readonly string[],
  env: CliEnv,
  out: (line: string) => void
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { json: { type: 'boolean' } },
    allowPositionals: true,
  });
  const at = positionals[0];
  if (at === undefined || positionals.length !== 1) {
    out('usage: thaddeus query touched-since <ISO> [--json]');
    return 2;
  }
  if (!parseInstant('timestamp', at, out)) {
    return 2;
  }
  const context = await openQueryContext(env, out);
  if (context === null) {
    return 2;
  }
  outputOps(
    scopedNewest(context, context.db.touchedSince(at)),
    values.json === true,
    out
  );
  return 0;
}

async function byQuery(
  args: readonly string[],
  env: CliEnv,
  out: (line: string) => void
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const did = positionals[0];
  if (did === undefined || positionals.length !== 1) {
    out(
      'usage: thaddeus query by <did> [--since <ISO>] [--until <ISO>] [--json]'
    );
    return 2;
  }
  if (
    !parseInstant('--since', values.since, out) ||
    !parseInstant('--until', values.until, out)
  ) {
    return 2;
  }
  const context = await openQueryContext(env, out);
  if (context === null) {
    return 2;
  }
  const matches = context.db.by(did, {
    from: values.since,
    to: values.until,
  });
  outputOps(scopedNewest(context, matches), values.json === true, out);
  return 0;
}

// Resolve a live symbol by current name first, then by full id or a unique id
// prefix. This mirrors `history` and lets callers consume ids printed as JSON.
async function resolveSymbol(
  graph: SymbolGraph,
  value: string,
  out: (line: string) => void
): Promise<{ id: string } | { code: number }> {
  const named = await graph.resolve(value);
  if (named !== null) {
    return { id: named };
  }
  const matches = (await graph.symbols()).filter((symbol) =>
    symbol.id.startsWith(value)
  );
  if (matches.length === 0) {
    out(`no symbol matching ${value}`);
    return { code: 1 };
  }
  if (matches.length > 1) {
    out(`ambiguous symbol prefix ${value} (${matches.length} matches)`);
    return { code: 2 };
  }
  return { id: matches[0].id };
}

async function callersQuery(
  args: readonly string[],
  env: CliEnv,
  out: (line: string) => void
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { json: { type: 'boolean' } },
    allowPositionals: true,
  });
  const value = positionals[0];
  if (value === undefined || positionals.length !== 1) {
    out('usage: thaddeus query callers <symbol> [--json]');
    return 2;
  }
  const context = await openQueryContext(env, out);
  if (context === null) {
    return 2;
  }
  const resolved = await resolveSymbol(context.graph, value, out);
  if ('code' in resolved) {
    return resolved.code;
  }
  const callers = await context.db.callers(resolved.id);
  if (values.json === true) {
    out(JSON.stringify(callers));
    return 0;
  }
  if (callers.length === 0) {
    out('no callers');
    return 0;
  }
  for (const caller of callers) {
    const definition = caller.definition;
    out(
      definition === null
        ? `${caller.symbol.id.slice(0, 10)}  [${caller.symbol.kind}]  (definition unavailable)`
        : `${definition.name}  ${definition.path}:${definition.line}  [${caller.symbol.kind}]  ${caller.symbol.id.slice(0, 10)}`
    );
  }
  return 0;
}

async function referencesQuery(
  args: readonly string[],
  env: CliEnv,
  out: (line: string) => void
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { json: { type: 'boolean' } },
    allowPositionals: true,
  });
  const name = positionals[0];
  if (name === undefined || positionals.length !== 1) {
    out('usage: thaddeus query references <name> [--json]');
    return 2;
  }
  const context = await openQueryContext(env, out);
  if (context === null) {
    return 2;
  }
  if ((await context.graph.resolve(name)) === null) {
    out(`no symbol named ${name}`);
    return 1;
  }
  const references = await context.db.references(name);
  if (values.json === true) {
    out(JSON.stringify(references));
    return 0;
  }
  if (references.length === 0) {
    out('no references');
    return 0;
  }
  for (const reference of references) {
    out(`${reference.path}:${reference.line}`);
  }
  return 0;
}

// Execute one query subcommand. Every branch is read-only and works from the
// local durable clone without a server round trip.
export async function runQuery(
  args: readonly string[],
  env: CliEnv,
  out: (line: string) => void
): Promise<number> {
  const [query, ...rest] = args;
  switch (query) {
    case 'why':
      return whyQuery(rest, env, out);
    case 'touched-since':
      return touchedSinceQuery(rest, env, out);
    case 'by':
      return byQuery(rest, env, out);
    case 'callers':
      return callersQuery(rest, env, out);
    case 'references':
      return referencesQuery(rest, env, out);
    default:
      out(QUERY_USAGE);
      return 2;
  }
}
