import type { Conflict, OpLog } from '@thaddeus.run/log';
import { OpLog as OpLogClass } from '@thaddeus.run/log';
import { MemoryStore, type Store } from '@thaddeus.run/store';

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
