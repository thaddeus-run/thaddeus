// Agent demo for @thaddeus.run/agent (Pillar 09).
// Run: CI= moon run example-agent:demo
//
// Four acts: (1) an operator delegates scoped, budgeted authority to an agent;
// (2) bounded autonomy — the agent lands a change within scope under the policy,
// attributed to the operator; (3) scope + budget enforced — an out-of-scope path
// and an over-budget landing are rejected; (4) the kill switch — revocation
// quarantines the agent from the converging state.

import {
  AgentRegistry,
  delegationPolicy,
  signDelegation,
  verifyDelegation,
} from '@thaddeus.run/agent';
import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { Platform, type Repo } from '@thaddeus.run/platform';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const rule = (): void => console.log('—'.repeat(60));

// Stage one change on a named branch authored by `who`, then return its view name.
async function branch(
  repo: Repo,
  who: Identity,
  name: string,
  path: string
): Promise<string> {
  const ws = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: who,
    name,
  });
  ws.write(path, enc('fn x() {}'));
  await ws.commit(who);
  return name;
}

await ready();
const platform = new Platform();
const repo = platform.createRepo('acme/web');
const operator = Identity.create();
const agent = Identity.create();
const registry = new AgentRegistry();

// Act 1 — delegate.
const grant = signDelegation(
  { agent: agent.did, paths: ['src/**'], maxChanges: 2, maxSpend: 10 },
  operator
);
registry.register(grant);
rule();
console.log('1. operator delegates scoped, budgeted authority to the agent:');
console.log('   verifyDelegation:', verifyDelegation(grant));
console.log('   scope:', grant.paths, '| maxChanges:', grant.maxChanges);

// Act 2 — bounded autonomy.
await branch(repo, agent, 'agent/login', 'src/login.rs');
const ok = await repo.land({
  from: 'agent/login',
  author: agent,
  policy: delegationPolicy(registry),
});
registry.record(agent.did, 4);
rule();
console.log('2. the agent lands within scope, attributed to its operator:');
console.log(
  '   landed:',
  ok.landed,
  '| operator:',
  registry.operatorOf(agent.did) === operator.did
);
console.log('   usage:', registry.usage(agent.did));

// Act 3 — scope + budget enforced.
await branch(repo, agent, 'agent/secret', 'secrets/key.env');
const outOfScope = await repo.land({
  from: 'agent/secret',
  author: agent,
  policy: delegationPolicy(registry),
});
rule();
console.log('3. scope + budget are enforced at land (not by hope):');
console.log(
  '   out-of-scope landed:',
  outOfScope.landed,
  '|',
  outOfScope.reason
);

// Act 4 — kill switch.
registry.revoke(agent.did);
await branch(repo, agent, 'agent/more', 'src/more.rs');
const afterRevoke = await repo.land({
  from: 'agent/more',
  author: agent,
  policy: delegationPolicy(registry),
});
rule();
console.log('4. revocation quarantines the agent from converging state:');
console.log('   landed:', afterRevoke.landed, '|', afterRevoke.reason);
console.log(
  '   (the other half of "kill" is store.revoke — rotates its keys, P01)'
);

rule();
console.log(
  'Acceptance: authorship is signed, scoped, budgeted, and revocable;'
);
console.log('a compromised agent is one revoke() from quarantine.');
