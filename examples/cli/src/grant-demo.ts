// Grant/revoke delegation demo (@thaddeus.run/cli). Run: CI= moon run example-cli:grant-demo
//
// Boots a live server, inits two identities (owner + teammate), and drives the
// real `thaddeus grant` / `revoke` / `grants` commands to show:
//   1. A delegated in-scope push lands (src/** is allowed).
//   2. An out-of-scope push is rejected with a scope reason.
//   3. After revocation, any push by the delegate is blocked.

import { run, startServer } from '@thaddeus.run/cli';
import { ready } from '@thaddeus.run/identity';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

await ready();

const rule = (): void => console.log('—'.repeat(60));
const root = mkdtempSync(join(tmpdir(), 'thaddeus-grant-demo-'));

// Start a durable server via the shared helper (same as tests use).
const server = startServer({ dataDir: join(root, 'server'), port: 0 });
const base = server.url;

// Owner and teammate each get their own home directory (= separate identity).
const ownerHome = join(root, 'owner-home');
const mateHome = join(root, 'mate-home');

// Collect output for each act so we can inspect and print it.
const lines: string[] = [];
const out = (l: string): void => {
  lines.push(l);
  console.log('  ' + l);
};

// Helper: build a CliEnv for a given working directory and home.
const env = (cwd: string, home: string) => ({ cwd, home, out });

try {
  // ── Owner: init identity, create repo, clone ──────────────────────────────
  rule();
  console.log('# Act 1: owner sets up repo');

  console.log('$ thaddeus init  (owner)');
  let code = await run(['init'], env(root, ownerHome));
  if (code !== 0) throw new Error(`owner init failed: ${code}`);

  console.log(`$ thaddeus create ${base} proj`);
  code = await run(['create', base, 'proj'], env(root, ownerHome));
  if (code !== 0) throw new Error(`create failed: ${code}`);

  const ownerWc = join(root, 'owner-wc');
  console.log(`$ thaddeus clone ${base} proj owner-wc`);
  code = await run(['clone', base, 'proj', ownerWc], env(root, ownerHome));
  if (code !== 0) throw new Error(`owner clone failed: ${code}`);

  // ── Teammate: init identity, read their DID ───────────────────────────────
  rule();
  console.log('# Act 2: teammate inits their identity');

  console.log('$ thaddeus init  (teammate)');
  lines.length = 0;
  code = await run(['init'], env(root, mateHome));
  if (code !== 0) throw new Error(`teammate init failed: ${code}`);

  // Read DID straight from the identity file (same approach as grants.test.ts).
  const teammateDid = (
    JSON.parse(
      readFileSync(
        join(mateHome, '.config', 'thaddeus', 'identity.json'),
        'utf8'
      )
    ) as { did: string }
  ).did;
  console.log(`  teammate DID: ${teammateDid}`);

  // ── Owner grants teammate src/** ──────────────────────────────────────────
  rule();
  console.log('# Act 3: owner grants teammate push rights on src/**');

  console.log(`$ thaddeus grant ${teammateDid} --paths src/**`);
  lines.length = 0;
  code = await run(
    ['grant', teammateDid, '--paths', 'src/**'],
    env(ownerWc, ownerHome)
  );
  if (code !== 0) throw new Error(`grant failed: ${code}`);
  console.log('  grant output:', lines.join(' | '));

  console.log('$ thaddeus grants');
  lines.length = 0;
  code = await run(['grants'], env(ownerWc, ownerHome));
  if (code !== 0) throw new Error(`grants failed: ${code}`);
  console.log('  grants output:', lines.join(' | '));

  // ── Teammate clones, pushes in-scope change → should land ────────────────
  rule();
  console.log('# Act 4: teammate clones + pushes an in-scope src/ change');

  const mateWc = join(root, 'mate-wc');
  console.log(`$ thaddeus clone ${base} proj mate-wc`);
  code = await run(['clone', base, 'proj', mateWc], env(root, mateHome));
  if (code !== 0) throw new Error(`teammate clone failed: ${code}`);

  // Create the src/ directory before writing into it (materializeToDisk does
  // not create directories that have no cloned files yet).
  mkdirSync(join(mateWc, 'src'), { recursive: true });
  writeFileSync(join(mateWc, 'src', 'main.rs'), 'fn main() {}\n');
  console.log('$ echo "fn main() {}" > mate-wc/src/main.rs');

  console.log('$ thaddeus push  (in-scope: src/main.rs)');
  lines.length = 0;
  code = await run(['push'], env(mateWc, mateHome));
  const inScopeOutput = lines.join(' | ');
  const inScopeLanded = inScopeOutput.toLowerCase().includes('published');
  console.log(`  output: ${inScopeOutput}`);
  console.log(
    `  ✓ in-scope push landed: ${inScopeLanded ? 'YES' : 'NO (UNEXPECTED!)'}`
  );
  if (!inScopeLanded)
    throw new Error('in-scope push should have landed but did not');

  // ── Teammate pushes out-of-scope change → should be rejected ─────────────
  rule();
  console.log('# Act 5: teammate pushes an out-of-scope change (readme.md)');

  writeFileSync(join(mateWc, 'readme.md'), '# Project\n');
  console.log('$ echo "# Project" > mate-wc/readme.md');

  console.log('$ thaddeus push  (out-of-scope: readme.md)');
  lines.length = 0;
  code = await run(['push'], env(mateWc, mateHome));
  const outScopeOutput = lines.join(' | ');
  const outScopeBlocked =
    outScopeOutput.toLowerCase().includes('not landed') &&
    outScopeOutput.toLowerCase().includes('scope');
  console.log(`  output: ${outScopeOutput}`);
  console.log(
    `  ✓ out-of-scope push blocked with scope reason: ${outScopeBlocked ? 'YES' : 'NO (UNEXPECTED!)'}`
  );
  if (!outScopeBlocked)
    throw new Error('out-of-scope push should have been scope-blocked');

  // ── Owner revokes; next teammate push is blocked ──────────────────────────
  rule();
  console.log('# Act 6: owner revokes the grant; next push is blocked');

  console.log(`$ thaddeus revoke ${teammateDid}`);
  lines.length = 0;
  code = await run(['revoke', teammateDid], env(ownerWc, ownerHome));
  if (code !== 0) throw new Error(`revoke failed: ${code}`);
  console.log('  revoke output:', lines.join(' | '));

  mkdirSync(join(mateWc, 'src'), { recursive: true });
  writeFileSync(join(mateWc, 'src', 'lib.rs'), 'fn lib() {}\n');
  console.log('$ echo "fn lib() {}" > mate-wc/src/lib.rs');

  console.log('$ thaddeus push  (post-revoke: should be blocked)');
  lines.length = 0;
  code = await run(['push'], env(mateWc, mateHome));
  const revokedOutput = lines.join(' | ');
  // After revocation the server rejects at the push/land level — the CLI may
  // print "not landed: …" or surface the HTTP 403 as "error: not authorized".
  // Either way the exit code must be non-zero.
  const revokeBlocked = code !== 0;
  console.log(`  output: ${revokedOutput}`);
  console.log(
    `  ✓ post-revoke push blocked: ${revokeBlocked ? 'YES' : 'NO (UNEXPECTED!)'}`
  );
  if (!revokeBlocked)
    throw new Error('post-revoke push should have been blocked');

  rule();
  console.log(
    'Acceptance: grant → in-scope lands / out-of-scope scope-blocked / revoke blocks — over HTTP.'
  );
} finally {
  await server.stop();
}
