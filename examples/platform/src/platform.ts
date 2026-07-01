// Platform demo for @thaddeus.run/platform (Pillar 06).
// Run: CI= moon run example-platform:demo
//
// Four acts: (1) scopes in one call — createRepo + bare-push open + a fleet
// loop; (2) landing as policy — two branches on different paths both land;
// (3) policy blocks — a same-path conflict is rejected by blockOnConflict, and
// a provenance gate rejects an op with no verified "why"; (4) the mirror
// property — a landed op is ciphertext a public mirror can serve.

import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import {
  blockOnConflict,
  Platform,
  type Repo,
  requireReputationTier,
  requireVerifiedProvenance,
} from '@thaddeus.run/platform';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import { ReputationLog, signContribution } from '@thaddeus.run/reputation';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const rule = (): void => console.log('—'.repeat(60));

// Open a named, landable branch over a repo, stage one write, commit it.
async function branch(
  repo: Repo,
  name: string,
  path: string,
  body: string,
  author: Identity
): Promise<void> {
  const ws = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: author,
    name,
  });
  ws.write(path, enc(body));
  await ws.commit(author);
}

await ready();
const platform = new Platform();
const alice = Identity.create();
const bob = Identity.create();

// Act 1 — scopes in one call.
const web = platform.createRepo('acme/web');
platform.open('acme/agent-run-8f2a'); // bare-push: brought into being by reference
for (const id of ['8f2a', '9c1b', 'a4d3']) {
  platform.open(`fleet/run-${id}`);
}
rule();
console.log('1. scopes created in code — one call each, no wizard:');
console.log('   repos:', platform.repos());

// Act 2 — landing as policy (clean, different paths).
await branch(web, 'alice/login', 'src/login.rs', 'fn login() {}', alice);
await branch(web, 'bob/signup', 'src/signup.rs', 'fn signup() {}', bob);
const la = await web.land({
  from: 'alice/login',
  author: alice,
  policy: blockOnConflict,
});
const lb = await web.land({
  from: 'bob/signup',
  author: bob,
  policy: blockOnConflict,
});
rule();
console.log('2. two branches land cleanly under blockOnConflict:');
console.log(`   alice landed: ${la.landed}, bob landed: ${lb.landed}`);
console.log(
  '   main now holds:',
  [...web.log.materialize('main').keys()].sort()
);

// Act 3a — policy blocks a same-path conflict.
const api = platform.createRepo('acme/api');
await branch(api, 'alice/rate', 'src/rate.rs', 'fn rate() { 100 }', alice);
await branch(api, 'bob/rate', 'src/rate.rs', 'fn rate() { 200 }', bob);
const first = await api.land({
  from: 'alice/rate',
  author: alice,
  policy: blockOnConflict,
});
const second = await api.land({
  from: 'bob/rate',
  author: bob,
  policy: blockOnConflict,
});
rule();
console.log('3a. a same-path conflict is rejected (fail-closed):');
console.log(
  `   first landed: ${first.landed}; second landed: ${second.landed}`
);
console.log(`   reason: ${second.reason}`);

// Act 3b — a provenance gate.
const docs = platform.createRepo('acme/docs');
const wd = Workspace.open(docs.log, docs.store, {
  source: 'main',
  reader: alice,
  name: 'alice/readme',
});
wd.write('README.md', enc('# Strata'));
const [readmeOp] = await wd.commit(alice);
const prov = new ProvenanceLog(docs.store);
const gate = requireVerifiedProvenance(prov);
const noWhy = await docs.land({
  from: 'alice/readme',
  author: alice,
  policy: gate,
});
if (readmeOp != null) {
  await prov.record(
    readmeOp,
    {
      intent: 'add README',
      reasoning: 'docs',
      actorKind: 'agent:claude-code@1.2',
    },
    alice
  );
}
const withWhy = await docs.land({
  from: 'alice/readme',
  author: alice,
  policy: gate,
});
rule();
console.log('3b. requireVerifiedProvenance — merge gated on a signed "why":');
console.log(`   no provenance → landed: ${noWhy.landed} (${noWhy.reason})`);
console.log(`   with a verified record → landed: ${withWhy.landed}`);

// Act 3c — a reputation-tier gate (Pillar 10): merge gated on a proven track
// record, not a human reading a diff. A senior author (3 attested merges)
// lands; a newcomer (0 attested merges) is gated.
const svc = platform.createRepo('acme/svc');
const reps = new ReputationLog();
const attester = Identity.create();
for (let i = 0; i < 3; i++) {
  reps.append(
    signContribution(
      {
        repo: 'acme/svc',
        ref: `merge-${i}`,
        kind: 'merge',
        at: '2026-07-01T00:00:00Z',
      },
      alice,
      attester
    )
  );
}
const tier = requireReputationTier(reps, 3);

const seniorWs = Workspace.open(svc.log, svc.store, {
  source: 'main',
  reader: alice,
  name: 'alice/feat',
});
seniorWs.write('src/feat.rs', enc('fn feat() {}'));
await seniorWs.commit(alice);
const seniorLand = await svc.land({
  from: 'alice/feat',
  author: alice,
  policy: tier,
});

const newcomer = Identity.create();
const newcomerWs = Workspace.open(svc.log, svc.store, {
  source: 'main',
  reader: newcomer,
  name: 'newcomer/feat',
});
newcomerWs.write('src/other.rs', enc('fn other() {}'));
await newcomerWs.commit(newcomer);
const newcomerLand = await svc.land({
  from: 'newcomer/feat',
  author: newcomer,
  policy: tier,
});
rule();
console.log('3c. requireReputationTier — merge gated on proven track record:');
console.log(`   senior (3 attested merges) → landed: ${seniorLand.landed}`);
console.log(
  `   newcomer (0) → landed: ${newcomerLand.landed} (${newcomerLand.reason})`
);

// Act 4 — the mirror property.
rule();
console.log('4. a landed op is ciphertext a public mirror can serve:');
if (readmeOp?.payload != null) {
  console.log(
    '   store.verify(payload):',
    docs.store.verify(readmeOp.payload.id)
  );
}
if (readmeOp != null) {
  console.log('   publicView kind:', docs.log.publicView(readmeOp.id).kind);
}

rule();
console.log('Acceptance: scopes are one call; landing is a re-point under a');
console.log('policy that fails closed; the landed op stays mirror-servable.');
