// Persistence demo (@thaddeus.run/persist).
// Run: CI= moon run example-persist:demo
//
// Three acts: (1) a durable edit lands; (2) "restart" — reopen from the same
// directory and the history + content are still there; (3) the cold tier is
// ciphertext, not plaintext.

import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { FileBackend } from '@thaddeus.run/persist';
import { blockOnConflict, Platform } from '@thaddeus.run/platform';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const rule = (): void => console.log('—'.repeat(60));

await ready();
const root = mkdtempSync(join(tmpdir(), 'thaddeus-demo-'));
const dev = Identity.create();

// Act 1 — durable edit.
const a = await new Platform().createDurable('acme/web', new FileBackend(root));
const ws = Workspace.open(a.log, a.store, {
  source: 'main',
  reader: dev,
  name: 'feat',
});
ws.write('src/auth.rs', enc('fn refresh() {}'));
await ws.commit(dev);
const landed = await a.land({
  from: 'feat',
  into: 'main',
  author: dev,
  policy: blockOnConflict,
});
rule();
console.log('1. a durable edit lands — written through to disk:');
console.log('   landed:', landed.landed, '| backend dir:', root);
console.log('   files on disk:', readdirSync(root).length);

// Act 2 — restart.
const b = await new Platform().openDurable('acme/web', new FileBackend(root));
const ref = b.log.materialize('main', dev).get('src/auth.rs')?.ref;
rule();
console.log(
  '2. restart — reopen from the same dir, history + content survive:'
);
console.log(
  '   main has src/auth.rs:',
  b.log.materialize('main').has('src/auth.rs')
);
console.log(
  '   content:',
  ref == null ? '(missing)' : dec(await b.store.get(ref, dev))
);

// Act 3 — the cold tier is ciphertext.
const objFile = readdirSync(root).find((n) => n.includes('obj%2F'));
rule();
console.log('3. the cold tier is ciphertext, not plaintext:');
if (objFile != null) {
  const raw = dec(readFileSync(join(root, objFile)));
  console.log(
    '   raw object on disk contains "fn refresh":',
    raw.includes('fn refresh')
  );
}

rule();
console.log(
  'Acceptance: a repo survives a restart; durable bytes are ciphertext.'
);
