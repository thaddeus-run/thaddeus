export type FixtureName = 'small' | 'medium' | 'stress';

// The shape of a generated history. Every field feeds the plan, so changing
// any of them changes the manifest hash.
export interface FixtureSpec {
  name: string;
  seed: number;
  files: number;
  ops: number;
  authors: number;
  views: number;
  /** A view lands into main after every this many ops. */
  landEvery: number;
  /** Share of ops that remove a file instead of writing one. */
  removeRatio: number;
  /** Share of paths (from the start of the path list) that take most writes. */
  hotFileShare: number;
  /**
   * `serial`: the conflict-free plan shape of `serialSpec`. Absent for the
   * base shape, so base specs (and their manifest hashes) are unchanged.
   */
  variant?: 'serial';
}

export const FIXTURES: Record<FixtureName, FixtureSpec> = {
  small: {
    name: 'small',
    seed: 1,
    files: 100,
    ops: 1_000,
    authors: 1,
    views: 1,
    landEvery: 100,
    removeRatio: 0.05,
    hotFileShare: 0.1,
  },
  medium: {
    name: 'medium',
    seed: 2,
    files: 2_000,
    ops: 20_000,
    authors: 10,
    views: 50,
    landEvery: 400,
    removeRatio: 0.05,
    hotFileShare: 0.1,
  },
  stress: {
    name: 'stress',
    seed: 3,
    files: 20_000,
    ops: 200_000,
    authors: 100,
    views: 500,
    landEvery: 400,
    removeRatio: 0.05,
    hotFileShare: 0.1,
  },
};

// One point of the history-length sweep: fixed repo shape, `ops` varies.
export function sweepSpec(ops: number): FixtureSpec {
  return {
    name: `sweep-${ops}`,
    seed: 4,
    files: 100,
    ops,
    authors: 4,
    views: 8,
    landEvery: 100,
    removeRatio: 0.05,
    hotFileShare: 0.1,
  };
}

// A minimal fixture for tests and for filler repositories.
export function tinySpec(): FixtureSpec {
  return {
    name: 'tiny',
    seed: 5,
    files: 10,
    ops: 20,
    authors: 2,
    views: 2,
    landEvery: 5,
    removeRatio: 0.05,
    hotFileShare: 0.1,
  };
}

// The conflict-free variant of `spec`, named `<name>-serial`: same files,
// ops, authors, views and land interval, but each view forks from the
// current main and lands before the next one forks (see `serialSteps` in
// plan.ts). The end-to-end suite runs on it, because the shipped server
// refuses every land into a main that holds a conflict. The name keeps its
// results apart from the base fixture's.
export function serialSpec(spec: FixtureSpec): FixtureSpec {
  return { ...spec, name: `${spec.name}-serial`, variant: 'serial' };
}

// Maps a fixture name, as stored in results and passed to the runner, back to
// its spec: `small`, `medium`, `stress`, `tiny` or `sweep-<ops>`, each also
// as `<name>-serial`. Throws on any other name so a typo fails loudly
// instead of measuring the wrong input.
export function resolveFixture(name: string): FixtureSpec {
  const serial = /^(.+)-serial$/.exec(name);
  if (serial !== null) {
    let base: FixtureSpec | undefined;
    try {
      base = resolveFixture(serial[1]);
    } catch {
      // Reported below under the full name.
    }
    if (base === undefined || base.variant !== undefined) {
      throw new Error(`unknown fixture ${name}`);
    }
    return serialSpec(base);
  }
  if (Object.hasOwn(FIXTURES, name)) return FIXTURES[name as FixtureName];
  if (name === 'tiny') return tinySpec();
  const sweep = /^sweep-([1-9]\d*)$/.exec(name);
  if (sweep !== null) return sweepSpec(Number(sweep[1]));
  throw new Error(`unknown fixture ${name}`);
}
