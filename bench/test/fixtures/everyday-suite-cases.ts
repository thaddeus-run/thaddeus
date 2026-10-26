import type { BenchCase } from '../../src/case';

// Fast fake everyday cases that declare what they need pre-built: a git
// repository, a fixture root, or nothing beyond the defaults. The suite
// builder tests use them to check which caches a run builds, without
// running git or the CLI.
const everydaySuiteCases: readonly BenchCase[] = [
  {
    id: 'git.fake',
    version: 1,
    suite: 'everyday',
    fixtures: ['tiny'],
    variant: 'serial',
    isolation: 'per-case',
    needs: ['git'],
    setup: () => Promise.resolve(),
    run: () => Promise.resolve(),
  },
  {
    id: 'wc.fake',
    version: 1,
    suite: 'everyday',
    fixtures: ['tiny'],
    variant: 'serial',
    isolation: 'per-case',
    needs: ['fixture'],
    setup: () => Promise.resolve(),
    run: () => Promise.resolve(),
  },
  {
    id: 'wc.fake.both',
    version: 1,
    suite: 'everyday',
    fixtures: ['tiny'],
    variant: 'serial',
    isolation: 'per-case',
    needs: ['fixture', 'git'],
    setup: () => Promise.resolve(),
    run: () => Promise.resolve(),
  },
];

export default everydaySuiteCases;
