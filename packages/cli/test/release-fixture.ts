import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Build a fresh copy of every file the release-version checker reads, all at
// 1.2.3-alpha, inside `parent`. Tests that rewrite or corrupt versions get their
// own directory, so they never touch the checkout or each other.
export function releaseFixture(parent: string): string {
  const root = mkdtempSync(join(parent, 'repo-'));
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
