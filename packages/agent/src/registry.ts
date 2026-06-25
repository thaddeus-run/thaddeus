import { type Delegation, verifyDelegation } from './delegation';

// An agent's running totals against its delegation caps.
export interface Usage {
  readonly changes: number;
  readonly spend: number;
}

// The enforcement authority: verified delegations + a quarantine set + a
// per-agent meter. Unlike ReputationLog (keep-and-label), this REJECTS invalid
// grants — a forged delegation confers nothing. Spike — in-memory, single
// process.
export class AgentRegistry {
  readonly #grants: Map<string, Delegation> = new Map();
  readonly #quarantine: Set<string> = new Set();
  readonly #meter: Map<string, { changes: number; spend: number }> = new Map();

  // Verify and store a delegation (one active per agent; re-register replaces).
  // Throws TypeError on an invalid delegation. Re-registering replaces the
  // grant but does NOT reset the meter — the budget is a lifetime cap.
  register(d: Delegation): void {
    if (!verifyDelegation(d)) {
      throw new TypeError(
        `refusing to register an invalid delegation for ${d.agent}`
      );
    }
    this.#grants.set(d.agent, d);
  }

  // Quarantine an agent: delegationPolicy then rejects all its ops at land.
  revoke(agent: string): void {
    this.#quarantine.add(agent);
  }

  isRevoked(agent: string): boolean {
    return this.#quarantine.has(agent);
  }

  // The active (verified) delegation for an agent, or undefined.
  delegationFor(agent: string): Delegation | undefined {
    return this.#grants.get(agent);
  }

  // Attribution: the operator did the agent acts for, or undefined.
  operatorOf(agent: string): string | undefined {
    return this.#grants.get(agent)?.operator;
  }

  // Metered totals (default { changes: 0, spend: 0 }).
  usage(agent: string): Usage {
    const u = this.#meter.get(agent);
    return u === undefined
      ? { changes: 0, spend: 0 }
      : { changes: u.changes, spend: u.spend };
  }

  // After a successful land: +1 change and += spend for the agent. The policy
  // never calls this — recording is the caller's post-land step.
  record(agent: string, spend = 0): void {
    const u = this.#meter.get(agent) ?? { changes: 0, spend: 0 };
    this.#meter.set(agent, { changes: u.changes + 1, spend: u.spend + spend });
  }
}
