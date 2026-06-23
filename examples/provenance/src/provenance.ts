// Provenance demo for @thaddeus.run/provenance (Pillar 04).
// Run: CI= moon run example-provenance:demo
//
// Three acts: (1) a signed "why" on a real op (P12 completed); (2) the trust
// rule — tamper → unverified, kept not dropped; (3) the prompt does not leak —
// only its hash + address are public, the bytes are capability-gated.

import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import { MemoryStore } from '@thaddeus.run/store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const rule = (): void => console.log('—'.repeat(60));

await ready();
const store = new MemoryStore();
const log = new OpLog(store);
const prov = new ProvenanceLog(store);

// An agent's operator (the human) and the agent identity that signs the why.
const operator = Identity.create();
const agent = Identity.create();

// Act 1 — a signed why on a real op.
const op = await log.write(
  'main',
  'src/auth.rs',
  enc('fn refresh() {}'),
  operator
);
const why = await prov.record(
  op,
  {
    intent: 'fix race in token refresh',
    reasoning: 'refresh() re-entered before lock; added a mutex',
    actorKind: 'agent:claude-code@1.2',
    task: 'STRATA-417',
    prompt: enc(
      'PROMPT: patch the token refresh race. context: <secret repo map>'
    ),
  },
  agent
);

rule();
console.log(`$ strata log src/auth.rs --why`);
console.log(
  `  @@ refresh() … (Op ${op.id.slice(0, 4)}, lamport ${op.lamport})`
);
console.log(
  `  actor   ${why.actor_kind}  (operator: ${operator.did.slice(0, 16)}…)   ${
    prov.status(why) === 'verified' ? '✓ verified' : '✗ unverified'
  }`
);
console.log(`  intent  ${why.intent}        task  ${why.task}`);

// Act 2 — the trust rule: tamper → unverified (and the record is KEPT).
// The forged record replaces the reasoning AND clears the sig (all-zero bytes)
// to avoid dedup on (actor, sig) — the point is that the *content* is wrong
// and therefore the sig no longer verifies, not that the sig bytes are reused.
const forged = {
  ...why,
  reasoning: 'a plausible lie that was never signed',
  sig: new Uint8Array(64),
};
prov.append(forged);
rule();
console.log('2. tamper the reasoning → status:', prov.status(forged));
console.log(
  '   records kept for this op (verified + unverified both shown):',
  prov.forOp(op.id).map((p) => prov.status(p))
);

// Act 3 — the prompt does not leak: only the hash + Ref are public.
rule();
console.log('3. public record carries only a hash + address for the prompt:');
console.log('   prompt_ref:', why.prompt_ref?.slice(0, 16), '…');
console.log(
  '   prompt Ref:',
  why.prompt?.id.slice(0, 16),
  '… (ciphertext address)'
);
if (why.prompt !== null) {
  // The agent (grantee) can read it back.
  console.log(
    '   agent reads prompt:',
    JSON.stringify(dec(await store.get(why.prompt, agent)))
  );
  // A stranger cannot.
  const stranger = Identity.create();
  let denied = false;
  try {
    await store.get(why.prompt, stranger);
  } catch {
    denied = true;
  }
  console.log('   stranger denied the prompt:', denied);
}

rule();
console.log('Acceptance: signed why bound to Op.id; tamper → unverified;');
console.log(
  'prompt stored capability-gated — its bytes never enter readable history.'
);
