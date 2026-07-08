import { afterAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadIgnore } from '../src/ignore';
import { listWorkingFiles } from '../src/workcopy';

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-ignore-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('loadIgnore', () => {
  test('always prunes .git/.thaddeus/node_modules with no ignore files', () => {
    const root = mkdtempSync(join(tmp, 'always-'));
    const ig = loadIgnore(root);
    expect(ig.ignored('.git', true)).toBe(true);
    expect(ig.ignored('.thaddeus', true)).toBe(true);
    expect(ig.ignored('node_modules', true)).toBe(true);
    expect(ig.ignored('src/index.ts', false)).toBe(false);
    // Nothing to seed from → no .thaddeusignore created.
    expect(existsSync(join(root, '.thaddeusignore'))).toBe(false);
  });

  test('seeds .thaddeusignore from .gitignore, then matches its rules', () => {
    const root = mkdtempSync(join(tmp, 'seed-'));
    writeFileSync(
      join(root, '.gitignore'),
      [
        'dist/',
        '*.log',
        '/build',
        '.env',
        'keep/*.tmp',
        '!keep/important.tmp',
      ].join('\n')
    );
    const ig = loadIgnore(root);
    // A .thaddeusignore was created from the .gitignore's content.
    expect(existsSync(join(root, '.thaddeusignore'))).toBe(true);
    expect(readFileSync(join(root, '.thaddeusignore'), 'utf8')).toContain(
      'dist/'
    );
    // Its rules apply with common gitignore semantics.
    expect(ig.ignored('dist', true)).toBe(true); // dir-only
    expect(ig.ignored('sub/dist', true)).toBe(true); // unanchored → any depth
    expect(ig.ignored('a/b.log', false)).toBe(true); // *.log at any depth
    expect(ig.ignored('build', true)).toBe(true); // /build anchored to root
    expect(ig.ignored('sub/build', true)).toBe(false); // anchored → not nested
    expect(ig.ignored('.env', false)).toBe(true);
    expect(ig.ignored('keep/x.tmp', false)).toBe(true);
    expect(ig.ignored('keep/important.tmp', false)).toBe(false); // re-included
    expect(ig.ignored('src/main.ts', false)).toBe(false);
  });

  test('an existing .thaddeusignore wins; .gitignore is not read or overwritten', () => {
    const root = mkdtempSync(join(tmp, 'own-'));
    writeFileSync(join(root, '.gitignore'), 'fromgit\n');
    writeFileSync(join(root, '.thaddeusignore'), 'fromthad\n');
    const ig = loadIgnore(root);
    expect(ig.ignored('fromthad', false)).toBe(true);
    expect(ig.ignored('fromgit', false)).toBe(false); // .gitignore ignored
    // The user's .thaddeusignore is left untouched (not re-seeded).
    expect(readFileSync(join(root, '.thaddeusignore'), 'utf8')).toBe(
      'fromthad\n'
    );
  });
});

describe('listWorkingFiles', () => {
  test('skips node_modules and ignored files/dirs, keeps source', () => {
    const root = mkdtempSync(join(tmp, 'walk-'));
    writeFileSync(join(root, '.gitignore'), 'node_modules\n*.log\ndist/\n');
    writeFileSync(join(root, 'a.ts'), 'x');
    writeFileSync(join(root, 'debug.log'), 'x');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'out.js'), 'x');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'main.ts'), 'x');

    const files = listWorkingFiles(root);
    expect(files).toContain('a.ts');
    expect(files).toContain('src/main.ts');
    expect(files).not.toContain('debug.log');
    expect(files.some((f) => f.startsWith('node_modules'))).toBe(false);
    expect(files.some((f) => f.startsWith('dist'))).toBe(false);
  });
});
