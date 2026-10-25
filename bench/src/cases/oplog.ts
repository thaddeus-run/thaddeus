import type { Identity } from '@thaddeus.run/identity';
import { type Op, signOp } from '@thaddeus.run/log';
import type { Repo } from '@thaddeus.run/platform';
import { encrypt, newContentKey } from '@thaddeus.run/store';

import type { BenchCase, CaseContext } from '../case';
import { authorsOf } from '../fixtures/materialize';
import {
  LIBRARY_FIXTURES,
  newFileAt,
  newFileContent,
  newFilePath,
  openCached,
  type OpenFixture,
  openWritable,
  OPS_PER_SAMPLE,
  treeBytes,
} from './common';

// Op-log cases: durable write and ingest throughput, and the read paths
// THA-21 will change (materialize, heads, conflicts), on main after the
// fixture's lands and on the global frontier (no view).

// Signed ops prepared in setup for `oplog.ingest`, sized like the store's
// ingest pool. A longer run cycles through them again.
const INGEST_POOL = OPS_PER_SAMPLE * 24;

interface WriteState {
  cached: string;
  repo: Repo;
  owner: Identity;
  next: number;
}

// Times `OpLog.write` on main: store put, sign, and the op and view records
// written through to FileBackend.
const oplogWrite: BenchCase<WriteState> = {
  id: 'oplog.write',
  version: 1,
  suite: 'library',
  fixtures: LIBRARY_FIXTURES,
  isolation: 'per-case',
  writes: true,
  sweep: true,
  setup: async (ctx) => {
    const { cached, repo } = await openWritable(ctx);
    return { cached, repo, owner: authorsOf(ctx.plan)[0], next: 0 };
  },
  run: async (s) => {
    for (let i = 0; i < OPS_PER_SAMPLE; i++) {
      const k = s.next++;
      await s.repo.log.write(
        'main',
        newFilePath(k),
        newFileContent(k),
        s.owner,
        { at: newFileAt(k) }
      );
    }
    return { ops: OPS_PER_SAMPLE };
  },
  measure: (s) => Promise.resolve({ diskBytes: treeBytes(s.cached) }),
};

interface IngestState {
  cached: string;
  repo: Repo;
  pool: Op[];
  next: number;
}

// A chain of `count` signed ops by `author` extending main's heads, each one
// writing a new file. The payload refs come from encrypting the file, as a
// client would before pushing; the store never sees them, because
// `OpLog.ingest` does not read payloads.
function signedChain(repo: Repo, author: Identity, count: number): Op[] {
  const heads = repo.log.heads('main');
  const lamports = repo.log
    .ops()
    .filter((op) => heads.includes(op.id))
    .map((op) => op.lamport);
  let parents: readonly string[] = heads;
  let lamport = lamports.length === 0 ? 0 : Math.max(...lamports) + 1;
  const chain: Op[] = [];
  for (let k = 0; k < count; k++) {
    const object = encrypt(newFileContent(k), newContentKey());
    const op = signOp(
      {
        path: newFilePath(k),
        parents,
        lamport: lamport++,
        at: newFileAt(k),
        payload: { id: object.id, plaintext_id: object.plaintext_id },
      },
      author
    );
    chain.push(op);
    parents = [op.id];
  }
  return chain;
}

// Times `OpLog.ingest`, the server's path for a pushed op: verify the
// signature and id, write the op record through, add it to the DAG.
const oplogIngest: BenchCase<IngestState> = {
  id: 'oplog.ingest',
  version: 1,
  suite: 'library',
  fixtures: LIBRARY_FIXTURES,
  isolation: 'per-case',
  writes: true,
  setup: async (ctx) => {
    const { cached, repo } = await openWritable(ctx);
    const pool = signedChain(repo, authorsOf(ctx.plan)[0], INGEST_POOL);
    return { cached, repo, pool, next: 0 };
  },
  run: async (s) => {
    for (let i = 0; i < OPS_PER_SAMPLE; i++) {
      await s.repo.log.ingest(s.pool[s.next++ % s.pool.length]);
    }
    return { ops: OPS_PER_SAMPLE };
  },
  measure: (s) => Promise.resolve({ diskBytes: treeBytes(s.cached) }),
};

// A read-only case that opens the cached fixture once and times one call on
// its op-log per repeat.
function readCase(
  id: string,
  call: (repo: Repo) => unknown,
  opts: { sweep?: boolean } = {}
): BenchCase<OpenFixture> {
  return {
    id,
    version: 1,
    suite: 'library',
    fixtures: LIBRARY_FIXTURES,
    isolation: 'per-case',
    ...opts,
    setup: (ctx: CaseContext) => openCached(ctx),
    run: (s) => {
      call(s.repo);
      return Promise.resolve();
    },
    measure: (s) => Promise.resolve({ diskBytes: treeBytes(s.root) }),
  };
}

const oplogCases: readonly BenchCase[] = [
  oplogWrite,
  oplogIngest,
  readCase('oplog.materialize.main', (repo) => repo.log.materialize('main')),
  readCase('oplog.materialize.frontier', (repo) => repo.log.materialize(), {
    sweep: true,
  }),
  readCase('oplog.heads.frontier', (repo) => repo.log.heads()),
  readCase('oplog.conflicts.main', (repo) => repo.log.conflicts('main')),
  readCase('oplog.conflicts.frontier', (repo) => repo.log.conflicts(), {
    sweep: true,
  }),
] as BenchCase[];

export default oplogCases;
