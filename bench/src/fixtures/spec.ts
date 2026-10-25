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
