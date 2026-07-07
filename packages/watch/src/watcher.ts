import type { Reference, SymbolGraph } from '@thaddeus.run/graph';

// A semantic event — a change in *meaning*, derived by diffing two graph
// snapshots. Every event names the `symbol` (its stable id) it concerns.
export type SemanticEvent =
  | {
      readonly kind: 'defined';
      readonly symbol: string;
      readonly name: string;
      readonly path: string;
    }
  | { readonly kind: 'removed'; readonly symbol: string; readonly name: string }
  | {
      readonly kind: 'renamed';
      readonly symbol: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly kind: 'moved';
      readonly symbol: string;
      readonly from: { readonly path: string; readonly line: number };
      readonly to: { readonly path: string; readonly line: number };
    }
  | {
      readonly kind: 'references-changed';
      readonly symbol: string;
      readonly added: readonly Reference[];
      readonly removed: readonly Reference[];
    };

export type EventKind = SemanticEvent['kind'];

// A standing subscription: which events its holder cares about. `symbol`
// undefined = any symbol; `kinds` undefined = any kind.
export interface Filter {
  readonly symbol?: string;
  readonly kinds?: readonly EventKind[];
}

// Per-symbol state captured in a snapshot — enough to diff name, location, and
// the reference set.
interface SymbolState {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly refs: readonly Reference[];
}

type Snapshot = Map<string, SymbolState>;

// A reference's identity for set diffing: its site (path + line).
const refKey = (r: Reference): string => `${r.path}:${r.line}`;

// Re-derive the whole decryptable graph into a snapshot keyed by stable symbol
// id. Inherits the graph's decryption boundary (undecryptable symbols are
// simply absent).
async function snapshot(graph: SymbolGraph): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  for (const sym of await graph.symbols()) {
    const def = await graph.definitionOf(sym.id);
    if (def === null) {
      continue;
    }
    snap.set(sym.id, {
      name: def.name,
      path: def.path,
      line: def.line,
      refs: await graph.referencesTo(sym.id),
    });
  }
  return snap;
}

// The set difference of two reference lists, by site.
function diffRefs(
  before: readonly Reference[],
  after: readonly Reference[]
): { added: Reference[]; removed: Reference[] } {
  const b = new Set(before.map(refKey));
  const a = new Set(after.map(refKey));
  return {
    added: after.filter((r) => !b.has(refKey(r))),
    removed: before.filter((r) => !a.has(refKey(r))),
  };
}

// Diff two snapshots into semantic events. A symbol id present in both with a
// changed name is a rename (identity survives — P08); a changed def site is a
// move; a changed reference set is references-changed. Ids only in `after` are
// defined; ids only in `before` are removed.
function diff(before: Snapshot, after: Snapshot): SemanticEvent[] {
  const events: SemanticEvent[] = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    if (b === undefined) {
      events.push({ kind: 'defined', symbol: id, name: a.name, path: a.path });
      continue;
    }
    if (b.name !== a.name) {
      events.push({ kind: 'renamed', symbol: id, from: b.name, to: a.name });
    }
    if (b.path !== a.path || b.line !== a.line) {
      events.push({
        kind: 'moved',
        symbol: id,
        from: { path: b.path, line: b.line },
        to: { path: a.path, line: a.line },
      });
    }
    const { added, removed } = diffRefs(b.refs, a.refs);
    if (added.length > 0 || removed.length > 0) {
      events.push({ kind: 'references-changed', symbol: id, added, removed });
    }
  }
  for (const [id, b] of before) {
    if (!after.has(id)) {
      events.push({ kind: 'removed', symbol: id, name: b.name });
    }
  }
  return events;
}

function matches(filter: Filter, e: SemanticEvent): boolean {
  if (filter.symbol !== undefined && e.symbol !== filter.symbol) {
    return false;
  }
  if (filter.kinds !== undefined && !filter.kinds.includes(e.kind)) {
    return false;
  }
  return true;
}

// Per-subscription event queues, kept off the Subscription object so the handle
// stays opaque (no internal push method leaks onto the public type).
const queues = new WeakMap<Subscription, SemanticEvent[]>();

// An opaque subscription handle. `take()` drains the events that have matched
// this subscription since the last take.
export class Subscription {
  readonly filter: Filter;

  constructor(filter: Filter) {
    this.filter = filter;
    queues.set(this, []);
  }

  take(): readonly SemanticEvent[] {
    const q = queues.get(this) ?? [];
    const out = [...q];
    q.length = 0;
    return out;
  }
}

// Subscribe to semantic events over a SymbolGraph by diffing snapshots. Spike —
// in-memory, single process, pull-based: events surface on `poll()`, not via a
// background loop or push transport.
export class SemanticWatcher {
  readonly #graph: SymbolGraph;
  #baseline: Snapshot;
  readonly #subs: Set<Subscription> = new Set();

  private constructor(graph: SymbolGraph, baseline: Snapshot) {
    this.#graph = graph;
    this.#baseline = baseline;
  }

  // Capture the initial baseline snapshot. Events are measured against it (and
  // then each successive poll).
  static async over(graph: SymbolGraph): Promise<SemanticWatcher> {
    return new SemanticWatcher(graph, await snapshot(graph));
  }

  // Register a standing subscription for events matching `filter`.
  watch(filter: Filter = {}): Subscription {
    const sub = new Subscription(filter);
    this.#subs.add(sub);
    return sub;
  }

  // Stop delivering to a subscription.
  unwatch(sub: Subscription): void {
    this.#subs.delete(sub);
  }

  // Re-derive the graph, diff it against the baseline, advance the baseline, and
  // dispatch each event to every subscription whose filter it matches. Returns
  // all events (whether or not any subscription matched). Fire on meaning.
  async poll(): Promise<readonly SemanticEvent[]> {
    const after = await snapshot(this.#graph);
    const events = diff(this.#baseline, after);
    this.#baseline = after;
    for (const e of events) {
      for (const sub of this.#subs) {
        if (matches(sub.filter, e)) {
          queues.get(sub)?.push(e);
        }
      }
    }
    return events;
  }
}
