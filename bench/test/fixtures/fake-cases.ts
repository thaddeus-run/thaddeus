import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BenchCase, CaseContext } from '../../src/case';

// Fake cases for the runner tests. None of them touch a fixture on disk, so
// the runner tests stay fast and only exercise process handling.

const MiB = 1024 * 1024;

// Busy-loop iterations per fixture op for `fake.linear`. One iteration per op
// would finish in microseconds, where timer noise hides the linear growth.
const SPIN_PER_OP = 500;

// Written by `fake.linear` so the JIT cannot drop the loop as dead code.
export let spinSink = 0;

// The file a fake reports a pid or path into, chosen by the test via the env.
function probeFile(): string {
  const file = process.env.FAKE_PROBE_FILE;
  if (file === undefined) throw new Error('FAKE_PROBE_FILE is not set');
  return file;
}

function fake(
  id: string,
  overrides: Partial<BenchCase> & Pick<BenchCase, 'run'>
): BenchCase {
  return {
    id,
    version: 1,
    suite: 'library',
    fixtures: ['small'],
    isolation: 'per-case',
    setup: () => Promise.resolve(undefined),
    ...overrides,
  };
}

const fakes: readonly BenchCase[] = [
  fake('fake.ok', { run: () => Promise.resolve() }),
  fake('fake.sleep', { run: () => Bun.sleep(5_000) }),
  fake('fake.setup-sleep', {
    setup: () => Bun.sleep(5_000),
    run: () => Promise.resolve(),
  }),
  fake('fake.alloc', {
    setup: () => Promise.resolve(new Uint8Array(64 * MiB).fill(1)),
    run: (state) => {
      (state as Uint8Array)[0] += 1;
      return Promise.resolve();
    },
  }),
  fake('fake.throw', {
    run: () => Promise.reject(new Error('boom')),
  }),
  fake('fake.linear', {
    sweep: true,
    run: (_state, ctx) => {
      const n = ctx.plan.spec.ops;
      let x = 0;
      for (let i = 0; i < n * SPIN_PER_OP; i++) x = (x * 31 + i) | 0;
      spinSink = x;
      return Promise.resolve({ ops: n });
    },
  }),
  // Dies the way the kernel OOM killer kills: SIGKILL the parent didn't send.
  fake('fake.sigkill', {
    run: () => {
      process.kill(process.pid, 'SIGKILL');
      return Bun.sleep(5_000);
    },
  }),
  // Dies the way Bun reports a JS heap exhaustion.
  fake('fake.heap', {
    run: () => Promise.reject(new RangeError('Out of memory')),
  }),
  // Starts a grandchild that would outlive the child, and records its pid in
  // the file named by FAKE_PROBE_FILE so the test can check it was killed.
  fake('fake.orphan', {
    run: () => {
      const orphan = Bun.spawn(['sleep', '30'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      writeFileSync(probeFile(), String(orphan.pid));
      return Bun.sleep(5_000);
    },
  }),
  // Starts a grandchild in its own session that inherits the child's stdout
  // and stderr, so the pipes stay open after the child exits. The runner must
  // stop waiting on them. The grandchild's pid goes to FAKE_PROBE_FILE.
  fake('fake.leaky', {
    run: () => {
      const leak = Bun.spawn(['sleep', '30'], {
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: true,
      });
      writeFileSync(probeFile(), String(leak.pid));
      return Promise.resolve();
    },
  }),
  // Per-sample, and each child's `measure` reports 1,000 bytes more than the
  // previous one by counting spawns in FAKE_PROBE_FILE, so the runner's max
  // over children is visible.
  fake('fake.disk', {
    isolation: 'per-sample',
    run: () => Promise.resolve(),
    measure: () => {
      const file = probeFile();
      const count = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
      writeFileSync(file, String(count + 1));
      return Promise.resolve({ diskBytes: (count + 1) * 1_000 });
    },
  }),
  // Per-sample, cold and writing: checks the flags and the per-sample spawns.
  fake('fake.cold-write', {
    isolation: 'per-sample',
    writes: true,
    cold: true,
    run: () => Promise.resolve({ bytes: 2_000_000 }),
  }),
  // Throws unless the context carries exactly what the test passed in, and
  // records its workDir in FAKE_PROBE_FILE so the test can check the cleanup.
  fake('fake.context', {
    setup: (ctx: CaseContext) => {
      writeFileSync(join(ctx.workDir, 'probe'), 'x');
      writeFileSync(probeFile(), ctx.workDir);
      return Promise.resolve(ctx.workDir);
    },
    run: (state, ctx) => {
      const okay =
        ctx.fixture === 'sweep-2000' &&
        ctx.plan.spec.ops === 2_000 &&
        ctx.pageCache === 'dropped' &&
        ctx.durationMs === 1_234 &&
        existsSync(join(state as string, 'probe'));
      if (okay) return Promise.resolve();
      const { plan: _plan, ...rest } = ctx;
      return Promise.reject(
        new Error(`unexpected context ${JSON.stringify(rest)}`)
      );
    },
  }),
  // Declares its serve flags and caps its timed repeats at 2; also fails in
  // setup when FAKE_FAIL_SETUP is set, to check a failure keeps the flags.
  fake('fake.flags', {
    maxRepeats: 2,
    serveFlags: (fixture) => ['--fixture', fixture],
    setup: () =>
      process.env.FAKE_FAIL_SETUP === '1'
        ? Promise.reject(new Error('setup failed'))
        : Promise.resolve(),
    run: () => Promise.resolve(),
  }),
];

export default fakes;
