import { bytesToHex } from '@noble/hashes/utils';

import { type SymbolOp, verifySymbolOp } from './symbolop';

// In-memory registry of SymbolOps keyed by Symbol.id. Spike — not durable, not
// concurrency-safe. Like ProvenanceLog, an invalid record is KEPT and rendered
// unverifiable rather than rejected: an unverifiable structural claim poisons
// nothing.
export class SymbolOpLog {
  readonly #bySymbol: Map<string, SymbolOp[]> = new Map();

  // Ingest a record, deduped on full content so re-appending an identical record
  // is a no-op while any distinct record is kept.
  append(op: SymbolOp): void {
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

  // Signature + id integrity over the record. Whether the symbol/op it targets
  // actually exists is the graph's concern, not this check.
  verify(op: SymbolOp): boolean {
    return verifySymbolOp(op);
  }
}
