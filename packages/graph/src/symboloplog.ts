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

  // The signed structural history of a symbol, in a deterministic order (by
  // author, then signature bytes, then full content) independent of insertion.
  forSymbol(symbolId: string): readonly SymbolOp[] {
    return [...(this.#bySymbol.get(symbolId) ?? [])].sort((a, b) => {
      if (a.author !== b.author) {
        return a.author < b.author ? -1 : 1;
      }
      const sa = bytesToHex(a.sig);
      const sb = bytesToHex(b.sig);
      if (sa !== sb) {
        return sa < sb ? -1 : 1;
      }
      const ka = this.#contentKey(a);
      const kb = this.#contentKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  // Signature + id integrity over the record. Whether the symbol/op it targets
  // actually exists is the graph's concern, not this check.
  verify(op: SymbolOp): boolean {
    return verifySymbolOp(op);
  }
}
