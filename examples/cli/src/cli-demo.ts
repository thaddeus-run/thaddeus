// CLI demo (@thaddeus.run/cli). Run: CI= moon run example-cli:demo
//
// Boots a live server, then drives the real `thaddeus` commands against it:
// init → create → clone → edit a file → status → push → a second clone reads it.

import { run } from '@thaddeus.run/cli';
import { ready } from '@thaddeus.run/identity';
import { FileBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

await ready();
const rule = (): void => console.log('—'.repeat(60));
const root = mkdtempSync(join(tmpdir(), 'thaddeus-cli-demo-'));
const srv = createServer({ backend: new FileBackend(join(root, 'server')) });
const http = Bun.serve({ port: 0, fetch: srv.fetch });
const base = `http://localhost:${http.port}`;
const home = join(root, 'home');
const out = (l: string): void => console.log('  ' + l);
const env = (cwd: string) => ({ cwd, home, out });

try {
  rule();
  console.log('$ thaddeus init');
  let code = await run(['init'], env(root));
  if (code !== 0) throw new Error(`init failed: ${code}`);

  console.log(`$ thaddeus create ${base} proj`);
  code = await run(['create', base, 'proj'], env(root));
  if (code !== 0) throw new Error(`create failed: ${code}`);

  const a = join(root, 'a');
  console.log(`$ thaddeus clone ${base} proj a`);
  code = await run(['clone', base, 'proj', a], env(root));
  if (code !== 0) throw new Error(`clone failed: ${code}`);

  writeFileSync(join(a, 'readme.md'), '# Thaddeus\n');
  console.log('$ echo "# Thaddeus" > a/readme.md');
  console.log('$ thaddeus status');
  code = await run(['status'], env(a));
  if (code !== 0) throw new Error(`status failed: ${code}`);

  console.log('$ thaddeus push');
  code = await run(['push'], env(a));
  if (code !== 0) throw new Error(`push failed: ${code}`);

  const b = join(root, 'b');
  console.log(`$ thaddeus clone ${base} proj b`);
  code = await run(['clone', base, 'proj', b], env(root));
  if (code !== 0) throw new Error(`clone b failed: ${code}`);

  rule();
  console.log(
    'b/readme.md after a fresh clone:',
    JSON.stringify(readFileSync(join(b, 'readme.md'), 'utf8'))
  );

  rule();
  console.log(
    'Acceptance: edit on disk, push, and a fresh clone reads it back — over HTTP.'
  );
} finally {
  await http.stop(true);
}
