import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'tsdown';

test('client browser bundle does not import Node builtins', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'thaddeus-browser-'));
  try {
    await build({
      entry: ['src/index.ts'],
      outDir,
      config: false,
      dts: false,
      platform: 'browser',
      noExternal: [/.*/],
      logLevel: 'silent',
    });
    const output = await readFile(join(outDir, 'index.js'), 'utf8');
    expect(output.match(/(?:from\s*|import\s*\(?)["']node:[^"']*/g)).toBeNull();
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}, 30_000);
