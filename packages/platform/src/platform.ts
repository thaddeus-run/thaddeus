import type { Identity } from '@thaddeus.run/identity';
import type { Conflict, Op, OpLog } from '@thaddeus.run/log';
import { OpLog as OpLogClass } from '@thaddeus.run/log';
import { MemoryStore, type Store } from '@thaddeus.run/store';

import { blockOnConflict, type LandPolicy, type LandResult } from './policy';

// Process-local counter for unique throwaway dry-run view names.
let landSeq = 0;

// Sorted, de-duplicated union of two head-sets — the proposed merged frontier.
// Sorted so the result is independent of which side is `into` vs `from`.
function mergeHeads(
  a: readonly string[],
  b: readonly string[]
): readonly string[] {
  return [...new Set([...a, ...b])].sort();
}

// Every op reachable from `heads` by walking parents, inclusive of the heads.
// Deliberately re-implements an ancestor walk from the public log.ops()/Op.parents
// surface — the log package's own #ancestorClosure is private; the spec forbids
// changing the log package.
function closure(byId: Map<string, Op>, heads: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...heads];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const op = byId.get(id);
    if (op !== undefined) {
      stack.push(...op.parents);
    }
  }
  return seen;
}

// A named home: its own op-log + store and a seeded `main` shared view. The
// @thaddeus.run/fs Workspace opens over repo.log/repo.store unchanged. Spike —
// in-memory, single process, not durable, not concurrency-safe.
export class Repo {
  readonly name: string;
  readonly log: OpLog;
  readonly store: Store;

  constructor(name: string, log: OpLog, store: Store) {
    this.name = name;
    this.log = log;
    this.store = store;
  }

  // A shared view's current heads (P03 passthrough).
  heads(view?: string): readonly string[] {
    return this.log.heads(view);
  }

  // Same-path collisions in a view's reachable set (P03 passthrough).
  conflicts(view?: string): readonly Conflict[] {
    return this.log.conflicts(view);
  }

  // Land a workspace's committed view onto a shared view, gated by policy.
  // Dry-runs the merge on a throwaway view to build the proposal, runs the
  // policy, and re-points `into` ONLY on allow (fail-closed: a rejected landing
  // leaves into's heads unchanged). Signs nothing — the ops were already signed
  // by the workspace's commit (P05); landing is one re-point under a gate.
  async land(opts: {
    from: string;
    into?: string;
    author: Identity;
    policy?: LandPolicy;
  }): Promise<LandResult> {
    // `author` is part of the public landing interface (Pillar 10 review gates will use it); land itself signs nothing and only re-points a view.
    const into = opts.into ?? 'main';
    const policy = opts.policy ?? blockOnConflict;
    const intoHeads = this.log.heads(into);
    const incomingHeads = this.log.heads(opts.from);
    const mergedHeads = mergeHeads(intoHeads, incomingHeads);

    // Dry-run on a throwaway view; `into` is untouched until the policy allows.
    // The tmp view is intentionally left in the log's view map (no GC — spec §11 spike non-goal).
    const tmp = `land/${into}/${landSeq++}`;
    this.log.view(tmp, mergedHeads);
    const conflicts = this.log.conflicts(tmp);

    // incomingOps = from's closure minus into's closure, in (lamport, id) order.
    const byId = new Map(this.log.ops().map((o) => [o.id, o]));
    const intoClosure = closure(byId, intoHeads);
    const fromClosure = closure(byId, incomingHeads);
    const incomingOps = this.log
      .ops()
      .filter((o) => fromClosure.has(o.id) && !intoClosure.has(o.id));

    const decision = await policy({
      into,
      intoHeads,
      incomingHeads,
      mergedHeads,
      incomingOps,
      conflicts,
    });
    if (!decision.allow) {
      return {
        landed: false,
        into,
        heads: [...intoHeads],
        conflicts,
        reason: decision.reason,
      };
    }
    // The single re-point that IS the landing.
    this.log.view(into, mergedHeads);
    return { landed: true, into, heads: mergedHeads, conflicts };
  }
}

// The platform: scopes come into being in one call (P11). A scope is a Repo.
export class Platform {
  readonly #repos: Map<string, Repo> = new Map();

  // Allocate a scope in one call (~ms, no wizard). Idempotent: re-creating an
  // existing name returns the existing repo. Seeds an empty `main` view.
  createRepo(name: string): Repo {
    const existing = this.#repos.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const store = new MemoryStore();
    const log = new OpLogClass(store);
    log.view('main', []); // seed an explicit, empty shared view
    const repo = new Repo(name, log, store);
    this.#repos.set(name, repo);
    return repo;
  }

  // Return the repo, auto-vivifying it if absent — the "a bare push brings the
  // scope into being" trick. A fleet stands up thousands in a loop, one call
  // each.
  open(name: string): Repo {
    return this.#repos.get(name) ?? this.createRepo(name);
  }

  // The scope registry, in deterministic (sorted) order.
  repos(): readonly string[] {
    return [...this.#repos.keys()].sort();
  }
}
