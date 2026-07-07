import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import type { Workspace } from '@thaddeus.run/fs';

import type { Definition, Edge, Extractor, Reference, Symbol } from './symbol';

// Domain tag for the birth-mint content address, so a symbol id can never
// collide with an op id, provenance hash, or another protocol's digest.
const SYMBOL_DOMAIN = 'thaddeus.graph.symbol.v1';

// The current binding of a symbol — its lookup key. `id` is stable; this moves.
interface Binding {
  readonly path: string;
  readonly name: string;
  readonly kind: Symbol['kind'];
}

const bindingKey = (b: Binding): string =>
  JSON.stringify([b.path, b.name, b.kind]);

// In-memory symbol-identity map: (path,name,kind) ⇆ Symbol.id. Mints an id at
// first sight and RETAINS it across renames (rebind moves the key, keeps the id).
// Spike — not durable, not concurrency-safe.
export class SymbolLedger {
  readonly #byKey: Map<string, string> = new Map();
  readonly #byId: Map<string, Binding> = new Map();

  // The id for a binding, minting it on first sight. Content-addressed at birth
  // → deterministic and test-reproducible.
  mintOrGet(b: Binding): string {
    const key = bindingKey(b);
    const existing = this.#byKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const id = bytesToHex(
      blake3(
        new TextEncoder().encode(
          JSON.stringify([SYMBOL_DOMAIN, b.path, b.name, b.kind])
        )
      )
    );
    this.#byKey.set(key, id);
    // Do not clobber an existing id→binding (a name resurrected after a rename is
    // a known spike edge, spec §11); the first binding for an id wins.
    if (!this.#byId.has(id)) {
      this.#byId.set(id, b);
    }
    return id;
  }

  bindingOf(id: string): Binding | null {
    return this.#byId.get(id) ?? null;
  }

  currentName(id: string): string | null {
    return this.#byId.get(id)?.name ?? null;
  }

  // Move a symbol's binding from its current name to `to`, keeping the same id.
  rebind(id: string, to: string): void {
    const b = this.#byId.get(id);
    if (b === undefined) {
      throw new Error(`unknown symbol ${id}`);
    }
    this.#byKey.delete(bindingKey(b));
    const next: Binding = { path: b.path, name: to, kind: b.kind };
    this.#byKey.set(bindingKey(next), id);
    this.#byId.set(id, next);
  }
}

// A def resolved to its stable id, kept per-file so a reference's enclosing
// caller (the nearest preceding def) can be found.
interface LocalDef {
  readonly id: string;
  readonly name: string;
  readonly kind: Symbol['kind'];
  readonly line: number;
}

// The read/rename surface over a Workspace. Reads re-extract from decryptable
// Workspace text on each call — the capability boundary is inherited from
// Workspace (a null read ⇒ the symbol is invisible). Spike — single process.
export class SymbolGraph {
  protected readonly ws: Workspace;
  readonly #extractor: Extractor;
  protected readonly ledger: SymbolLedger;

  protected constructor(
    ws: Workspace,
    extractor: Extractor,
    ledger: SymbolLedger
  ) {
    this.ws = ws;
    this.#extractor = extractor;
    this.ledger = ledger;
  }

  static over(
    workspace: Workspace,
    opts: { extractor: Extractor; ledger?: SymbolLedger }
  ): SymbolGraph {
    return new SymbolGraph(
      workspace,
      opts.extractor,
      opts.ledger ?? new SymbolLedger()
    );
  }

  // Re-extract the whole decryptable view into a resolved model. Two passes: mint
  // all def ids first (so cross-file references resolve), then resolve refs and
  // build edges, attributing each ref to its enclosing definition (the nearest
  // preceding def in the same file) as the caller.
  async #model(): Promise<{
    defs: Definition[];
    kinds: Map<string, Symbol['kind']>;
    refs: Reference[];
    edges: Edge[];
  }> {
    const defs: Definition[] = [];
    const kinds = new Map<string, Symbol['kind']>();
    const refs: Reference[] = [];
    const edges: Edge[] = [];
    const nameToId = new Map<string, string>();
    const perFile: {
      path: string;
      localDefs: LocalDef[];
      rawRefs: readonly { name: string; line: number }[];
    }[] = [];

    for (const path of await this.ws.list()) {
      const bytes = await this.ws.read(path);
      if (bytes === null) {
        continue; // undecryptable or absent — inherited capability boundary
      }
      const text = new TextDecoder().decode(bytes);
      const raw = this.#extractor.extract(path, text);
      const localDefs: LocalDef[] = [];
      for (const d of raw.defs) {
        const id = this.ledger.mintOrGet({ path, name: d.name, kind: d.kind });
        defs.push({ symbol: id, name: d.name, path, line: d.line });
        kinds.set(id, d.kind);
        localDefs.push({ id, name: d.name, kind: d.kind, line: d.line });
        nameToId.set(d.name, id); // global fallback (last def of a name wins)
      }
      perFile.push({ path, localDefs, rawRefs: raw.refs });
    }

    for (const { path, localDefs, rawRefs } of perFile) {
      const localMap = new Map(localDefs.map((d) => [d.name, d.id] as const));
      for (const r of rawRefs) {
        const calleeId = localMap.get(r.name) ?? nameToId.get(r.name) ?? null;
        if (calleeId === null) {
          continue; // a call to something outside the decryptable view
        }
        refs.push({ symbol: calleeId, path, line: r.line });
        const caller = localDefs
          .filter((d) => d.line <= r.line)
          .sort((a, b) => b.line - a.line)[0];
        if (caller !== undefined) {
          edges.push({ kind: 'calls', from: caller.id, to: calleeId });
          edges.push({ kind: 'references', from: caller.id, to: calleeId });
        }
      }
    }
    return { defs, kinds, refs, edges };
  }

  async symbols(): Promise<readonly Symbol[]> {
    const { defs, kinds } = await this.#model();
    const seen = new Set<string>();
    const out: Symbol[] = [];
    for (const d of [...defs].sort((a, b) => (a.symbol < b.symbol ? -1 : 1))) {
      if (!seen.has(d.symbol)) {
        seen.add(d.symbol);
        out.push({ id: d.symbol, kind: kinds.get(d.symbol) ?? 'function' });
      }
    }
    return out;
  }

  async resolve(name: string): Promise<string | null> {
    const { defs } = await this.#model();
    return defs.find((d) => d.name === name)?.symbol ?? null;
  }

  async resolveAt(path: string, name: string): Promise<string | null> {
    const { defs } = await this.#model();
    return defs.find((d) => d.name === name && d.path === path)?.symbol ?? null;
  }

  async definitionOf(symbolId: string): Promise<Definition | null> {
    const { defs } = await this.#model();
    return defs.find((d) => d.symbol === symbolId) ?? null;
  }

  async referencesTo(symbolId: string): Promise<readonly Reference[]> {
    const { refs } = await this.#model();
    return refs
      .filter((r) => r.symbol === symbolId)
      .sort((a, b) =>
        a.path !== b.path ? (a.path < b.path ? -1 : 1) : a.line - b.line
      );
  }

  async callersOf(symbolId: string): Promise<readonly Symbol[]> {
    const { edges, kinds } = await this.#model();
    const callerIds = new Set(
      edges
        .filter((e) => e.kind === 'calls' && e.to === symbolId)
        .map((e) => e.from)
    );
    return [...callerIds]
      .sort()
      .map((id) => ({ id, kind: kinds.get(id) ?? 'function' }));
  }

  async edges(): Promise<readonly Edge[]> {
    const { edges } = await this.#model();
    return edges;
  }
}
