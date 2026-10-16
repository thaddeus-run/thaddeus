import { afterAll, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { checkReleaseVersions } from '../scripts/check-release-version';
import { VERSION } from '../src/version';

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-versions-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Build independent metadata fixtures so failure tests never modify the checkout.
function fixture(): string {
  const root = mkdtempSync(join(tmp, 'repo-'));
  const files: Record<string, string> = {
    'packages/cli/package.json': '{"version":"1.2.3-alpha","private":true}',
    'packages/store/package.json': '{"version":"1.2.3-alpha"}',
    'npm/thaddeus/package.json': '{"version":"1.2.3-alpha"}',
    'npm/lazythad/package.json': '{"version":"1.2.3-alpha"}',
    'bun.lock':
      '{"workspaces":{"packages/cli":{"version":"1.2.3-alpha"},"packages/store":{"version":"1.2.3-alpha"},},}',
    'lazythad/Cargo.toml':
      '[package]\nname = "lazythad"\nversion = "1.2.3-alpha"\n',
    'lazythad/Cargo.lock':
      '[[package]]\nname = "lazythad"\nversion = "1.2.3-alpha"\n',
    README: 'STATUS: PRE-ALPHA (v1.2.3-alpha)\n',
    'examples/demo/package.json': '{"version":"0.0.0"}',
    'apps/docs/package.json': '{"version":"0.0.0"}',
    'package.json': '{"private":true}',
    'CHANGELOG.md': 'Previously released 0.1.0-alpha.\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('current checkout and release tag agree on the embedded CLI version', () => {
  const root = resolve(import.meta.dir, '../../..');
  expect(checkReleaseVersions(root)).toBe(VERSION);
  expect(checkReleaseVersions(root, `v${VERSION}`)).toBe(VERSION);
});

test('release fixtures accept JSONC trailing commas and exclude historical or private app versions', () => {
  expect(checkReleaseVersions(fixture(), 'v1.2.3-alpha')).toBe('1.2.3-alpha');
});

for (const path of [
  'packages/store/package.json',
  'npm/thaddeus/package.json',
  'npm/lazythad/package.json',
  'bun.lock',
  'lazythad/Cargo.toml',
  'lazythad/Cargo.lock',
  'README',
]) {
  test(`rejects version drift in ${path} without caching a previous pass`, () => {
    const root = fixture();
    expect(checkReleaseVersions(root)).toBe('1.2.3-alpha');
    const full = join(root, path);
    writeFileSync(
      full,
      readFileSync(full, 'utf8').replaceAll('1.2.3-alpha', '9.8.7')
    );
    expect(() => checkReleaseVersions(root)).toThrow(path);
    expect(() => checkReleaseVersions(root)).toThrow('expected 1.2.3-alpha');
  });
}

test('includes newly discovered private release packages', () => {
  const root = fixture();
  mkdirSync(join(root, 'packages/new-package'));
  writeFileSync(
    join(root, 'packages/new-package/package.json'),
    '{"private":true,"version":"9.0.0"}'
  );
  expect(() => checkReleaseVersions(root)).toThrow(
    'packages/new-package/package.json'
  );
  expect(() => checkReleaseVersions(root)).toThrow('bun.lock');
});

test('rejects missing workspace lock entries and ambiguous local Rust records', () => {
  const root = fixture();
  writeFileSync(join(root, 'bun.lock'), '{"workspaces":{}}');
  expect(() => checkReleaseVersions(root)).toThrow('bun.lock');
  const other = fixture();
  const lock = join(other, 'lazythad/Cargo.lock');
  writeFileSync(lock, readFileSync(lock, 'utf8').repeat(2));
  expect(() => checkReleaseVersions(other)).toThrow(
    'expected one local lazythad'
  );
});

test('rejects absent or malformed required metadata with a path-specific error', () => {
  for (const path of [
    'packages/store/package.json',
    'npm/lazythad/package.json',
    'bun.lock',
    'lazythad/Cargo.toml',
  ]) {
    const root = fixture();
    writeFileSync(join(root, path), 'malformed');
    expect(() => checkReleaseVersions(root)).toThrow(path);
    rmSync(join(root, path));
    expect(() => checkReleaseVersions(root)).toThrow(path);
  }
});

test('accepts only the exact supplied release tag', () => {
  const root = fixture();
  for (const tag of [
    '',
    'main',
    'v9.0.0',
    'v1.2.3-alpha\n',
    'v1.2.3-alpha\nv9.0.0',
  ]) {
    expect(() => checkReleaseVersions(root, tag)).toThrow('release tag');
  }
});
