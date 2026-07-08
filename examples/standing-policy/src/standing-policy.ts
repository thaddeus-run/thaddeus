// Policy-as-standing-query demo for @thaddeus.run/platform (Pillar 11, Slice 3).
// Run: CI= moon run example-standing-policy:demo
//
// "No untrusted agent may modify auth code" is not a CI script that runs late —
// it is an invariant the substrate enforces AS a change tries to converge. Two
// acts: (1) an untrusted stranger's landing to protected auth code is rejected;
// (2) the owner may land the same protected path.

import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { Platform, restrictPaths } from '@thaddeus.run/platform';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const rule = (): void => console.log('—'.repeat(60));

await ready();
const repo = new Platform().createRepo('acme/web');
const owner = Identity.create();
const stranger = Identity.create();

// The standing query: only the owner may touch auth code. Enforced at land.
const policy = restrictPaths({
  protect: ['src/auth/**'],
  allow: [owner.did],
  name: 'no untrusted agent may modify auth code',
});

async function tryLand(
  who: Identity,
  branch: string,
  path: string,
  body: string
): Promise<void> {
  const ws = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: who,
    name: branch,
  });
  ws.write(path, enc(body));
  await ws.commit(who);
  const r = await repo.land({
    from: branch,
    into: 'main',
    author: who,
    policy,
  });
  console.log(
    `   land ${path} by ${who === owner ? 'owner  ' : 'stranger'} →`,
    r.landed ? 'ALLOWED' : `REJECTED (${r.reason})`
  );
}

rule();
console.log('1. a stranger tries to modify protected auth code:');
await tryLand(stranger, 'feat/evil', 'src/auth/login.rs', 'fn backdoor() {}');
console.log(
  '   auth code on main?      ',
  repo.log.materialize('main').has('src/auth/login.rs')
);

rule();
console.log('2. the same stranger edits a non-protected path — allowed:');
await tryLand(stranger, 'feat/ui', 'src/ui/button.rs', 'fn button() {}');

rule();
console.log('3. the owner lands the protected auth path — allowed:');
await tryLand(owner, 'feat/fix', 'src/auth/login.rs', 'fn login() {}');
console.log(
  '   auth code on main?      ',
  repo.log.materialize('main').has('src/auth/login.rs')
);

rule();
console.log(
  'Acceptance: the invariant is enforced as changes converge — the substrate'
);
console.log('governs in real time, not a CI script that runs after the fact.');
