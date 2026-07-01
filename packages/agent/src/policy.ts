import type { LandPolicy, LandProposal } from '@thaddeus.run/platform';

import type { AgentRegistry } from './registry';

// Minimal path glob: `**` matches everything; `prefix/**` matches any path under
// `prefix/`; otherwise the glob must equal the path exactly.
function matchGlob(glob: string, path: string): boolean {
  // A path with a `..` segment could escape its delegated prefix once normalized;
  // treat it as matching no glob (fail-closed) rather than trusting startsWith.
  if (path.split('/').includes('..')) {
    return false;
  }
  if (glob === '**') {
    return true;
  }
  if (glob.endsWith('/**')) {
    return path.startsWith(glob.slice(0, -2));
  }
  return glob === path;
}

// Enforcement as a LandPolicy: reject an incoming op whose author is revoked,
// undelegated, out of path-scope, or over budget. Fail-closed (like
// blockOnConflict). Read-only on the registry meter — the caller records spend
// after a successful land.
//
// The optional `exempt` predicate lets the repo owner (who has no delegation
// record) bypass both the scope check and the budget count. An author that
// satisfies `exempt` is skipped in every loop — neither checked nor counted.
// When `exempt` is omitted the behavior is identical to before.
//
// Note: this policy gates EVERY op in `proposal.incomingOps` (the
// source-minus-target closure, spanning all authors on the incoming branch).
// It therefore assumes a single-agent-authored branch — a mixed human/agent
// closure will trip "no delegation" on the human's ops. Compose with other
// policies to handle human or co-authored ops when that arises.
export function delegationPolicy(
  registry: AgentRegistry,
  exempt?: (author: string) => boolean
): LandPolicy {
  return (p: LandProposal) => {
    // Authorization + scope: every incoming op must be permitted (exempt skips).
    for (const op of p.incomingOps) {
      const agent = op.author;
      if (exempt?.(agent) === true) {
        continue;
      }
      if (registry.isRevoked(agent)) {
        return { allow: false, reason: `agent ${agent} is revoked` };
      }
      const d = registry.delegationFor(agent);
      if (d === undefined) {
        return { allow: false, reason: `no delegation for agent ${agent}` };
      }
      if (!d.paths.some((glob) => matchGlob(glob, op.path))) {
        return {
          allow: false,
          reason: `${op.path} is outside ${agent}'s delegated scope`,
        };
      }
    }
    // Budget: project this landing's op count per agent (exempt authors excluded).
    const countByAgent = new Map<string, number>();
    for (const op of p.incomingOps) {
      if (exempt?.(op.author) === true) {
        continue;
      }
      countByAgent.set(op.author, (countByAgent.get(op.author) ?? 0) + 1);
    }
    for (const [agent, count] of countByAgent) {
      const d = registry.delegationFor(agent);
      if (d === undefined) {
        continue; // unreachable: rejected in the loop above
      }
      const u = registry.usage(agent);
      if (u.changes + count > d.maxChanges) {
        return {
          allow: false,
          reason: `agent ${agent} is over its change budget`,
        };
      }
      // Spend is checked retrospectively (no projection) — a change's spend
      // is not known until the caller `record`s it after a successful land.
      if (u.spend >= d.maxSpend) {
        return {
          allow: false,
          reason: `agent ${agent} is over its spend budget`,
        };
      }
    }
    return { allow: true };
  };
}
