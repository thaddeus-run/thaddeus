import { Workspace } from '@thaddeus.run/fs';
import { HeuristicExtractor, SymbolGraph } from '@thaddeus.run/graph';
import { ready } from '@thaddeus.run/identity';
import { FileBackend } from '@thaddeus.run/persist';
import { Platform, type Repo } from '@thaddeus.run/platform';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import { CodeDB } from '@thaddeus.run/query';

import type { BenchCase } from '../case';
import { fixtureDir } from '../fixtures/cache';
import { authorsOf } from '../fixtures/materialize';
import type { FixturePlan } from '../fixtures/plan';
import { LIBRARY_FIXTURES, treeBytes } from './common';

// Coarse query and graph cases: one call of the symbol graph or of CodeDB over
// the whole fixture per timed repeat. Neither layer caches, so every call
// re-reads and re-extracts every decryptable file; these cases measure that
// full re-derive, not a lookup. They are read-only, so they open the cached
// fixture root directly.

// What a query case needs, and the targets it queries. The targets come from
// the plan alone, so every run on the same plan asks the same questions.
export interface QueryState {
  root: string;
  repo: Repo;
  graph: SymbolGraph;
  codedb: CodeDB;
  /** Name and id of the first visible file's first symbol, falling back past hot files the owner cannot read. */
  symbolName: string;
  symbolId: string;
  /** The op in the middle of the log's (lamport, id) order. */
  medianOpId: string;
  /** The `at` of the op 90% of the way through the history. */
  touchedSince: string;
}

// Opens the fixture's `bench` repository from the cache and stacks the layers
// the query cases use: a Workspace on main read as the owner, a SymbolGraph
// over it with the heuristic extractor, and a CodeDB over both plus an empty
// provenance log. The reader is the owner, so files whose last writer was
// another author do not decrypt and the graph skips them; on the one-author
// fixtures that is nothing.
export async function openQueryState(plan: FixturePlan): Promise<QueryState> {
  await ready();
  const root = await fixtureDir(plan);
  const repo = await new Platform().openDurable('bench', new FileBackend(root));
  const owner = authorsOf(plan)[0];
  const workspace = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: owner,
  });
  const graph = SymbolGraph.over(workspace, {
    extractor: new HeuristicExtractor(),
  });
  const codedb = CodeDB.over({
    graph,
    log: repo.log,
    provenance: new ProvenanceLog(repo.store),
  });

  const ops = repo.log.ops();
  const medianOpId = ops[Math.floor(ops.length / 2)].id;
  const history = plan.steps.filter(
    (s) => s.kind === 'write' || s.kind === 'remove'
  );
  const touchedSince = history[Math.floor(history.length * 0.9)].at;
  const target = await firstVisibleSymbol(plan, graph);
  return { root, repo, graph, codedb, ...target, medianOpId, touchedSince };
}

// The first symbol of the first file the graph can see. The plan's hot files
// come first in path order and take most writes, so the walk starts on the
// first hot file. The generator defines `f_<n>_0` first in file n. A file may
// be missing from main or written by another author (so the owner cannot read
// it), which is why the walk can go on past the hot files: tiny has one hot
// file and it belongs to the second author.
async function firstVisibleSymbol(
  plan: FixturePlan,
  graph: SymbolGraph
): Promise<{ symbolName: string; symbolId: string }> {
  for (let n = 0; n < plan.spec.files; n++) {
    const symbolName = `f_${n}_0`;
    const symbolId = await graph.resolveAt(`src/f${n}.ts`, symbolName);
    if (symbolId !== null) return { symbolName, symbolId };
  }
  throw new Error(`no file of ${plan.spec.name} defines a visible symbol`);
}

// A read-only query case: setup opens the state once, and each repeat makes one
// call.
function queryCase(
  id: string,
  call: (s: QueryState) => unknown
): BenchCase<QueryState> {
  return {
    id,
    version: 1,
    suite: 'library',
    fixtures: LIBRARY_FIXTURES,
    isolation: 'per-case',
    setup: (ctx) => openQueryState(ctx.plan),
    run: async (s) => {
      await call(s);
    },
    measure: (s) => Promise.resolve({ diskBytes: treeBytes(s.root) }),
  };
}

const queryCases: readonly BenchCase[] = [
  queryCase('graph.resolve', (s) => s.graph.resolve(s.symbolName)),
  queryCase('graph.callersOf', (s) => s.graph.callersOf(s.symbolId)),
  queryCase('codedb.why', (s) => s.codedb.why(s.medianOpId)),
  queryCase('codedb.touchedSince', (s) =>
    s.codedb.touchedSince(s.touchedSince)
  ),
  queryCase('codedb.callers', (s) => s.codedb.callers(s.symbolId)),
] as BenchCase[];

export default queryCases;
