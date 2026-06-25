import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import type { Op } from '@thaddeus.run/log';
import type { LandProposal } from '@thaddeus.run/platform';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { signDelegation } from '../src/delegation';
import { delegationPolicy } from '../src/policy';
import { AgentRegistry } from '../src/registry';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// A LandProposal carrying exactly `ops` as the incoming set (other fields are
// unused by delegationPolicy).
function proposal(ops: readonly Op[]): LandProposal {
  return {
    into: 'main',
    intoHeads: [],
    incomingHeads: [],
    mergedHeads: [],
    incomingOps: ops,
    conflicts: [],
  };
}

// Produce a real signed op authored by `agent` at `path`.
async function op(agent: Identity, path: string): Promise<Op> {
  const log = new OpLog(new MemoryStore());
  return log.write('main', path, enc('x'), agent);
}

describe('delegationPolicy', () => {
  test('allows an in-scope op within budget', async () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(
      signDelegation(
        { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 100 },
        operator
      )
    );
    const decision = await delegationPolicy(reg)(
      proposal([await op(agent, 'src/auth.rs')])
    );
    expect(decision.allow).toBe(true);
  });

  test('rejects an op on a path outside the delegated scope', async () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(
      signDelegation(
        { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 100 },
        operator
      )
    );
    const decision = await delegationPolicy(reg)(
      proposal([await op(agent, 'secrets/key.env')])
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('secrets/key.env');
  });

  test('rejects an op from an undelegated agent', async () => {
    const agent = Identity.create();
    const reg = new AgentRegistry();
    const decision = await delegationPolicy(reg)(
      proposal([await op(agent, 'src/a.rs')])
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('no delegation');
  });

  test('rejects when landing would exceed maxChanges', async () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(
      signDelegation(
        { agent: agent.did, paths: ['src/**'], maxChanges: 1, maxSpend: 100 },
        operator
      )
    );
    reg.record(agent.did, 1); // usage.changes = 1, already at cap
    const decision = await delegationPolicy(reg)(
      proposal([await op(agent, 'src/a.rs')])
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('budget');
  });

  test('rejects when spend is at or over maxSpend', async () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(
      signDelegation(
        { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 5 },
        operator
      )
    );
    reg.record(agent.did, 1, 5); // usage.spend = 5 >= maxSpend
    const decision = await delegationPolicy(reg)(
      proposal([await op(agent, 'src/a.rs')])
    );
    expect(decision.allow).toBe(false);
  });

  test('rejects every op from a quarantined agent', async () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(
      signDelegation(
        { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 100 },
        operator
      )
    );
    reg.revoke(agent.did);
    const decision = await delegationPolicy(reg)(
      proposal([await op(agent, 'src/a.rs')])
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('revoked');
  });

  test('rejects a path that escapes scope via a .. segment', async () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(
      signDelegation(
        { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 100 },
        operator
      )
    );
    const decision = await delegationPolicy(reg)(
      proposal([await op(agent, 'src/../secrets/key.env')])
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('outside');
  });

  test('is read-only on the meter (dry-run safe)', async () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(
      signDelegation(
        { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 100 },
        operator
      )
    );
    const p = proposal([await op(agent, 'src/a.rs')]);
    await delegationPolicy(reg)(p);
    await delegationPolicy(reg)(p);
    expect(reg.usage(agent.did)).toEqual({ changes: 0, spend: 0 });
  });
});
