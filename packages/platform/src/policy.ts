import type { Conflict, Op } from '@thaddeus.run/log';
import type { ProvenanceLog } from '@thaddeus.run/provenance';
import type { ReputationLog } from '@thaddeus.run/reputation';
import type { VetoLog } from '@thaddeus.run/review';

// A proposed landing, computed on a dry-run view before any policy decision.
export interface LandProposal {
  readonly into: string; // the shared target view (e.g. 'main')
  readonly intoHeads: readonly string[]; // target heads before the landing
  readonly incomingHeads: readonly string[]; // the source view's heads
  readonly mergedHeads: readonly string[]; // sorted(dedup(into ∪ from))
  readonly incomingOps: readonly Op[]; // from's closure minus into's, ordered
  readonly conflicts: readonly Conflict[]; // same-path collisions in the merged set
}

// A policy's verdict on a proposal. `reason` surfaces in LandResult on reject.
export interface LandDecision {
  readonly allow: boolean;
  readonly reason?: string;
}

// The policy seam: the exact point Pillar 10 fills with review/reputation gates.
export type LandPolicy = (
  p: LandProposal
) => LandDecision | Promise<LandDecision>;

// The outcome of a land() call. `landed === false` ⇒ `into` is untouched.
export interface LandResult {
  readonly landed: boolean;
  readonly into: string;
  readonly heads: readonly string[]; // into's heads after (unchanged if rejected)
  readonly conflicts: readonly Conflict[];
  readonly reason?: string; // the policy's reason when landed === false
}

// Always allow. Any conflict is left for LWW to resolve and conflicts() to show.
export const allowAll: LandPolicy = () => ({ allow: true });

// The safe default: reject a landing that would collide on a path, leaving the
// target clean. Names the colliding paths in the reason.
export const blockOnConflict: LandPolicy = (p) =>
  p.conflicts.length === 0
    ? { allow: true }
    : {
        allow: false,
        reason: `${p.conflicts.length} conflict(s): ${p.conflicts
          .map((c) => c.path)
          .join(', ')}`,
      };

// A taste of Pillar 10: merge gated on a signed "why", not a human reading a
// diff. Allow iff EVERY incoming op has at least one verified P04 record.
export function requireVerifiedProvenance(prov: ProvenanceLog): LandPolicy {
  return (p) => {
    const missing = p.incomingOps.filter(
      (op) => !prov.forOp(op.id).some((rec) => prov.status(rec) === 'verified')
    );
    return missing.length === 0
      ? { allow: true }
      : {
          allow: false,
          reason: `${missing.length} op(s) lack a verified provenance record`,
        };
  };
}

// A reputation-tier gate (Pillar 10): merge is a function of proven
// contribution, not a human reading a diff. Allow iff EVERY incoming op's
// author has at least `minMerges` ATTESTED merges — P07 counts only the
// host-vouched set, so self-claimed reputation can never unlock the gate.
export function requireReputationTier(
  reps: ReputationLog,
  minMerges: number
): LandPolicy {
  // Fail fast on a misconfigured tier: since `byKind.merge` is always >= 0, a
  // negative threshold would silently pass every author (a no-op gate). Reject
  // it at construction so a mistyped tier surfaces immediately, not in prod.
  if (!Number.isInteger(minMerges) || minMerges < 0) {
    throw new RangeError(
      `requireReputationTier: minMerges must be a non-negative integer, got ${minMerges}`
    );
  }
  return (p) => {
    const below = p.incomingOps.filter(
      (op) => reps.profile(op.author).byKind.merge < minMerges
    );
    return below.length === 0
      ? { allow: true }
      : {
          allow: false,
          reason: `${below.length} op(s) authored below the required tier (${minMerges} attested merge(s))`,
        };
  };
}

// A test/proof gate (Pillar 10): merge gated on automated verification, not a
// human reading a diff. A checker — CI, a property-check harness, a proof
// engine — signs a provenance record on an op only when its checks pass, so a
// VERIFIED record from a checker IS the proof. This narrows
// requireVerifiedProvenance from "any verified why" to "a verified why from a
// checker": allow iff EVERY incoming op carries at least one verified provenance
// record whose actor_kind names a checker. `checkerKinds` defaults to ['ci'];
// an unverified record, or a verified record from a non-checker, never counts.
export function requirePassingChecks(
  prov: ProvenanceLog,
  checkerKinds: readonly string[] = ['ci']
): LandPolicy {
  // Fail fast on a misconfigured gate: an empty `checkerKinds` set means no
  // actor_kind can ever match, so the gate would block every landing — and its
  // reason string would read "…lack a verified check from " with nothing after
  // "from". Reject it at construction so the mistake surfaces immediately,
  // mirroring requireReputationTier's guard.
  if (checkerKinds.length === 0) {
    throw new RangeError(
      'requirePassingChecks: checkerKinds must be a non-empty list of checker actor kinds'
    );
  }
  const kinds = new Set(checkerKinds);
  return (p) => {
    const missing = p.incomingOps.filter(
      (op) =>
        !prov
          .forOp(op.id)
          .some(
            (rec) =>
              kinds.has(rec.actor_kind) && prov.status(rec) === 'verified'
          )
    );
    return missing.length === 0
      ? { allow: true }
      : {
          allow: false,
          reason: `${missing.length} op(s) lack a verified check from ${[
            ...kinds,
          ].join('/')}`,
        };
  };
}

// The standing human veto (Pillar 10): a reviewer keeps the right to say no to
// any change, even one a green policy would merge. Reject iff ANY incoming op
// carries a verified standing veto — from an allowed reviewer, when `reviewers`
// is given; from anyone, when it is omitted. Composed in the floor via all(...),
// which is an AND, a veto overrides every green gate: automation sets the floor,
// the veto is the ceiling a person can always lower. An unverified veto never
// blocks, so a forged veto cannot deny service.
export function blockOnVeto(
  vetoes: VetoLog,
  reviewers?: readonly string[]
): LandPolicy {
  const allowed = reviewers === undefined ? undefined : new Set(reviewers);
  return (p) => {
    const vetoed = p.incomingOps.filter((op) =>
      vetoes
        .forOp(op.id)
        .some(
          (v) =>
            vetoes.status(v) === 'verified' &&
            (allowed === undefined || allowed.has(v.reviewer))
        )
    );
    return vetoed.length === 0
      ? { allow: true }
      : {
          allow: false,
          reason: `${vetoed.length} op(s) under a standing veto`,
        };
  };
}
