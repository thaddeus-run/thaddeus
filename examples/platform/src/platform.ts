// Platform demo for @thaddeus.run/platform (Pillar 06).
// Run: CI= moon run example-platform:demo
//
// Four acts: (1) scopes in one call — createRepo + bare-push open + a fleet
// loop; (2) landing as policy — two branches on different paths both land;
// (3) policy blocks — a same-path conflict is rejected by blockOnConflict, a
// provenance gate rejects an op with no verified "why", a reputation-tier gate
// gates on a proven track record, a test/proof gate requires a verified CI
// check, and a human veto lets a reviewer say no; (4) the mirror property — a
// landed op is ciphertext a public mirror can serve.

import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import {
  blockOnConflict,
  blockOnVeto,
  Platform,
  type Repo,
  requirePassingChecks,
  requireReputationTier,
  requireVerifiedProvenance,
} from '@thaddeus.run/platform';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import { ReputationLog, signContribution } from '@thaddeus.run/reputation';
import { VetoLog } from '@thaddeus.run/review';

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

// Act 3d — a test/proof gate (Pillar 10): merge gated on automated
// verification, not a human reading a diff. A CI checker signs a provenance
// record on an op only when its checks pass; an op with that verified
// attestation lands, an unchecked op is gated.
const svc2 = platform.createRepo('acme/ci');
const prov2 = new ProvenanceLog(svc2.store);
const ci = Identity.create();
const checks = requirePassingChecks(prov2);

const checkedWs = Workspace.open(svc2.log, svc2.store, {
  source: 'main',
  reader: alice,
  name: 'alice/checked',
});
checkedWs.write('src/api.rs', enc('fn api() {}'));
const [checkedOp] = await checkedWs.commit(alice);
if (checkedOp != null) {
  await prov2.record(
    checkedOp,
    {
      intent: 'checks passed',
      reasoning: 'types + tests green',
      actorKind: 'ci',
    },
    ci
  );
}
const checkedLand = await svc2.land({
  from: 'alice/checked',
  author: alice,
  policy: checks,
});

const uncheckedWs = Workspace.open(svc2.log, svc2.store, {
  source: 'main',
  reader: alice,
  name: 'alice/unchecked',
});
uncheckedWs.write('src/raw.rs', enc('fn raw() {}'));
await uncheckedWs.commit(alice);
const uncheckedLand = await svc2.land({
  from: 'alice/unchecked',
  author: alice,
  policy: checks,
});
rule();
console.log(
  '3d. requirePassingChecks — merge gated on automated verification:'
);
console.log(`   with a verified CI check → landed: ${checkedLand.landed}`);
console.log(
  `   no check → landed: ${uncheckedLand.landed} (${uncheckedLand.reason})`
);

// Act 3e — the standing human veto (Pillar 10): the one right that survives the
// automation. A reviewer reads a change and says no; the veto is the ceiling a
// person can always lower, even when no automated gate objects. A forged veto
// would not verify, so it could never deny service.
const core = platform.createRepo('acme/core');
const vetoes = new VetoLog();
const reviewer = Identity.create();
const veto = blockOnVeto(vetoes);

// A clean op lands under the veto policy.
await branch(core, 'alice/clean', 'src/ok.rs', 'fn ok() {}', alice);
const cleanLand = await core.land({
  from: 'alice/clean',
  author: alice,
  policy: veto,
});

// A risky op: the automated gates would pass it, but a human vetoes it.
const riskyWs = Workspace.open(core.log, core.store, {
  source: 'main',
  reader: alice,
  name: 'alice/risky',
});
riskyWs.write('src/secret.rs', enc('const KEY = "sk-live-…";'));
const [riskyOp] = await riskyWs.commit(alice);
if (riskyOp == null) {
  throw new Error('expected a committed op'); // fail loud, not a misleading demo
}
await vetoes.record(
  riskyOp,
  { reason: 'ships a secret in cleartext', at: '2026-07-01T00:00:00Z' },
  reviewer
);
const vetoedLand = await core.land({
  from: 'alice/risky',
  author: alice,
  policy: veto,
});
rule();
console.log('3e. blockOnVeto — a human keeps the standing right to say no:');
console.log(`   un-vetoed op → landed: ${cleanLand.landed}`);
console.log(
  `   vetoed op → landed: ${vetoedLand.landed} (${vetoedLand.reason})`
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
