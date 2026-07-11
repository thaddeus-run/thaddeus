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

  test('an exempt author bypasses delegation and budget', async () => {
    const owner = Identity.create();
    const agent = Identity.create();
    const registry = new AgentRegistry();
    // agent is delegated only to src/**, maxChanges 1; owner has NO delegation.
    registry.register(
      signDelegation(
        { agent: agent.did, paths: ['src/**'], maxChanges: 1, maxSpend: 100 },
        owner
      )
    );
    const policy = delegationPolicy(registry, (a) => a === owner.did);

    // Owner op on any path, no delegation, no budget → allowed.
    const ownerOp = await op(owner, 'anywhere/x');
    expect((await policy(proposal([ownerOp]))).allow).toBe(true);

    // Non-owner op still requires an in-scope delegation.
    const stranger = Identity.create();
    const strangerOp = await op(stranger, 'anywhere/x');
    expect((await policy(proposal([strangerOp]))).allow).toBe(false);
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

  describe('hourly rate window (P9)', () => {
    test('rejects a landing that exceeds the cap inside the window, allows it after the window slides', async () => {
      const operator = Identity.create();
      const agent = Identity.create();
      let t = 1_000_000;
      const reg = new AgentRegistry(() => t);
      reg.register(
        signDelegation(
          {
            agent: agent.did,
            paths: ['src/**'],
            maxChanges: 100,
            maxSpend: 100,
            maxChangesPerHour: 2,
          },
          operator
        )
      );
      const policy = delegationPolicy(reg);
      // Two ops land and are recorded — the window is now full.
      reg.record(agent.did, 2);
      const third = proposal([await op(agent, 'src/a.rs')]);
      const rejected = await policy(third);
      expect(rejected.allow).toBe(false);
      expect(rejected).toMatchObject({
        reason: `agent ${agent.did} is over its hourly rate window`,
      });
      // An hour later the window is empty; the same landing is allowed.
      t += 61 * 60_000;
      expect((await policy(third)).allow).toBe(true);
    });

    test('lifetime and hourly caps compose; a null cap never rate-limits', async () => {
      const operator = Identity.create();
      const capped = Identity.create();
      const uncapped = Identity.create();
      let t = 1_000_000;
      const reg = new AgentRegistry(() => t);
      // Lifetime nearly exhausted, hourly cap generous → lifetime trips first.
      reg.register(
        signDelegation(
          {
            agent: capped.did,
            paths: ['**'],
            maxChanges: 1,
            maxSpend: 100,
            maxChangesPerHour: 10,
          },
          operator
        )
      );
      reg.record(capped.did, 1);
      const lifetime = await delegationPolicy(reg)(
        proposal([await op(capped, 'src/a.rs')])
      );
      expect(lifetime.allow).toBe(false);
      expect(lifetime).toMatchObject({
        reason: `agent ${capped.did} is over its change budget`,
      });
      // No hourly cap → heavy recent usage does not rate-limit.
      reg.register(
        signDelegation(
          {
            agent: uncapped.did,
            paths: ['**'],
            maxChanges: 100,
            maxSpend: 100,
          },
          operator
        )
      );
      reg.record(uncapped.did, 50);
      expect(
        (
          await delegationPolicy(reg)(
            proposal([await op(uncapped, 'src/a.rs')])
          )
        ).allow
      ).toBe(true);
    });

    test('an exempt author skips the hourly window', async () => {
      const owner = Identity.create();
      let t = 1_000_000;
      const reg = new AgentRegistry(() => t);
      const policy = delegationPolicy(reg, (a) => a === owner.did);
      expect(
        (await policy(proposal([await op(owner, 'src/a.rs')]))).allow
      ).toBe(true);
    });
  });
});
