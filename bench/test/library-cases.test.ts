import { ready } from '@thaddeus.run/identity';
import { FileBackend, MemoryBackend } from '@thaddeus.run/persist';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import type { BenchCase, CaseContext } from '../src/case';
import libraryCases from '../src/cases/index';
import type { CreateState } from '../src/cases/open';
import { openQueryState } from '../src/cases/query';
import { fixtureDir, WORK_ROOT } from '../src/fixtures/cache';
import { authorsOf, materializeFixture } from '../src/fixtures/materialize';
import { generateFixture } from '../src/fixtures/plan';
import { tinySpec } from '../src/fixtures/spec';
import { FILEBACKEND_DURABILITY } from '../src/result';
import { runCase } from '../src/runner';

const LIBRARY = join(import.meta.dir, '..', 'src', 'cases', 'index.ts');

// The first run builds the tiny fixture caches (1,000 filler repositories for
// `open.cold.root-1000`), which takes longer than bun's 5 s default.
const SLOW = 120_000;

// Every file under `dir` as a sorted [path, size, sha256] list, so a test can
// prove that nothing in the tree was created, removed or changed.
function snapshotTree(dir: string): [string, number, string][] {
  const out: [string, number, string][] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const bytes = readFileSync(path);
      out.push([
        relative(dir, path),
        statSync(path).size,
        createHash('sha256').update(bytes).digest('hex'),
      ]);
    }
  };
  walk(dir);
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// The 10,000-contribution archive cases verify tens of thousands of
// signatures: about 12 s of setup and 30 s per run. They get one repeat and a
// larger budget.
const LARGE = '.10000';

for (const c of libraryCases) {
  const large = c.id.endsWith(LARGE);
  test(
    `${c.id} runs`,
    async () => {
      const r = await runCase(c.id, 'tiny', {
        repeats: large ? 1 : 2,
        warmup: 0,
        budgetMs: large ? 120_000 : 60_000,
        registry: LIBRARY,
      });
      expect(r.note).toBeUndefined();
      expect(r.status).toBe('ok');
      if (c.writes === true) expect(r.durability).toBe(FILEBACKEND_DURABILITY);
    },
    large ? 2 * SLOW : SLOW
  );
}

test('ids are unique and versioned', () => {
  expect(new Set(libraryCases.map((c) => c.id)).size).toBe(libraryCases.length);
  expect(libraryCases.every((c) => c.version >= 1)).toBe(true);
});

test(
  'write cases never touch the cached fixture',
  async () => {
    const dir = await fixtureDir(generateFixture(tinySpec()));
    const before = snapshotTree(dir);
    await runCase('oplog.write', 'tiny', {
      repeats: 2,
      warmup: 0,
      budgetMs: 60_000,
      registry: LIBRARY,
    });
    expect(snapshotTree(dir)).toEqual(before);
  },
  SLOW
);

// The runner deletes a case's workDir, so this drives the case's own setup
// and run in-process on a workDir the test keeps, then looks for the record.
test(
  "repo.create writes the new repository's signed genesis head",
  async () => {
    const benchCase = libraryCases.find(
      (c) => c.id === 'repo.create'
    ) as unknown as BenchCase<CreateState>;
    mkdirSync(WORK_ROOT, { recursive: true });
    const workDir = mkdtempSync(join(WORK_ROOT, 'test-'));
    try {
      const ctx: CaseContext = {
        plan: generateFixture(tinySpec()),
        fixture: 'tiny',
        workDir,
        pageCache: 'warm',
      };
      const state = await benchCase.setup(ctx);
      const backend = new FileBackend(state.root);
      const prefix = `repo/${state.name}/head/`;
      expect(await backend.list(prefix)).toEqual([]);
      await benchCase.run(state, ctx);
      expect(await backend.list(prefix)).toEqual([
        `${prefix}main/0000000000000000`,
      ]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  },
  SLOW
);

test(
  'graph sees symbols in fixture content',
  async () => {
    const { graph } = await openQueryState(generateFixture(tinySpec()));
    expect((await graph.symbols()).length).toBeGreaterThan(0);
  },
  SLOW
);

test(
  '10000-contribution import passes its own limit',
  async () => {
    const r = await runCase('reputation.import.10000', 'small', {
      repeats: 1,
      warmup: 0,
      budgetMs: 120_000,
      registry: LIBRARY,
    });
    expect(r.note).toBeUndefined();
    expect(r.status).toBe('ok');
  },
  2 * SLOW
);

// Every file another author writes is sealed to that author alone unless the
// materializer grants it to the owner, so a graph read as the owner would see
// only the owner's files.
test('the owner can read every path of main on a multi-author fixture', async () => {
  await ready();
  const plan = generateFixture(tinySpec());
  expect(plan.spec.authors).toBeGreaterThan(1);
  const repo = await materializeFixture(plan, new MemoryBackend());
  const owner = authorsOf(plan)[0];
  const entries = [...repo.log.materialize('main', owner).entries()];
  expect(entries.length).toBeGreaterThan(1);
  for (const [, entry] of entries) {
    if (entry.ref === null) continue;
    expect((await repo.store.get(entry.ref, owner)).length).toBeGreaterThan(0);
  }
  expect(new Set(entries.map(([, e]) => e.op.author)).size).toBeGreaterThan(1);
});
