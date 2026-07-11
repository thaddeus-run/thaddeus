import { type Delegation, verifyDelegation } from './delegation';

// An agent's running totals against its delegation caps.
export interface Usage {
  readonly changes: number;
  readonly spend: number;
}

// The fixed P9 rate-window span. The Delegation field is a count per trailing
// hour, not a configurable window — see the design doc's non-goals.
const HOUR_MS = 3_600_000;

// The enforcement authority: verified delegations + a quarantine set + a
// per-agent meter. Unlike ReputationLog (keep-and-label), this REJECTS invalid
// grants — a forged delegation confers nothing. Spike — in-memory, single
// process.
export class AgentRegistry {
  readonly #grants: Map<string, Delegation> = new Map();
  readonly #quarantine: Set<string> = new Set();
  readonly #meter: Map<string, { changes: number; spend: number }> = new Map();
  // Timestamped landings inside the trailing hour, per agent — the P9 rate
  // window. Pruned lazily on record/read; never persisted (a restart forgets
  // the current hour, documented spike behavior).
  readonly #window: Map<string, { at: number; changes: number }[]> = new Map();
  readonly #now: () => number;

  // The clock is injectable so window expiry is testable without sleeping.
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  // Verify and store a delegation (one active per agent; re-register replaces).
  // Throws TypeError on an invalid delegation. Re-registering replaces the
  // grant but does NOT reset the meter — the budget is a lifetime cap.
  //
  // Revocation is TERMINAL: register does NOT clear quarantine, so a revoked
  // agent stays blocked even if re-registered. Replace a compromised agent
  // with a new identity rather than un-revoking (there is no unrevoke).
  register(d: Delegation): void {
    if (!verifyDelegation(d)) {
      throw new TypeError(
        `refusing to register an invalid delegation for ${d.agent}`
      );
    }
    // Store a FROZEN DEEP COPY: the policy enforces on these fields WITHOUT
    // re-checking the signature, so a caller mutating paths/caps (on the original
    // or on the object delegationFor returns) must not be able to widen an
    // already-verified grant.
    const copy: Delegation = Object.freeze({
      ...d,
      paths: Object.freeze([...d.paths]),
      sig: d.sig.slice(),
    });
    this.#grants.set(d.agent, copy);
  }

  // Quarantine an agent: delegationPolicy then rejects all its ops at land.
  // Revocation is terminal — there is no unrevoke. Replace a compromised agent
  // with a new identity.
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

  // Shared validation + lifetime accumulation for record/replayMeter.
  #accumulate(agent: string, changes: number, spend: number): void {
    if (!this.#grants.has(agent)) {
      throw new TypeError(
        `cannot record usage for unregistered agent ${agent}`
      );
    }
    if (!Number.isInteger(changes) || changes < 0) {
      throw new TypeError('changes must be a non-negative integer');
    }
    if (!Number.isFinite(spend) || spend < 0) {
      throw new TypeError('spend must be a finite number >= 0');
    }
    const u = this.#meter.get(agent) ?? { changes: 0, spend: 0 };
    this.#meter.set(agent, {
      changes: u.changes + changes,
      spend: u.spend + spend,
    });
  }

  // After a successful land: += `changes` (the number of ops landed, matching
  // what delegationPolicy counts) and += spend for the agent. The policy never
  // calls this — recording is the caller's post-land step. Re-registering a
  // delegation does NOT reset the meter (the budget is a lifetime cap).
  record(agent: string, changes: number, spend = 0): void {
    this.#accumulate(agent, changes, spend);
    if (changes > 0) {
      const entries = this.#window.get(agent) ?? [];
      entries.push({ at: this.#now(), changes });
      this.#window.set(agent, this.#prune(entries));
    }
  }

  // Restore persisted lifetime totals WITHOUT window accounting. The server's
  // registry rebuild replays durable meters through this — recording them via
  // record() would stamp an agent's whole history into the current hour and
  // block it until the window slides.
  replayMeter(agent: string, changes: number, spend = 0): void {
    this.#accumulate(agent, changes, spend);
  }

  // Changes landed within the trailing hour (the P9 rate-window numerator).
  recentChanges(agent: string): number {
    const entries = this.#window.get(agent);
    if (entries === undefined) {
      return 0;
    }
    const pruned = this.#prune(entries);
    this.#window.set(agent, pruned);
    return pruned.reduce((sum, e) => sum + e.changes, 0);
  }

  #prune(
    entries: readonly { at: number; changes: number }[]
  ): { at: number; changes: number }[] {
    const cutoff = this.#now() - HOUR_MS;
    return entries.filter((e) => e.at > cutoff);
  }
}
