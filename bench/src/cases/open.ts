import { ready } from '@thaddeus.run/identity';
import { FileBackend } from '@thaddeus.run/persist';
import { Platform } from '@thaddeus.run/platform';

import type { BenchCase } from '../case';
import { fixtureDir } from '../fixtures/cache';
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

interface CreateState {
  cached: string;
  root: string;
}

// Times `Platform.createDurable` of a new repository on a copy of the fixture
// root, the library half of "repository creation, ready to push".
const repoCreate: BenchCase<CreateState> = {
  id: 'repo.create',
  version: 1,
  suite: 'library',
  fixtures: LIBRARY_FIXTURES,
  isolation: 'per-sample',
  writes: true,
  setup: (ctx) => writableCopy(ctx),
  run: async (s) => {
    await new Platform().createDurable('bench-new', new FileBackend(s.root));
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
