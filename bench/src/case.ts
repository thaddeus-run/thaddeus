import type { FixturePlan } from './fixtures/plan';

// What a case sees while it runs. `plan` is the fixture plan only: nothing is
// on disk yet, so a case that needs a FileBackend root materializes it in
// `setup`. `workDir` is an empty scratch directory, on the same filesystem as
// the fixture cache so a fixture can be hard-linked into it. The runner
// deletes it after the child exits.
export interface CaseContext {
  plan: FixturePlan;
  fixture: string;
  workDir: string;
  pageCache: 'warm' | 'dropped';
  /** How long a fixed-duration case (e.g. repos per minute) should run. */
  durationMs?: number;
}

// What `run` may report about one timed repeat. The runner sums these over
// the timed repeats and divides by the summed time to get throughput.
export interface RunExtra {
  bytes?: number;
  ops?: number;
  repos?: number;
}

// Adds each numeric field of `extra` into `total`. Used to sum the extras of
// the timed repeats, in the child and again across per-sample children.
export function addExtra(total: RunExtra, extra: void | RunExtra): void {
  if (extra === undefined) return;
  for (const key of ['bytes', 'ops', 'repos'] as const) {
    const value = extra[key];
    if (typeof value === 'number') total[key] = (total[key] ?? 0) + value;
  }
}

// One benchmark. Registry modules default-export `readonly BenchCase[]`; the
// runner imports the registry in both the parent and the child and finds the
// case by `id`. Bump `version` whenever the case measures something different,
// so old results stop being compared with new ones.
export interface BenchCase<S = unknown> {
  id: string;
  version: number;
  suite: 'library' | 'e2e';
  fixtures: readonly string[];
  /**
   * `per-case`: one child runs setup once, then the warm-ups, then every timed
   * repeat. `per-sample`: one child per warm-up and per timed repeat, so each
   * sample starts from a fresh process (and, for cold cases, a dropped cache).
   */
  isolation: 'per-case' | 'per-sample';
  /** The case writes through FileBackend, so results carry its durability. */
  writes?: boolean;
  /** The case opens a store from disk, so results record the page-cache mode. */
  cold?: boolean;
  /** The case takes part in the history-length sweep. */
  sweep?: boolean;
  setup(ctx: CaseContext): Promise<S>;
  run(state: S, ctx: CaseContext): Promise<void | RunExtra>;
  /**
   * Called once per child, after the timed repeats and before teardown, for
   * sizes that are not timings (e.g. the fixture root's bytes on disk).
   */
  measure?(state: S, ctx: CaseContext): Promise<{ diskBytes?: number }>;
  teardown?(state: S, ctx: CaseContext): Promise<void>;
}

// Imports a registry module and returns the case with `id`. Throws when the
// id is unknown, because that is a bug in the caller rather than a result.
export async function loadCase(
  registry: string,
  id: string
): Promise<BenchCase> {
  const mod = (await import(registry)) as { default: readonly BenchCase[] };
  const found = mod.default.find((c) => c.id === id);
  if (found === undefined) {
    throw new Error(`no case ${id} in registry ${registry}`);
  }
  return found;
}
