import { ready } from '@thaddeus.run/identity';
import { type HeadRecord, signHead } from '@thaddeus.run/log';
import { FileBackend } from '@thaddeus.run/persist';
import { Platform } from '@thaddeus.run/platform';
import { basename } from 'node:path';

import type { BenchCase } from '../case';
import { fixtureDir } from '../fixtures/cache';
import { authorsOf } from '../fixtures/materialize';
import { LIBRARY_FIXTURES, treeBytes, writableCopy } from './common';

// Cold open and repository creation. Each sample is its own process, so the
// timed call starts with nothing loaded; under `pageCache: "dropped"` the
// runner also drops the kernel page cache before each sample.

// Server roots for `open.cold.root-<n>`: the fixture as `bench` plus n - 1
// tiny filler repositories. FileBackend lists by scanning the whole root, so
// the other repositories slow down opening this one.
const ROOT_REPOS = [1, 100, 1_000] as const;

interface ColdState {
  root: string;
}

// Times `Platform.openDurable` of the `bench` repository on a root built by
// `fixtureDir` with `repos` repositories. Setup only finds or builds the
// cached root; the whole open happens inside `run`.
function coldOpen(
  id: string,
  fixtures: readonly string[],
  repos: number,
  opts: { sweep?: boolean } = {}
): BenchCase<ColdState> {
  return {
    id,
    version: 1,
    suite: 'library',
    fixtures,
    isolation: 'per-sample',
    cold: true,
    ...opts,
    setup: async (ctx) => {
      await ready();
      return { root: await fixtureDir(ctx.plan, { repos }) };
    },
    run: async (s) => {
      await new Platform().openDurable('bench', new FileBackend(s.root));
    },
    measure: (s) => Promise.resolve({ diskBytes: treeBytes(s.root) }),
  };
}

export interface CreateState {
  cached: string;
  root: string;
  /** The new repository's name, unique per sample. */
  name: string;
  /** The owner's signed genesis head for `name`'s main, as a client sends it. */
  head: HeadRecord;
}

// Times creating a repository ready to push, as the server's POST /repos does
// it: `Platform.createDurable`, then `headRecords.bootstrap` of the owner's
// signed genesis head (verify, then a durable write of the head record). The
// head is signed in setup, as the client signs it before sending. The
// server-only `meta/repo` record is left to the e2e case. Runs on a copy of
// the fixture root, because FileBackend lists by scanning the whole root.
const repoCreate: BenchCase<CreateState> = {
  id: 'repo.create',
  version: 1,
  suite: 'library',
  fixtures: LIBRARY_FIXTURES,
  isolation: 'per-sample',
  writes: true,
  setup: async (ctx) => {
    const { cached, root } = await writableCopy(ctx);
    const name = `bench-new-${basename(ctx.workDir)}`;
    const head = signHead(
      { repo: name, view: 'main', version: 0, previous: null, heads: [] },
      authorsOf(ctx.plan)[0]
    );
    return { cached, root, name, head };
  },
  run: async (s) => {
    const repo = await new Platform().createDurable(
      s.name,
      new FileBackend(s.root)
    );
    await repo.headRecords.bootstrap(s.head);
  },
  measure: (s) => Promise.resolve({ diskBytes: treeBytes(s.cached) }),
};

const openCases: readonly BenchCase[] = [
  coldOpen('open.cold', LIBRARY_FIXTURES, 1, { sweep: true }),
  ...ROOT_REPOS.map((repos) =>
    coldOpen(`open.cold.root-${repos}`, ['tiny', 'small'], repos)
  ),
  repoCreate,
] as BenchCase[];

export default openCases;
