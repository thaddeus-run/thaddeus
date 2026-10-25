import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCase } from '../../src/runner';

// Drives runCase in its own process so a test can signal or exit it.
//   bun interrupt-driver.ts signal  installs its own SIGINT listener (as a CLI
//                                    would), runs fake.orphan and prints how
//                                    runCase settled plus the SIGINT count.
//   bun interrupt-driver.ts exit    starts fake.orphan and calls process.exit
//                                    once the orphan's pid is in FAKE_PROBE_FILE.

const FAKES = join(import.meta.dir, 'fake-cases.ts');
const opts = { repeats: 1, warmup: 0, budgetMs: 20_000, registry: FAKES };

let sigints = 0;
const mode = process.argv[2];
if (mode === 'signal') {
  process.on('SIGINT', () => {
    sigints += 1;
  });
  const settled = await runCase('fake.orphan', 'small', opts).then(
    (result) => ({ status: result.status, note: result.note }),
    (error: unknown) => ({
      name: error instanceof Error ? error.name : 'unknown',
      message: String(error),
    })
  );
  process.stdout.write(`${JSON.stringify({ ...settled, sigints })}\n`);
  process.exit(0);
} else if (mode === 'exit') {
  void runCase('fake.orphan', 'small', opts);
  const file = process.env.FAKE_PROBE_FILE ?? '';
  while (!existsSync(file) || readFileSync(file, 'utf8') === '') {
    await Bun.sleep(20);
  }
  process.exit(0);
} else {
  throw new Error(`unknown mode ${mode}`);
}
