import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BenchCase } from '../../src/case';

// When SUITE_PROBE_DIR is set, each case child leaves a file there in setup,
// so a test can tell whether any case child was spawned.
function probeSetup(id: string): () => Promise<void> {
  return () => {
    const dir = process.env.SUITE_PROBE_DIR;
    if (dir !== undefined) writeFileSync(join(dir, `${id}-${process.pid}`), '');
    return Promise.resolve();
  };
}

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
    setup: probeSetup('suite.cold'),
    run: () => Promise.resolve(),
  },
  {
    id: 'suite.sweep',
    version: 2,
    suite: 'library',
    fixtures: ['small'],
    isolation: 'per-case',
    sweep: true,
    setup: probeSetup('suite.sweep'),
    run: () => Promise.resolve(),
  },
];

export default suiteCases;
