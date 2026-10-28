import { afterEach, expect, test } from 'bun:test';

import { gitEnv } from '../src/everyday/git';

// Variables git exports inside a hook or `git rebase --exec`, each of which
// would point the suite's git commands at the caller's repository.
const REDIRECTS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
];

afterEach(() => {
  for (const name of REDIRECTS) delete process.env[name];
});

test('gitEnv drops variables that would redirect git to another repository', () => {
  for (const name of REDIRECTS) process.env[name] = `/elsewhere/${name}`;
  const env = gitEnv('/home/bench');
  for (const name of REDIRECTS) expect(env[name]).toBeUndefined();
  expect(env.HOME).toBe('/home/bench');
  expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
});
