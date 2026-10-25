import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import libraryCases from '../src/cases/index';
import { fixtureDir } from '../src/fixtures/cache';
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

for (const c of libraryCases) {
  test(
    `${c.id} runs`,
    async () => {
      const r = await runCase(c.id, 'tiny', {
        repeats: 2,
        warmup: 0,
        budgetMs: 60_000,
        registry: LIBRARY,
      });
      expect(r.note).toBeUndefined();
      expect(r.status).toBe('ok');
      if (c.writes === true) expect(r.durability).toBe(FILEBACKEND_DURABILITY);
    },
    SLOW
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
