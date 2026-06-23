import type { Identity } from '@thaddeus.run/identity';
import type { Ref, Store } from '@thaddeus.run/store';

import { type Op, signOp } from './op';

// In-memory operation log. The source of truth is the signed-op DAG; file
// snapshots are derived by materialize(). Spike — not durable, not concurrency
// safe, single process.
export class OpLog {
  readonly #store: Store;
  readonly #ops: Map<string, Op> = new Map();
  readonly #views: Map<string, string[]> = new Map();

  constructor(store: Store) {
    this.#store = store;
  }

  // Record an edit: store the bytes as a capability-gated object, then append a
  // signed op extending `view`'s heads and advance the view to the new op.
  async write(
    view: string,
    path: string,
    bytes: Uint8Array,
    author: Identity
  ): Promise<Op> {
    const ref = await this.#store.put(bytes, author);
    return this.#appendLocal(view, path, ref, author);
  }

  // The shared builder for write/remove: compute lamport from the view's heads,
  // sign, store, advance the view.
  #appendLocal(
    view: string,
    path: string,
    payload: Ref | null,
    author: Identity
  ): Op {
    const parents = this.heads(view);
    const lamport = this.#nextLamport(parents);
    const op = signOp({ path, parents, lamport, payload }, author);
    this.#ops.set(op.id, op);
    this.#views.set(view, [op.id]);
    return op;
  }

  // Root op (no parents) is lamport 0; otherwise 1 + max(parents.lamport).
  #nextLamport(parents: readonly string[]): number {
    if (parents.length === 0) {
      return 0;
    }
    return (
      1 + Math.max(...parents.map((id) => this.#ops.get(id)?.lamport ?? 0))
    );
  }

  // A view's heads, or — with no view — the global frontier: every op that is
  // no other known op's parent (the DAG's sink nodes), deterministic given the
  // op set.
  heads(view?: string): readonly string[] {
    if (view !== undefined) {
      return this.#views.get(view) ?? [];
    }
    const parented = new Set<string>();
    for (const op of this.#ops.values()) {
      for (const p of op.parents) {
        parented.add(p);
      }
    }
    return [...this.#ops.keys()].filter((id) => !parented.has(id));
  }

  // All ops in a deterministic total order: by lamport, then id as a tiebreak.
  ops(): readonly Op[] {
    return [...this.#ops.values()].sort((x, y) => {
      const byLamport = x.lamport - y.lamport;
      if (byLamport !== 0) {
        return byLamport;
      }
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });
  }
}
