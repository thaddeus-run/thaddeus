import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import type { Workspace } from '@thaddeus.run/fs';
import type { Identity } from '@thaddeus.run/identity';
import type { Op } from '@thaddeus.run/log';

import type { Definition, Edge, Extractor, Reference, Symbol } from './symbol';
import { signSymbolOp, type SymbolOp } from './symbolop';
import { SymbolOpLog } from './symboloplog';

// Domain tag for the birth-mint content address, so a symbol id can never
// collide with an op id, provenance hash, or another protocol's digest.
const SYMBOL_DOMAIN = 'thaddeus.graph.symbol.v1';

// Thrown when a rename's expected `from` name no longer matches the symbol's
// current binding — the symbol moved under the caller. No text is written.
export class StaleRename extends Error {
  constructor(symbolId: string, expected: string, actual: string | null) {
    super(
      `stale rename of ${symbolId}: expected current name ${expected}, found ${actual}`
    );
    this.name = 'StaleRename';
  }
}

// Escape a bare identifier for use inside a RegExp. Identifiers are
// [A-Za-z0-9_], so this is defensive; it keeps the helper honest if the
// character set ever widens.
function escapeIdent(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  readonly #ops: SymbolOpLog;

  protected constructor(
    ws: Workspace,
    extractor: Extractor,
    ledger: SymbolLedger,
    ops: SymbolOpLog
  ) {
    this.ws = ws;
    this.#extractor = extractor;
    this.ledger = ledger;
    this.#ops = ops;
  }

  static over(
    workspace: Workspace,
    opts: { extractor: Extractor; ledger?: SymbolLedger; ops?: SymbolOpLog }
  ): SymbolGraph {
    return new SymbolGraph(
      workspace,
      opts.extractor,
      opts.ledger ?? new SymbolLedger(),
      opts.ops ?? new SymbolOpLog()
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

  // Rename a symbol as ONE signed SymbolOp rendered across the def and every
  // reference. Order (spec §4.2): resolve current binding → staleness guard →
  // mint+record SymbolOp → rewrite each occurrence via Workspace.write + one
  // commit → rebind the ledger. Returns the semantic op and the rendered P03 ops.
  async rename(
    symbolId: string,
    newName: string,
    author: Identity
  ): Promise<{ readonly symbolOp: SymbolOp; readonly ops: readonly Op[] }> {
    // (1) Current binding + the live occurrence set from a fresh extraction.
    const from = this.ledger.currentName(symbolId);
    const def = await this.definitionOf(symbolId);
    // (2) Staleness guard: the ledger's name must still match what the text says.
    // If the symbol moved under us (text changed, or an unknown id), reject
    // before writing anything.
    if (from === null || def === null || def.name !== from) {
      throw new StaleRename(symbolId, from ?? '(unknown)', def?.name ?? null);
    }
    // A rename to the symbol's current name is a no-op — reject it rather than
    // mint a from===to op and an empty commit.
    if (newName === from) {
      throw new RangeError(
        `rename of ${symbolId} to its current name "${newName}" is a no-op`
      );
    }
    const refs = await this.referencesTo(symbolId);

    // (3) Render first: rewrite the identifier from→newName at every touched
    // path, then a single commit. Whole-word replace (the heuristic has no scope
    // — spec §11).
    const touched = new Set<string>([def.path, ...refs.map((r) => r.path)]);
    const wordRe = new RegExp(`\\b${escapeIdent(from)}\\b`, 'g');
    for (const path of touched) {
      const bytes = await this.ws.read(path);
      if (bytes === null) {
        continue;
      }
      const text = new TextDecoder().decode(bytes);
      this.ws.write(
        path,
        new TextEncoder().encode(text.replace(wordRe, newName))
      );
    }
    const ops = await this.ws.commit(author);

    // (4) Only after the render lands: mint + record the signed artifact and
    // rebind the ledger. Recording after the commit keeps the op log consistent
    // with the workspace — a `commit` that throws records no rename, so
    // `history()` can never report a rename that never materialized.
    const symbolOp = signSymbolOp(
      {
        kind: 'rename-symbol',
        symbol: symbolId,
        from,
        to: newName,
        base: null,
      },
      author
    );
    this.#ops.append(symbolOp);
    this.ledger.rebind(symbolId, newName);

    return { symbolOp, ops };
  }

  // The signed structural records for a symbol, in the SymbolOpLog's
  // deterministic order (by author, then signature — convergent across peers,
  // NOT the temporal rename sequence; true temporal ordering via the SymbolOp
  // `base` chain is deferred, spec §11). Empty if the symbol was never renamed.
  history(symbolId: string): readonly SymbolOp[] {
    return this.#ops.forSymbol(symbolId);
  }
}
