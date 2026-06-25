import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { type Delegation, signDelegation } from '../src/delegation';
import { AgentRegistry } from '../src/registry';

beforeAll(async () => {
  await ready();
});

function grant(operator: Identity, agent: Identity): Delegation {
  return signDelegation(
    { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 100 },
    operator
  );
}

describe('AgentRegistry', () => {
  test('register stores a verified delegation; delegationFor / operatorOf resolve it', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(grant(operator, agent));
    expect(reg.delegationFor(agent.did)?.operator).toBe(operator.did);
    expect(reg.operatorOf(agent.did)).toBe(operator.did);
    expect(reg.operatorOf('did:key:zUnknown')).toBeUndefined();
  });

  test('register throws on an invalid (forged) delegation', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const stray = Identity.create();
    // Forge: keep the operator did but replace the sig with a stray key's.
    const forged: Delegation = {
      ...grant(operator, agent),
      sig: stray.sign(new Uint8Array([1, 2, 3])),
    };
    const reg = new AgentRegistry();
    expect(() => reg.register(forged)).toThrow();
    expect(reg.delegationFor(agent.did)).toBeUndefined();
  });

  test('revoke quarantines an agent', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(grant(operator, agent));
    expect(reg.isRevoked(agent.did)).toBe(false);
    reg.revoke(agent.did);
    expect(reg.isRevoked(agent.did)).toBe(true);
  });

  test('usage starts at zero; record increments changes and spend', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    reg.register(grant(operator, agent)); // uses the existing `grant` helper
    expect(reg.usage(agent.did)).toEqual({ changes: 0, spend: 0 });
    reg.record(agent.did, 2, 4);
    reg.record(agent.did, 1);
    expect(reg.usage(agent.did)).toEqual({ changes: 3, spend: 4 });
  });

  test('register stores a frozen copy — mutating the input cannot widen the grant', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    const d = signDelegation(
      { agent: agent.did, paths: ['src/**'], maxChanges: 5, maxSpend: 100 },
      operator
    );
    reg.register(d);
    // Mutating the caller's original array must not affect the stored grant.
    (d.paths as string[]).push('**');
    expect(reg.delegationFor(agent.did)?.paths).toEqual(['src/**']);
    // The stored grant is frozen: attempting to mutate it throws or is a no-op.
    const stored = reg.delegationFor(agent.did);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.paths)).toBe(true);
  });

  test('record rejects an unregistered agent and poison values', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const reg = new AgentRegistry();
    expect(() => reg.record('did:key:zNope', 1)).toThrow();
    reg.register(grant(operator, agent));
    expect(() => reg.record(agent.did, -1)).toThrow();
    expect(() => reg.record(agent.did, 1.5)).toThrow();
    expect(() => reg.record(agent.did, 1, -5)).toThrow();
  });
});
