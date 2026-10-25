import type { BenchCase } from '../../src/case';

// Fast fake cases for the suite builder tests: one cold per-sample case and
// one sweep case, so a test can check which results and sweeps a suite run
// produces without timing any real code.
const suiteCases: readonly BenchCase[] = [
  {
    id: 'suite.cold',
    version: 1,
    suite: 'library',
    fixtures: ['tiny', 'small'],
    isolation: 'per-sample',
    cold: true,
    setup: () => Promise.resolve(),
    run: () => Promise.resolve(),
  },
  {
    id: 'suite.sweep',
    version: 2,
    suite: 'library',
    fixtures: ['small'],
    isolation: 'per-case',
    sweep: true,
    setup: () => Promise.resolve(),
    run: () => Promise.resolve(),
  },
];

export default suiteCases;
