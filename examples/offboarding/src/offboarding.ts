// Offboarding demo for @thaddeus.run/store (Pillar 01).
// Run: CI= moon run offboarding:demo
//
// The .env / "fire someone" story: a secret is only ever ciphertext at rest,
// access is a key sealed to an identity, and offboarding is one key rotation.

import { Identity, ready } from '@thaddeus.run/identity';
import { address, MemoryStore } from '@thaddeus.run/store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const hex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
const rule = (): void => console.log('—'.repeat(60));

await ready();
const store = new MemoryStore();
const alice = Identity.create();
const bob = Identity.create();

console.log('Alice:', alice.did);
console.log('Bob:  ', bob.did);
rule();

const secret = 'DATABASE_URL=postgres://app:hunter2@db.internal/prod';
const ref = await store.put(enc(secret), alice);
console.log('1. Alice stored a secret. object id =', `${ref.id.slice(0, 16)}…`);

const raw = store.rawObject(ref.id)!;
console.log('2. Stored bytes (first 32):', hex(raw.ciphertext.slice(0, 32)));
console.log(
  '   contains "postgres"?',
  dec(raw.ciphertext).includes('postgres')
);
console.log(
  '3. Mirror verifies blake3(ciphertext) === id without a key:',
  address(raw.ciphertext) === ref.id
);
rule();

try {
  await store.get(ref, bob);
} catch (err) {
  console.log(
    '4. Bob reads it:',
    (err as Error).name,
    '(holds only ciphertext)'
  );
}

await store.grant(ref, bob.toPublic(), alice);
console.log(
  '5. Alice grants Bob. Bob reads:',
  JSON.stringify(dec(await store.get(ref, bob)))
);
rule();

const t0 = performance.now();
await store.revoke(ref, bob.toPublic(), alice);
console.log(
  `6. Fire Bob → revoke (key rotation) took ${(performance.now() - t0).toFixed(1)} ms`
);
try {
  await store.get(ref, bob);
} catch (err) {
  console.log(
    '   Bob now:',
    (err as Error).name,
    '— his old key opens nothing'
  );
}
console.log(
  '   Alice still reads:',
  JSON.stringify(dec(await store.get(ref, alice)))
);
rule();
console.log(
  'zero plaintext at rest · access = a sealed key · offboarding = one rotation'
);
