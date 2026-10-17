import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../..');
const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-install-script-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('install.sh', () => {
  test('installs thad as an executable alias for thaddeus', () => {
    const home = join(tmp, 'home');
    const prefix = join(tmp, 'prefix');
    const fakeBin = join(tmp, 'fake-bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    const uname = join(fakeBin, 'uname');
    writeFileSync(
      uname,
      `#!/bin/sh\ncase "$1" in\n  -s) printf 'Linux\\n' ;;\n  -m) printf 'x86_64\\n' ;;\nesac\n`
    );
    chmodSync(uname, 0o755);

    const curl = join(fakeBin, 'curl');
    writeFileSync(
      curl,
      `#!/bin/sh\nout=''\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = '-o' ]; then\n    out="$2"\n    shift 2\n  else\n    shift\n  fi\ndone\nif [ -n "$out" ]; then\n  printf '#!/bin/sh\\nprintf binary\\n' > "$out"\nfi\n`
    );
    chmodSync(curl, 0o755);

    const install = Bun.spawnSync({
      cmd: ['/bin/sh', join(repoRoot, 'install.sh')],
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        THADDEUS_INSTALL: prefix,
        THADDEUS_VERSION: 'v-test',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(install.exitCode).toBe(0);
    const alias = join(prefix, 'bin', 'thad');
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(readlinkSync(alias)).toBe('thaddeus');
  });

  test('rejects an alias directory before downloading binaries', () => {
    const home = join(tmp, 'conflict-home');
    const prefix = join(tmp, 'conflict-prefix');
    const fakeBin = join(tmp, 'conflict-fake-bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(prefix, 'bin', 'thad'), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    const uname = join(fakeBin, 'uname');
    writeFileSync(
      uname,
      `#!/bin/sh\ncase "$1" in\n  -s) printf 'Linux\\n' ;;\n  -m) printf 'x86_64\\n' ;;\nesac\n`
    );
    chmodSync(uname, 0o755);

    const curl = join(fakeBin, 'curl');
    writeFileSync(
      curl,
      `#!/bin/sh\nout=''\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = '-o' ]; then\n    out="$2"\n    shift 2\n  else\n    shift\n  fi\ndone\nif [ -n "$out" ]; then\n  printf '#!/bin/sh\\nprintf binary\\n' > "$out"\nfi\n`
    );
    chmodSync(curl, 0o755);

    const install = Bun.spawnSync({
      cmd: ['/bin/sh', join(repoRoot, 'install.sh')],
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        THADDEUS_INSTALL: prefix,
        THADDEUS_VERSION: 'v-test',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(install.exitCode).not.toBe(0);
    expect(existsSync(join(prefix, 'bin', 'thaddeus'))).toBe(false);
  });
});

// Run install.sh on a fake Linux x64 host whose curl answers the releases
// list with `releases` (and releases/latest with v0.1.10-alpha), writes a stub
// binary for every download, and logs each URL it was asked for.
function installWithReleases(
  name: string,
  releases: string,
  env: Record<string, string>
): { exitCode: number; stderr: string; urls: string[]; prefix: string } {
  const dir = join(tmp, name);
  const fakeBin = join(dir, 'fake-bin');
  const prefix = join(dir, 'prefix');
  mkdirSync(join(dir, 'home'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(dir, 'releases.json'), releases);
  const log = join(dir, 'urls.log');
  writeFileSync(log, '');
  writeFileSync(
    join(fakeBin, 'uname'),
    `#!/bin/sh\ncase "$1" in\n  -s) printf 'Linux\\n' ;;\n  -m) printf 'x86_64\\n' ;;\nesac\n`
  );
  writeFileSync(
    join(fakeBin, 'curl'),
    [
      '#!/bin/sh',
      "out=''; url=''",
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac',
      'done',
      `printf '%s\\n' "$url" >> '${log}'`,
      'case "$url" in',
      `  */releases\\?per_page=30) cat '${join(dir, 'releases.json')}' ;;`,
      `  */releases/latest) printf '{"tag_name": "v0.1.10-alpha"}' ;;`,
      '  */SHA256SUMS) exit 22 ;;',
      `  *) [ -n "$out" ] && printf '#!/bin/sh\\n' > "$out" ;;`,
      'esac',
      '',
    ].join('\n')
  );
  chmodSync(join(fakeBin, 'uname'), 0o755);
  chmodSync(join(fakeBin, 'curl'), 0o755);
  const {
    THADDEUS_VERSION: _version,
    THADDEUS_CHANNEL: _channel,
    ...base
  } = process.env;
  const install = Bun.spawnSync({
    cmd: ['/bin/sh', join(repoRoot, 'install.sh')],
    env: {
      ...base,
      HOME: join(dir, 'home'),
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      THADDEUS_INSTALL: prefix,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: install.exitCode,
    stderr: install.stderr.toString(),
    urls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
    prefix,
  };
}

// The newest-first shape of GET /releases: an alpha cut after two nightlies.
const RELEASES = JSON.stringify(
  [
    { tag_name: 'v0.1.11-alpha', prerelease: false },
    { tag_name: 'v0.1.12-nightly.20261018.43', prerelease: true },
    { tag_name: 'v0.1.12-nightly.20261017.42', prerelease: true },
  ],
  null,
  2
);
const DOWNLOAD = 'https://github.com/thaddeus-run/thaddeus/releases/download';

describe('install.sh channels', () => {
  test('the default channel installs releases/latest', () => {
    const run = installWithReleases('default', RELEASES, {});
    expect(run.exitCode).toBe(0);
    expect(run.urls).toContain(
      'https://api.github.com/repos/thaddeus-run/thaddeus/releases/latest'
    );
    expect(run.urls).toContain(`${DOWNLOAD}/v0.1.10-alpha/thaddeus-linux-x64`);
  });

  test('THADDEUS_CHANNEL=nightly installs the newest nightly release', () => {
    const run = installWithReleases('nightly', RELEASES, {
      THADDEUS_CHANNEL: 'nightly',
    });
    expect(run.exitCode).toBe(0);
    expect(run.urls).toContain(
      `${DOWNLOAD}/v0.1.12-nightly.20261018.43/thaddeus-linux-x64`
    );
    expect(run.urls).toContain(
      `${DOWNLOAD}/v0.1.12-nightly.20261018.43/lazythad-linux-x64`
    );
  });

  test('THADDEUS_CHANNEL=nightly without a nightly fails before installing', () => {
    const run = installWithReleases(
      'no-nightly',
      JSON.stringify([{ tag_name: 'v0.1.10-alpha' }]),
      { THADDEUS_CHANNEL: 'nightly' }
    );
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('no nightly release');
    expect(existsSync(join(run.prefix, 'bin', 'thaddeus'))).toBe(false);
  });

  test('THADDEUS_VERSION wins over THADDEUS_CHANNEL', () => {
    const run = installWithReleases('pinned', RELEASES, {
      THADDEUS_CHANNEL: 'nightly',
      THADDEUS_VERSION: 'v0.1.9-alpha',
    });
    expect(run.exitCode).toBe(0);
    expect(run.urls.some((url) => url.includes('api.github.com'))).toBe(false);
    expect(run.urls).toContain(`${DOWNLOAD}/v0.1.9-alpha/thaddeus-linux-x64`);
  });

  test('rejects an unknown channel', () => {
    const run = installWithReleases('unknown', RELEASES, {
      THADDEUS_CHANNEL: 'beta',
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("unknown THADDEUS_CHANNEL 'beta'");
  });
});
