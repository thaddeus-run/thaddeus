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
// author has at least `minMerges` unique merges from an explicitly trusted
// host. Valid foreign-host proofs remain visible but cannot unlock the gate.
export function requireReputationTier(
  reps: ReputationLog,
  minMerges: number,
  trustedHosts: ReadonlySet<string>
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
      (op) => reps.profile(op.author, trustedHosts).byKind.merge < minMerges
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
  // Fail fast on a misconfigured allowlist: an empty `reviewers` array means no
  // reviewer can ever match, so every veto is ignored and the gate becomes a
  // silent always-pass — the opposite of a veto's intent. To accept any
  // reviewer's veto, OMIT `reviewers` (undefined); passing `[]` is a mistake, so
  // reject it at construction, mirroring requireReputationTier's guard.
  if (reviewers !== undefined && reviewers.length === 0) {
    throw new RangeError(
      'blockOnVeto: reviewers must be a non-empty allowlist, or omitted to accept any reviewer'
    );
  }
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

// Minimal path glob, mirroring @thaddeus.run/agent's delegationPolicy matcher:
// `**` matches everything; `prefix/**` matches any path under `prefix/`;
// otherwise the glob must equal the path exactly. A `..` segment fails closed.
function matchGlob(glob: string, path: string): boolean {
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

function assertSupportedPathGlob(glob: string, label: string): void {
  if (!glob.includes('*')) {
    return;
  }
  if (glob === '**') {
    return;
  }
  if (glob.endsWith('/**')) {
    const prefix = glob.slice(0, -3);
    if (prefix.length > 0 && !prefix.includes('*')) {
      return;
    }
  }
  throw new RangeError(
    `${label} supports only exact paths, **, and prefix/** globs`
  );
}

// Policy as a standing query (Pillar 11): express an invariant as a predicate
// over the proposed change and let the substrate enforce it AS changes converge
// — not a CI script that runs late. `forbid` returns true for an op that
// violates the invariant; the landing is rejected if any incoming op does. The
// building block restrictPaths and any bespoke rule compose over this.
export function standingQuery(opts: {
  name: string;
  forbid: (op: Op) => boolean;
}): LandPolicy {
  if (opts.name.length === 0) {
    throw new RangeError('standingQuery: name must be a non-empty string');
  }
  return (p) => {
    const violations = p.incomingOps.filter((op) => opts.forbid(op));
    return violations.length === 0
      ? { allow: true }
      : {
          allow: false,
          reason: `standing query "${opts.name}": ${violations.length} op(s) violate the invariant`,
        };
  };
}

// The manifesto's headline standing query — "no untrusted agent may modify auth
// code" — as an enforced land invariant: reject a landing where an incoming op
// touches a PROTECTED path (glob) unless its author is in the `allow` set. Not a
// late CI check but an invariant the substrate holds as changes converge.
export function restrictPaths(opts: {
  protect: readonly string[];
  allow: readonly string[];
  name?: string;
}): LandPolicy {
  if (opts.protect.length === 0) {
    throw new RangeError(
      'restrictPaths: protect must be a non-empty list of path globs'
    );
  }
  // A `..` segment in a protect glob can never match a normal path, so it would
  // silently protect nothing — reject it at construction (like the other guards).
  if (opts.protect.some((glob) => glob.split('/').includes('..'))) {
    throw new RangeError(
      'restrictPaths: a protect glob must not contain a ".." segment'
    );
  }
  for (const glob of opts.protect) {
    assertSupportedPathGlob(glob, 'restrictPaths: protect');
  }
  const allow = new Set(opts.allow);
  const name = opts.name ?? `protect ${opts.protect.join(', ')}`;
  return standingQuery({
    name,
    // Fail CLOSED on a traversal path: a `..` path could normalize into a
    // protected location downstream (a git gateway, a filesystem export), so an
    // untrusted author may not land it — treat it as protected. `matchGlob`
    // rejects a `..` path (returns false), which for this BLACKLIST check would
    // fail OPEN, so the traversal test must come first, not rely on matchGlob.
    forbid: (op) =>
      (op.path.split('/').includes('..') ||
        opts.protect.some((glob) => matchGlob(glob, op.path))) &&
      !allow.has(op.author),
  });
}
