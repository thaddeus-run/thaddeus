// Coordinated-disclosure demo for @thaddeus.run/store (Pillar 02 — the membrane).
// Run: CI= moon run disclosure:demo
//
// One CVE, private merge to public reveal: the fix is ciphertext at rest, sits
// on an untrusted mirror the whole embargo, and becomes world-readable at a
// scheduled time T via a key-release — not a flag flip, not a scramble.

import { Identity, ready } from '@thaddeus.run/identity';
import {
  address,
  MemoryStore,
  publicDid,
  publicIdentity,
} from '@thaddeus.run/store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const hex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
const rule = (): void => console.log('—'.repeat(60));

await ready();
const store = new MemoryStore();
const maintainer = Identity.create();

const REVEAL_AT = '2026-07-05T00:00:00.000Z'; // the disclosure deadline T
const beforeT = '2026-07-01T00:00:00.000Z';

const patch = 'fix(auth): constant-time token compare — CVE-2026-1234';
const ref = await store.put(enc(patch), maintainer);
console.log(
  '1. Maintainer commits the fix. object id =',
  `${ref.id.slice(0, 16)}…`
);

const raw = store.rawObject(ref.id)!;
console.log('2. Stored bytes (first 32):', hex(raw.ciphertext.slice(0, 32)));
console.log(
  '   mirror verifies blake3(ciphertext) === id, no key:',
  address(raw.ciphertext) === ref.id
);
rule();

await store.scheduleReveal(ref, REVEAL_AT, maintainer);
console.log('3. Reveal scheduled for', REVEAL_AT);
console.log(
  '   served capability wrapped to public yet?',
  store.caps(ref.plaintext_id).some((c) => c.grantee === publicDid()),
  '← withheld: the mirror holds only ciphertext'
);
rule();

try {
  await store.get(ref, publicIdentity(), beforeT);
} catch (err) {
  console.log('4. Public reads before T:', (err as Error).name);
}

console.log(
  '5. At T, public reads:',
  JSON.stringify(dec(await store.get(ref, publicIdentity(), REVEAL_AT)))
);
console.log(
  '   served capability wrapped to public now?',
  store.caps(ref.plaintext_id).some((c) => c.grantee === publicDid()),
  '← key-release fired'
);
rule();
console.log(
  'ciphertext on the mirror the whole embargo · reveal = a scheduled key-release the maintainer owns'
);
