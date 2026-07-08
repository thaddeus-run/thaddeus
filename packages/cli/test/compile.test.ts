import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The package root (this file is packages/cli/test/compile.test.ts).
const pkgRoot = resolve(import.meta.dir, '..');
const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-compile-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('compiled standalone binary', () => {
  test('bun build --compile produces a binary that runs --version and --help', (): void => {
    const bin = join(tmp, 'thaddeus');
    // Compile src/bin.ts into a self-contained executable (no Bun at runtime).
    // Workspace deps resolve through their built dist (cli:test deps on ^:build).
    const build = Bun.spawnSync({
      cmd: ['bun', 'build', '--compile', '--outfile', bin, 'src/bin.ts'],
      cwd: pkgRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(build.exitCode).toBe(0);

    // The binary runs with no Bun on PATH — it IS the runtime.
    const version = Bun.spawnSync({ cmd: [bin, '--version'] });
    expect(version.exitCode).toBe(0);
    expect(dec(version.stdout).trim()).toMatch(/^\d+\.\d+\.\d+/);

    const help = Bun.spawnSync({ cmd: [bin, '--help'] });
    expect(help.exitCode).toBe(0);
    expect(dec(help.stdout)).toContain('the Thaddeus CLI');
  }, 120_000); // compiling embeds the runtime — allow generous headroom
});
