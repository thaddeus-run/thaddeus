// Reputation demo for @thaddeus.run/reputation (Pillar 07).
// Run: CI= moon run example-reputation:demo
//
// Four acts: (1) mint & verify a dual-signed contribution; (2) cross-instance
// honoring — a second instance verifies it with no shared state; (3) the
// verifier catches forgery — a tampered field is not authentic, a self-claimed
// record is authentic-but-not-attested; (4) portability — the same profile is
// computed anywhere.

import { Identity, ready } from '@thaddeus.run/identity';
import {
  type Contribution,
  ReputationLog,
  signContribution,
  verifyContribution,
} from '@thaddeus.run/reputation';

const rule = (): void => console.log('—'.repeat(60));

await ready();
const alice = Identity.create(); // the contributor (subject)
const instanceA = Identity.create(); // the host that attests it happened on A

// Act 1 — mint & verify.
const c = signContribution(
  {
    repo: 'a.example/acme/web',
    ref: 'op-7f2a',
    kind: 'merge',
    at: '2026-06-24T09:00:00.000Z',
  },
  alice,
  instanceA
);
rule();
console.log(
  '1. a dual-signed contribution (alice claims, instance A attests):'
);
console.log('   verify:', verifyContribution(c));

// Act 2 — cross-instance honoring.
const instanceB = new ReputationLog(); // shares no state with A; trusts nothing
instanceB.append(c);
rule();
console.log('2. instance B honors it with no shared state — only the dids:');
console.log('   B.verify:', instanceB.verify(c));
console.log(
  '   B.profile(alice).attested:',
  instanceB.profile(alice.did).attested.length
);

// Act 3 — the verifier catches forgery.
const tampered: Contribution = { ...c, repo: 'evil.example/acme/web' };
const stray = Identity.create();
const claimed: Contribution = {
  ...c,
  host_sig: stray.sign(new Uint8Array([1, 2, 3])),
};
rule();
console.log('3. the verifier catches forgery (no server needed):');
console.log('   tampered repo →', verifyContribution(tampered));
console.log('   self-claimed (bad host_sig) →', verifyContribution(claimed));

// Act 4 — portability: the same records yield the same profile anywhere.
instanceB.append(claimed);
const profile = instanceB.profile(alice.did);
rule();
console.log('4. portability — reputation is the gathered record set:');
console.log(
  '   attested:',
  profile.attested.length,
  '| claimed:',
  profile.claimed.length
);
console.log('   byKind:', profile.byKind);

rule();
console.log('Acceptance: a contribution is verifiable from the dids alone;');
console.log('any instance honors it without trusting the one that relayed it.');
