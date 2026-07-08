import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { type Backend, decodeRecord, encodeRecord } from '@thaddeus.run/store';

import { type SymbolOp, verifySymbolOp } from './symbolop';

// Registry of SymbolOps keyed by Symbol.id. Durable when constructed with a
// `Backend` (write-through + static `load`); in-memory otherwise. Store-free (a
// SymbolOp carries no capability-gated payload). Like ProvenanceLog, an invalid
// record is KEPT and rendered unverifiable rather than rejected: an unverifiable
// structural claim poisons nothing. Spike — not concurrency-safe, single process.
// Note: `forSymbol` order after a durable reopen is content-hash order, not the
// causal rename order (records carry no sequence field yet — spec §11); a single
// rename round-trips exactly.
export class SymbolOpLog {
  readonly #backend: Backend | undefined;
  readonly #bySymbol: Map<string, SymbolOp[]> = new Map();

  constructor(backend?: Backend) {
    this.#backend = backend;
  }

  // Rebuild a durable log from a backend. Records are content-addressed and
  // keep-and-label, so a torn/old-version record that fails to decode is skipped,
  // mirroring ProvenanceLog.load / VetoLog.load.
  static async load(backend: Backend): Promise<SymbolOpLog> {
    const log = new SymbolOpLog(backend);
    for (const key of await backend.list('symop/')) {
      const bytes = await backend.get(key);
      if (bytes === undefined) {
        continue;
      }
      try {
        log.#insert(decodeRecord(bytes) as SymbolOp);
      } catch {
        continue; // torn/old-version/corrupt record — skip, never surface
      }
    }
    return log;
  }

  // Ingest a record IN-MEMORY, deduped on full content so re-appending an
  // identical record is a no-op while any distinct record is kept.
  append(op: SymbolOp): void {
    this.#insert(op);
  }

  // Durably ingest a record from the wire (keep-and-label). Write-through first
  // so a failed backend write leaves no visible-but-non-durable record; then keep
  // in memory. Idempotent (content-addressed key).
  async ingest(op: SymbolOp): Promise<void> {
    await this.#persist(op);
    this.#insert(op);
  }

  // Write-through for a record (no-op without a backend). Content-addressed key
  // `symop/<blake3(contentKey)>`: write-once, so re-persisting an identical
  // record is idempotent and dedup stays consistent with the in-memory #insert.
  async #persist(op: SymbolOp): Promise<void> {
    if (this.#backend !== undefined) {
      const key = `symop/${bytesToHex(
        blake3(new TextEncoder().encode(this.#contentKey(op)))
      )}`;
      await this.#backend.put(key, encodeRecord(op));
    }
  }

  // Store a record under its symbol id, deduped on full content so re-appending
  // an identical record is a no-op while any distinct record is kept.
  #insert(op: SymbolOp): void {
    const list = this.#bySymbol.get(op.symbol) ?? [];
    const key = this.#contentKey(op);
    if (!list.some((e) => this.#contentKey(e) === key)) {
      list.push(op);
      this.#bySymbol.set(op.symbol, list);
    }
  }

  // A total identity key over every field, so a forged record reusing a genuine
  // signature still gets a distinct key and is kept alongside it (see the
  // provenancelog rationale).
  #contentKey(op: SymbolOp): string {
    return JSON.stringify([
      op.id,
      op.kind,
      op.symbol,
      op.from,
      op.to,
      op.base,
      op.author,
      bytesToHex(op.sig),
    ]);
  }

  // The signed structural records for a symbol, in **insertion order** — for the
  // single-process spike that is the order the renames were applied (causal
  // order), so `history()` reads as a meaningful sequence. Unlike
  // `ProvenanceLog.forOp` (an unordered set of claims about one op), this returns
  // an ordered chain of renames. Cross-peer convergence — once records are
  // ingested over a wire out of order — needs an explicit causal/sequence field
  // or the `SymbolOp.base` chain, and is deferred (spec §11).
  forSymbol(symbolId: string): readonly SymbolOp[] {
    return [...(this.#bySymbol.get(symbolId) ?? [])];
  }

  // Every known SymbolOp across all symbols, in a deterministic order (by symbol
  // id, then per-symbol insertion order). Since SymbolOps are keyed by symbol —
  // not by a P03 op — the wire carries the repo's whole structural history, so a
  // clone can render `history()` for any symbol offline.
  all(): readonly SymbolOp[] {
    return [...this.#bySymbol.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .flatMap(([, list]) => list);
  }

  // Signature + id integrity over the record. Whether the symbol/op it targets
  // actually exists is the graph's concern, not this check.
  verify(op: SymbolOp): boolean {
    return verifySymbolOp(op);
  }
}
