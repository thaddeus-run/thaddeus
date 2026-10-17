import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { checkReleaseVersions } from '../scripts/check-release-version';
import { nightlyVersion } from '../scripts/nightly-version';
import { setReleaseVersion } from '../scripts/set-release-version';
import { releaseFixture } from './release-fixture';

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-nightly-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NIGHTLY = '0.1.11-nightly.20261017.42';

test('bumps the patch and stamps the UTC date and run', () =>
  expect(
    nightlyVersion('0.1.10-alpha', new Date('2026-10-17T23:30:00Z'), 42)
  ).toBe(NIGHTLY));

test('accepts a plain base', () =>
  expect(nightlyVersion('1.2.3', new Date('2026-01-02T00:00:00Z'), 7)).toBe(
    '1.2.4-nightly.20260102.7'
  ));

test('rejects a malformed base', () =>
  expect(() => nightlyVersion('v1.2', new Date(), 1)).toThrow());

test('rejects a run number that is not a positive integer', () => {
  for (const run of [0, -1, 1.5, Number.NaN]) {
    expect(() => nightlyVersion('1.2.3', new Date(), run)).toThrow('run');
  }
});

test('prints the version when run as a script', () => {
  const run = Bun.spawnSync({
    cmd: [
      process.execPath,
      resolve(import.meta.dir, '../scripts/nightly-version.ts'),
      '--base',
      '0.1.10-alpha',
      '--date',
      '2026-10-17T23:30:00Z',
      '--run',
      '42',
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(run.stderr.toString()).toBe('');
  expect(run.stdout.toString()).toBe(`${NIGHTLY}\n`);
  expect(run.exitCode).toBe(0);
});

test('setReleaseVersion makes the version check pass for the new tag', async () => {
  const root = releaseFixture(tmp);
  const changed = await setReleaseVersion(root, NIGHTLY);
  expect(changed.toSorted()).toEqual(
    [
      'README',
      'bun.lock',
      'lazythad/Cargo.lock',
      'lazythad/Cargo.toml',
      'npm/lazythad/package.json',
      'npm/thaddeus/package.json',
      'packages/cli/package.json',
      'packages/store/package.json',
    ].toSorted()
  );
  expect(checkReleaseVersions(root, `v${NIGHTLY}`)).toBe(NIGHTLY);
  // Files outside the shared release keep their own versions.
  expect(readFileSync(join(root, 'apps/docs/package.json'), 'utf8')).toBe(
    '{"version":"0.0.0"}'
  );
  expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(
    'Previously released 0.1.0-alpha.\n'
  );
});

test('setReleaseVersion touches only the local lazythad entry in Cargo.lock', async () => {
  const root = releaseFixture(tmp);
  const lock = (local: string): string =>
    [
      '[[package]]',
      'name = "anyhow"',
      'version = "1.2.3-alpha"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      '',
      '[[package]]',
      'name = "lazythad"',
      `version = "${local}"`,
      'dependencies = [',
      ' "anyhow",',
      ']',
      '',
      '[[package]]',
      'name = "lazythad"',
      'version = "1.2.3-alpha"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      '',
    ].join('\n');
  writeFileSync(join(root, 'lazythad/Cargo.lock'), lock('1.2.3-alpha'));
  await setReleaseVersion(root, NIGHTLY);
  expect(readFileSync(join(root, 'lazythad/Cargo.lock'), 'utf8')).toBe(
    lock(NIGHTLY)
  );
});

test('setReleaseVersion rejects a version that is not semver and writes nothing', async () => {
  const root = releaseFixture(tmp);
  for (const version of ['v1.2.3', '1.2', '1.2.3 ', '1.2.3"']) {
    const error: unknown = await setReleaseVersion(root, version).then(
      () => undefined,
      (rejection: unknown) => rejection
    );
    expect(String(error)).toContain('invalid release version');
  }
  expect(checkReleaseVersions(root)).toBe('1.2.3-alpha');
});
