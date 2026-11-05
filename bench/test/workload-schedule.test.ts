import { describe, expect, test } from 'bun:test';

import {
  agentDir,
  FAULT_KINDS,
  generateSchedule,
  type Schedule,
  type Step,
  type WorkloadConfig,
} from '../src/workload/schedule';

const base: WorkloadConfig = {
  seed: 1,
  agents: 4,
  rounds: 5,
  shape: 'hot',
  start: 'cold',
  faults: [...FAULT_KINDS],
  integrators: 1,
};

function steps(schedule: Schedule): Step[] {
  return schedule.agents.flatMap((a) => a.rounds.flat());
}

describe('generateSchedule', () => {
  test('the same config gives the same schedule, another seed another', () => {
    expect(generateSchedule(base)).toEqual(generateSchedule(base));
    expect(generateSchedule({ ...base, seed: 2 })).not.toEqual(
      generateSchedule(base)
    );
  });

  test('hot: every save is followed by an integrate', () => {
    for (const agent of generateSchedule(base).agents) {
      for (const round of agent.rounds) {
        const save = round.findIndex((s) => s.kind === 'save');
        expect(round[save + 1]?.kind).toBe('integrate');
      }
    }
  });

  test('many: no integration and no scope probe; tenant probes hit another tenant', () => {
    const schedule = generateSchedule({ ...base, shape: 'many', seed: 9 });
    const kinds = new Set(steps(schedule).map((s) => s.kind));
    expect(kinds.has('integrate')).toBe(false);
    expect(kinds.has('probe-scope')).toBe(false);
    for (const agent of schedule.agents) {
      for (const step of agent.rounds.flat()) {
        if (step.kind !== 'probe-tenant') continue;
        expect(step.target).not.toBe(agent.agent);
        expect(step.target).toBeGreaterThanOrEqual(0);
        expect(step.target).toBeLessThan(base.agents);
      }
    }
  });

  test('every run probes authority and tenant isolation at least once', () => {
    for (let seed = 0; seed < 50; seed++) {
      const hot = steps(
        generateSchedule({ ...base, seed, agents: 1, rounds: 1 })
      );
      expect(hot.some((s) => s.kind === 'probe-scope')).toBe(true);
      expect(hot.some((s) => s.kind === 'probe-tenant')).toBe(true);
      const many = steps(
        generateSchedule({ ...base, seed, shape: 'many', agents: 2, rounds: 1 })
      );
      expect(many.some((s) => s.kind === 'probe-tenant')).toBe(true);
    }
  });

  test('saves write only inside the agent directory, each with a new token', () => {
    const schedule = generateSchedule(base);
    const tokens: number[] = [];
    for (const agent of schedule.agents) {
      for (const step of agent.rounds.flat()) {
        if (step.kind !== 'save') continue;
        expect(step.edits.length).toBeGreaterThan(0);
        for (const edit of step.edits) {
          expect(edit.path.startsWith(`${agentDir(agent.agent)}/`)).toBe(true);
          tokens.push(edit.token);
        }
      }
    }
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  test('round 0 has no pull, and stale rounds drop the pull that starts them', () => {
    const syncs = (s: Schedule) =>
      steps(s).filter((step) => step.kind === 'sync').length;
    const fresh = generateSchedule({ ...base, faults: [] });
    for (const agent of fresh.agents) {
      expect(agent.rounds[0].some((s) => s.kind === 'sync')).toBe(false);
    }
    expect(syncs(fresh)).toBe(base.agents * (base.rounds - 1));
    expect(
      syncs(generateSchedule({ ...base, faults: ['stale'] }))
    ).toBeLessThan(syncs(fresh));
  });

  test('warm adds one unmeasured round per agent', () => {
    const schedule = generateSchedule({ ...base, start: 'warm' });
    expect(schedule.warmupRounds).toBe(1);
    for (const agent of schedule.agents) {
      expect(agent.rounds).toHaveLength(base.rounds + 1);
    }
  });

  test('faults appear only when enabled', () => {
    const none = generateSchedule({ ...base, faults: [] });
    expect(none.events).toEqual([]);
    expect(none.requests).toEqual({
      duplicateRate: 0,
      delayRate: 0,
      maxDelayMs: 0,
    });
    const kills = generateSchedule({ ...base, faults: ['kill'] });
    expect(kills.events.length).toBeGreaterThan(0);
    expect(kills.events.every((e) => e.kind === 'kill')).toBe(true);
    expect(kills.requests.duplicateRate).toBe(0);
    const all = generateSchedule(base);
    expect(all.events.some((e) => e.kind === 'storage')).toBe(true);
    expect(all.requests.duplicateRate).toBeGreaterThan(0);
    expect(all.requests.delayRate).toBeGreaterThan(0);
  });

  test('fault events are sorted and fire inside the measured actions', () => {
    const schedule = generateSchedule({ ...base, agents: 8, rounds: 10 });
    const after = schedule.events.map((e) => e.afterActions);
    expect(after).toEqual([...after].sort((a, b) => a - b));
    expect(after.every((n) => n >= 1)).toBe(true);
    // 8 agents x 10 rounds is well over 40 actions, so more than one kill.
    expect(
      schedule.events.filter((e) => e.kind === 'kill').length
    ).toBeGreaterThan(1);
  });
});
