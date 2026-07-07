import type {
  Definition,
  Reference,
  Symbol,
  SymbolGraph,
} from '@thaddeus.run/graph';
import type { Op, OpLog } from '@thaddeus.run/log';
import type { Provenance, ProvenanceLog } from '@thaddeus.run/provenance';

// The signed "why" behind a change: the provenance records bound to an op, plus
// the op itself and a convenience `verified` flag — true when AT LEAST ONE bound
// record's signature checks out. (Provenance is keep-and-label: a peer can
// attach an unsigned/forged claim, so requiring *every* record to verify would
// let one such claim poison a genuine why. Matches P04's "an unverifiable why
// poisons nothing.") Pillar 11's --why surface.
export interface Why {
  readonly opId: string;
  readonly op: Op | null;
  readonly why: readonly Provenance[];
  readonly verified: boolean;
}

// A caller of a symbol, joined with where it is currently defined.
export interface Caller {
  readonly symbol: Symbol;
  readonly definition: Definition | null;
}

// A caller-supplied time bound must be a parseable ISO-8601 instant — reject
// junk loudly rather than silently matching nothing.
function instant(label: string, at: string): number {
  const t = Date.parse(at);
  if (Number.isNaN(t)) {
    throw new RangeError(`${label} must be an ISO-8601 timestamp: ${at}`);
  }
  return t;
}

// Parse a STORED op's `at` leniently: a single unparseable record must not throw
// the whole query (a bad row shouldn't poison every temporal query), so it is
// simply excluded from time-window results. Normal ops always carry a valid,
// signed `at` (op.ts asserts it), so this only guards the degenerate case.
function opInstant(at: string): number | null {
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

// The live query surface (Pillar 11, query slice). A read-only facade that JOINS
// the four first-class dimensions the substrate already stores — the semantic
// graph (P08), operation-log history with wall-clock time (P03), provenance
// (P04), and capabilities (P01) — into cross-cutting answers. No new signed
// records; every method is a pure read. The graph half is decryption-bounded
// (inherited from the Workspace the SymbolGraph was built over); op metadata
// (path, author, `at`) is cleartext by P03 design. Spike — in-memory, single
// process, full re-derive per query.
export class CodeDB {
  readonly #graph: SymbolGraph;
  readonly #log: OpLog;
  readonly #provenance: ProvenanceLog;

  private constructor(
    graph: SymbolGraph,
    log: OpLog,
    provenance: ProvenanceLog
  ) {
    this.#graph = graph;
    this.#log = log;
    this.#provenance = provenance;
  }

  static over(opts: {
    graph: SymbolGraph;
    log: OpLog;
    provenance: ProvenanceLog;
  }): CodeDB {
    return new CodeDB(opts.graph, opts.log, opts.provenance);
  }

  // The --why behind an op: its provenance records + the op + a `verified` flag
  // that is true when at least one bound record's signature checks out (a forged
  // or unsigned peer claim alongside a genuine why does not flip it to false —
  // keep-and-label, per P04).
  why(opId: string): Why {
    const why = this.#provenance.forOp(opId);
    const op = this.#log.ops().find((o) => o.id === opId) ?? null;
    const verified = why.some((p) => this.#provenance.status(p) === 'verified');
    return { opId, op, why, verified };
  }

  // Every op authored at or after `at`, in the log's deterministic (lamport, id)
  // order. "All code an untrusted agent touched in the last hour" — filter with
  // `by()` for a specific principal.
  touchedSince(at: string): readonly Op[] {
    const lo = instant('at', at);
    return this.#log.ops().filter((o) => {
      const t = opInstant(o.at);
      return t !== null && t >= lo;
    });
  }

  // Every op authored within the inclusive window [from, to].
  touchedBetween(from: string, to: string): readonly Op[] {
    const lo = instant('from', from);
    const hi = instant('to', to);
    return this.#log.ops().filter((o) => {
      const t = opInstant(o.at);
      return t !== null && t >= lo && t <= hi;
    });
  }

  // Every op a principal (did) authored, optionally within a time window.
  by(did: string, window?: { from?: string; to?: string }): readonly Op[] {
    const lo =
      window?.from === undefined ? undefined : instant('from', window.from);
    const hi = window?.to === undefined ? undefined : instant('to', window.to);
    return this.#log.ops().filter((o) => {
      if (o.author !== did) {
        return false;
      }
      const t = opInstant(o.at);
      return (
        t !== null &&
        (lo === undefined || t >= lo) &&
        (hi === undefined || t <= hi)
      );
    });
  }

  // Who currently calls a symbol, joined with where each caller is defined — the
  // present-state form of "every function that still calls this deprecated API".
  async callers(symbolId: string): Promise<readonly Caller[]> {
    const callers = await this.#graph.callersOf(symbolId);
    return Promise.all(
      callers.map(async (symbol) => ({
        symbol,
        definition: await this.#graph.definitionOf(symbol.id),
      }))
    );
  }

  // Every use-site of a symbol, addressed by its current name.
  async references(name: string): Promise<readonly Reference[]> {
    const id = await this.#graph.resolve(name);
    return id === null ? [] : this.#graph.referencesTo(id);
  }
}
