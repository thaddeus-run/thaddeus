// Server demo (@thaddeus.run/server).
// Run: CI= moon run example-server:demo
//
// Boots a live server over a temp FileBackend, then: Client A creates a repo,
// commits locally, pushes, and lands; a fresh client clones via pull and reads
// the decrypted content; a non-owner push is rejected; a raw pulled object is
// shown to be ciphertext.

import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { FileBackend } from '@thaddeus.run/persist';
import {
  type Bundle,
  createServer,
  decodeBundle,
  encodeBundle,
  signRequest,
} from '@thaddeus.run/server';
import { MemoryStore } from '@thaddeus.run/store';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const rule = (): void => console.log('—'.repeat(60));

await ready();
const root = mkdtempSync(join(tmpdir(), 'thaddeus-server-demo-'));
const srv = createServer({ backend: new FileBackend(root) });
const http = Bun.serve({ port: 0, fetch: srv.fetch });
const base = `http://localhost:${http.port}`;

const a = Identity.create();
const b = Identity.create();

const post = (
  path: string,
  bodyObj: unknown,
  signer: Identity
): Promise<Response> => {
  const body = enc(JSON.stringify(bodyObj));
  const h = signRequest('POST', path, body, signer, new Date().toISOString());
  return fetch(`${base}${path}`, {
    method: 'POST',
    body,
    headers: {
      'x-thaddeus-did': h.did,
      'x-thaddeus-timestamp': h.timestamp,
      'x-thaddeus-nonce': h.nonce,
      'x-thaddeus-signature': h.signature,
    },
  });
};

// Client A commits locally and pushes + lands.
await post('/repos', { name: 'acme/web' }, a);
const store = new MemoryStore();
const log = new OpLog(store);
const ws = Workspace.open(log, store, {
  source: 'main',
  reader: a,
  name: 'feat',
});
ws.write('src/auth.rs', enc('fn refresh() {}'));
await ws.commit(a);
const objects = [];
const caps = [];
for (const op of log.ops()) {
  const pid = op.payload?.plaintext_id;
  if (pid !== undefined) {
    const cur = store.current(pid);
    if (cur !== undefined) {
      objects.push(cur);
      caps.push(...store.caps(pid));
    }
  }
}
await post('/repos/acme%2Fweb/push', encodeBundle(log.ops(), objects, caps), a);
const landed = (await (
  await post(
    '/repos/acme%2Fweb/land',
    { fromHeads: [...log.heads('feat')], into: 'main' },
    a
  )
).json()) as { landed: boolean };
rule();
console.log(
  '1. Client A: commit → push → land over HTTP:',
  'landed =',
  landed.landed
);

// A non-owner push is rejected.
const forbidden = await post(
  '/repos/acme%2Fweb/push',
  { ops: [], objects: [], caps: [] },
  b
);
rule();
console.log('2. A non-owner (B) push is rejected:', forbidden.status, '(403)');

// A fresh client clones and reads.
const pulled = decodeBundle(
  (await (
    await fetch(`${base}/repos/acme%2Fweb/pull?view=main`)
  ).json()) as Bundle
);
const cstore = new MemoryStore();
const clog = new OpLog(cstore);
for (const o of pulled.objects) {
  await cstore.ingest(
    o,
    pulled.caps.filter((cp) => cp.object === o.plaintext_id)
  );
}
for (const o of pulled.ops) {
  await clog.ingest(o);
}
// Reconstruct the 'main' view: OpLog.ingest populates the op DAG but does NOT
// set named views. The pulled closure's global frontier equals the landed heads,
// so pointing 'main' at clog.heads() gives us the correct materialization root.
clog.view('main', clog.heads());
const ref = clog.materialize('main', a).get('src/auth.rs')?.ref;
rule();
console.log(
  '3. A fresh client clones and decrypts:',
  ref == null ? '(missing)' : dec(await cstore.get(ref, a))
);

// The pulled object is ciphertext.
rule();
console.log(
  '4. The pulled object is ciphertext, not plaintext:',
  !dec(pulled.objects[0].ciphertext).includes('fn refresh')
);

await http.stop(true);
rule();
console.log(
  'Acceptance: push/land/clone over HTTP; server holds no repository decryption keys; ciphertext on the wire.'
);
