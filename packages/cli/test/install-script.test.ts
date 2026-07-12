import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
