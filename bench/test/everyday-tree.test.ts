import { expect, test } from 'bun:test';

import { EDIT_FILES, editPaths, mainTree } from '../src/everyday/tree';
import { generateFixture } from '../src/fixtures/plan';
import { resolveFixture } from '../src/fixtures/spec';

test('mainTree of tiny-serial holds only paths the plan wrote last on main', () => {
  const plan = generateFixture(resolveFixture('tiny-serial'));
  const tree = mainTree(plan);
  expect(tree.size).toBeGreaterThan(0);
  for (const path of tree.keys()) expect(path).toMatch(/^src\/f\d+\.ts$/);
});

test('mainTree refuses a base plan', () => {
  expect(() => mainTree(generateFixture(resolveFixture('tiny')))).toThrow(
    /serial/
  );
});

test('editPaths takes the first EDIT_FILES paths of main in sorted order', () => {
  const plan = generateFixture(resolveFixture('small-serial'));
  const paths = editPaths(plan);
  expect(paths).toHaveLength(EDIT_FILES);
  expect(paths).toEqual([...mainTree(plan).keys()].sort().slice(0, EDIT_FILES));
});
