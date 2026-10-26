import type { BenchCase } from '../../src/case';

// One fast fake e2e case on the serial variants, so the suite builder tests
// can check what an e2e case needs pre-built without starting a server.
const e2eSuiteCases: readonly BenchCase[] = [
  {
    id: 'suite.e2e',
    version: 1,
    suite: 'e2e',
    fixtures: ['tiny'],
    variant: 'serial',
    isolation: 'per-case',
    setup: () => Promise.resolve(),
    run: () => Promise.resolve(),
  },
];

export default e2eSuiteCases;
