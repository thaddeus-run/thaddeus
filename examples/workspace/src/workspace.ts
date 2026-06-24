// Virtual filesystem demo for @thaddeus.run/fs (Pillar 05).
// Run: CI= moon run example-workspace:demo
//
// Three acts: (1) a working copy with no disk — write/grep/commit through the
// API; (2) cheap copy-on-write branches via fork(); (3) grep stops at the
// capability boundary — an undecryptable file is invisible, not an error.

import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const rule = (): void => console.log('—'.repeat(60));

await ready();
const store = new MemoryStore();
const log = new OpLog(store);
const dev = Identity.create();

// Act 1 — a working copy with no disk.
const ws = Workspace.open(log, store, { source: 'main', reader: dev });
ws.write('src/auth.rs', enc('fn login() {}\nfn refresh() {}\n'));
rule();
console.log('1. edit with no checkout — staged, uncommitted:');
console.log('   list:        ', await ws.list());
console.log('   grep refresh:', await ws.grep('refresh'));
console.log('   status:      ', ws.status());
const ops = await ws.commit(dev);
console.log(`   commit → ${ops.length} op(s); status now:`, ws.status());

// Act 2 — cheap copy-on-write branches.
const branch = ws.fork();
ws.write('src/auth.rs', enc('fn refresh_v2() {}\n'));
await ws.commit(dev);
branch.write('src/auth.rs', enc('fn refresh_experimental() {}\n'));
await branch.commit(dev);
rule();
console.log('2. fork() → two divergent working copies, no tree copy:');
console.log('   main copy:  ', dec((await ws.read('src/auth.rs'))!).trim());
console.log('   forked copy:', dec((await branch.read('src/auth.rs'))!).trim());

// Act 3 — grep stops at the capability boundary.
const teammate = Identity.create();
// The teammate writes a secret to `main` WITHOUT granting `dev`.
await log.write('main', 'secrets.env', enc('API_KEY=refresh-me'), teammate);
const fresh = Workspace.open(log, store, { source: 'main', reader: dev });
rule();
console.log('3. grep is bounded by what you can decrypt:');
console.log(
  '   secrets.env in list (cleartext path):',
  (await fresh.list()).includes('secrets.env')
);
console.log('   dev reads secrets.env:', await fresh.read('secrets.env'));
console.log('   grep refresh hits:', await fresh.grep('refresh'));

rule();
console.log(
  'Acceptance: edits enter through the API, never a disk; fork is O(1);'
);
console.log('grep and read stop exactly at the capability boundary.');
