import { addExtra, type CaseContext, loadCase, type RunExtra } from './case';
import { generateFixture } from './fixtures/plan';
import { resolveFixture } from './fixtures/spec';

// The child half of the runner. The parent spawns
// `bun <abs>/bench/src/child.ts '<ChildRequest JSON>'`, one process per case
// (or per sample), so peak RSS belongs to this case alone and a budget kill
// cannot take the parent down with it.
//
// Protocol on stdout, one JSON object per line:
//   {"phase":"setup"}   before the plan is built and `setup` runs
//   {"phase":"run"}     before the first warm-up or timed repeat
//   ChildReport         once, after teardown, as the last line
// Other stdout lines (a case that logs) are ignored by the parent. A thrown
// error goes to stderr with its stack and the child exits 1.

export interface ChildRequest {
  /** Absolute path of the registry module. */
  registry: string;
  id: string;
  /** Fixture name, resolved here with `resolveFixture`. */
  fixture: string;
  repeats: number;
  warmup: number;
  pageCache: 'warm' | 'dropped';
  workDir: string;
  durationMs?: number;
}

export interface ChildReport {
  samplesMs: number[];
  /** `RunExtra` summed over the timed repeats; warm-ups are not counted. */
  extra: RunExtra;
  peakRssBytes: number;
  /** From the case's `measure`, when it has one and reports it. */
  diskBytes?: number;
}

function emit(line: object): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(req: ChildRequest): Promise<void> {
  const benchCase = await loadCase(req.registry, req.id);
  emit({ phase: 'setup' });
  const ctx: CaseContext = {
    plan: generateFixture(resolveFixture(req.fixture)),
    fixture: req.fixture,
    workDir: req.workDir,
    pageCache: req.pageCache,
    ...(req.durationMs !== undefined && { durationMs: req.durationMs }),
  };
  const state = await benchCase.setup(ctx);
  emit({ phase: 'run' });
  for (let i = 0; i < req.warmup; i++) await benchCase.run(state, ctx);
  const samplesMs: number[] = [];
  const extra: RunExtra = {};
  for (let i = 0; i < req.repeats; i++) {
    const started = performance.now();
    const result = await benchCase.run(state, ctx);
    samplesMs.push(performance.now() - started);
    addExtra(extra, result);
  }
  const measured = await benchCase.measure?.(state, ctx);
  await benchCase.teardown?.(state, ctx);
  // maxRSS is in kibibytes on Linux.
  const peakRssBytes = process.resourceUsage().maxRSS * 1024;
  emit({
    samplesMs,
    extra,
    peakRssBytes,
    ...(measured?.diskBytes !== undefined && { diskBytes: measured.diskBytes }),
  } satisfies ChildReport);
}

if (import.meta.main) {
  const arg = process.argv[2];
  if (arg === undefined) {
    process.stderr.write('usage: bun child.ts <ChildRequest JSON>\n');
    process.exit(2);
  }
  // Exit explicitly: a case that leaves a handle open (a timer, a socket)
  // must not keep the child alive until the budget kills it.
  main(JSON.parse(arg) as ChildRequest).then(
    () => process.exit(0),
    (error: unknown) => {
      const text =
        error instanceof Error ? (error.stack ?? String(error)) : String(error);
      process.stderr.write(`${text}\n`);
      process.exit(1);
    }
  );
}
