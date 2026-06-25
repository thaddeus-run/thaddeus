import type { LandPolicy, LandProposal } from '@thaddeus.run/platform';

import type { AgentRegistry } from './registry';

// Minimal path glob: `**` matches everything; `prefix/**` matches any path under
// `prefix/`; otherwise the glob must equal the path exactly.
function matchGlob(glob: string, path: string): boolean {
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
export function delegationPolicy(registry: AgentRegistry): LandPolicy {
  return (p: LandProposal) => {
    // Authorization + scope: every incoming op must be permitted.
    for (const op of p.incomingOps) {
      const agent = op.author;
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
    // Budget: project this landing's op count per agent against the caps.
    const countByAgent = new Map<string, number>();
    for (const op of p.incomingOps) {
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
