import type { Identity, PublicIdentity } from '@thaddeus.run/identity';
import type { Conflict, HeadRecord, Op, OpLog } from '@thaddeus.run/log';
import { HeadStore, OpLog as OpLogClass, verifyHead } from '@thaddeus.run/log';
import {
  type Backend,
  MemoryStore,
  scoped,
  type Store,
} from '@thaddeus.run/store';

import { blockOnConflict, type LandPolicy, type LandResult } from './policy';

// Process-local counter for unique throwaway dry-run view names.
let landSeq = 0;

// `land` dry-runs each merge on a throwaway view that is never collected (spec
// §11), and views are persisted — so those names would otherwise appear as
// branches. Every internal view lives under this prefix: filter it out of any
// branch listing, and never let a caller create a view inside it.
export const INTERNAL_VIEW_PREFIX = 'land/';

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
  readonly headRecords: HeadStore;

  constructor(name: string, log: OpLog, store: Store, headRecords: HeadStore) {
    this.name = name;
    this.log = log;
    this.store = store;
    this.headRecords = headRecords;
  }

  // A shared view's current heads (P03 passthrough).
  heads(view?: string): readonly string[] {
    return this.log.heads(view);
  }

  // Same-path collisions in a view's reachable set (P03 passthrough).
  conflicts(view?: string): readonly Conflict[] {
    return this.log.conflicts(view);
  }

  // The repo's branches: every named view except `land`'s internal dry-run ones.
  // A branch is a name over a head-set (copy-on-write), never a copy of files.
  branches(): readonly string[] {
    return this.log.views().filter((v) => !v.startsWith(INTERNAL_VIEW_PREFIX));
  }

  // Land a workspace's committed view onto a shared view, gated by policy.
  // Dry-runs the merge on a throwaway view to build the proposal, runs the
  // policy, and re-points `into` ONLY on allow (fail-closed: a rejected landing
  // leaves into's heads unchanged). Local callers may still use a raw re-point;
  // shared callers supply the repository owner's exact signed successor.
  async land(opts: {
    from: string;
    into?: string;
    author?: Identity | PublicIdentity;
    policy?: LandPolicy;
    headRecord?: HeadRecord;
  }): Promise<LandResult> {
    // `author` remains part of the policy proposal; the optional headRecord is
    // separately verified as the owner's authority for a shared projection.
    const into = opts.into ?? 'main';
    const policy = opts.policy ?? blockOnConflict;
    const intoHeads = this.log.heads(into);
    const incomingHeads = this.log.heads(opts.from);
    const mergedHeads = mergeHeads(intoHeads, incomingHeads);

    if (opts.headRecord !== undefined) {
      const record = opts.headRecord;
      const current = this.headRecords.current(into);
      const verified = verifyHead(record);
      if (!verified.ok) {
        throw new TypeError(verified.message);
      }
      if (
        current === undefined ||
        record.repo !== this.name ||
        record.view !== into ||
        record.owner !== this.headRecords.owner ||
        record.version !== current.version + 1 ||
        record.previous !== current.id
      ) {
        throw new TypeError('head record is not the exact signed successor');
      }
      if (
        record.heads.length !== mergedHeads.length ||
        record.heads.some((head, index) => head !== mergedHeads[index])
      ) {
        throw new TypeError('head record does not sign the merged heads');
      }
    }

    // Dry-run on a throwaway view; `into` is untouched until the policy allows.
    // The tmp view is intentionally left in the log's view map (no GC — spec §11 spike non-goal).
    const tmp = `${INTERNAL_VIEW_PREFIX}${into}/${landSeq++}`;
    this.log.view(tmp, mergedHeads);
    const conflicts = this.log.conflicts(tmp);

    // incomingOps = from's closure minus into's closure, in (lamport, id) order.
    const byId = new Map(this.log.ops().map((o) => [o.id, o]));
    const intoClosure = closure(byId, intoHeads);
    const fromClosure = closure(byId, incomingHeads);
    const incomingOps = this.log
      .ops()
      .filter((o) => fromClosure.has(o.id) && !intoClosure.has(o.id));

    // Nothing to land: the source view is unknown, empty, or already merged.
    // Report it rather than re-pointing `into` to an identical head-set and
    // claiming success — a typo'd `from`, or a land() before commit(), would
    // otherwise return landed:true with no diagnostic.
    if (incomingOps.length === 0) {
      return {
        landed: false,
        into,
        heads: [...intoHeads],
        conflicts,
        reason: `no incoming ops: source view "${opts.from}" is empty, unknown, or already landed`,
      };
    }

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
    // Persist signed authority before its derived in-memory/server projection.
    // If a later projection write fails, reopening hydrates it from HeadStore.
    if (opts.headRecord !== undefined) {
      await this.headRecords.advance(opts.headRecord);
    }
    await this.log.repoint(into, mergedHeads);
    return { landed: true, into, heads: [...mergedHeads], conflicts };
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
    const repo = new Repo(name, log, store, new HeadStore(name));
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

  // Fresh durable scope: a backend-backed Store+OpLog, seeds `main`, registers.
  async createDurable(name: string, backend: Backend): Promise<Repo> {
    const existing = this.#repos.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const scopedBackend = scoped(backend, `repo/${name}/`);
    const store = new MemoryStore(scopedBackend);
    const log = new OpLogClass(store, scopedBackend);
    const headRecords = await HeadStore.load(name, scopedBackend);
    log.view('main', []); // empty seed; absence on reload also reads as empty
    const repo = new Repo(name, log, store, headRecords);
    this.#repos.set(name, repo);
    return repo;
  }

  // Re-open a durable scope: Store.open then OpLog.load (order matters), rebuilt.
  async openDurable(name: string, backend: Backend): Promise<Repo> {
    const scopedBackend = scoped(backend, `repo/${name}/`);
    const store = await MemoryStore.open(scopedBackend);
    const log = await OpLogClass.load(store, scopedBackend);
    const headRecords = await HeadStore.load(name, scopedBackend);
    const repo = new Repo(name, log, store, headRecords);
    this.#repos.set(name, repo);
    return repo;
  }
}
