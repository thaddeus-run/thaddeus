// Pillar 08 projection types + the single-language extraction seam. Symbols,
// definitions, references, and edges are DERIVED from Workspace text — never
// stored, never signed. See the design spec §6–§7.

// A symbol's durable identity — minted once at birth (graph.ts), independent of
// path, name, and text. Rename changes the binding, never this id.
export interface Symbol {
  readonly id: string;
  readonly kind: 'function' | 'type' | 'const';
}

// Where a symbol is currently defined. `name` is the current (post-rename) name.
export interface Definition {
  readonly symbol: string; // Symbol.id
  readonly name: string;
  readonly path: string;
  readonly line: number; // 1-based
}

// A use-site of a symbol.
export interface Reference {
  readonly symbol: string; // Symbol.id
  readonly path: string;
  readonly line: number;
}

// A typed edge in the call/reference graph.
export interface Edge {
  readonly kind: 'calls' | 'references';
  readonly from: string; // Symbol.id (caller)
  readonly to: string; // Symbol.id (callee)
}

// A raw (pre-identity) definition/reference the extractor emits; graph.ts binds
// each to a Symbol.id via the ledger.
export interface RawDef {
  readonly name: string;
  readonly kind: Symbol['kind'];
  readonly line: number;
}
export interface RawRef {
  readonly name: string;
  readonly line: number;
}

// The rigid extraction seam. A real implementation is tree-sitter or a language
// server; the spike ships one regex heuristic. Swapping in a real parser is a
// drop-in behind this interface.
export interface Extractor {
  readonly language: string;
  extract(
    path: string,
    text: string
  ): { readonly defs: readonly RawDef[]; readonly refs: readonly RawRef[] };
}

// Match an identifier immediately following `fn ` — a function definition.
const DEF_RE = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
// Match every `identifier(` on a line — a call. Filtered against defs + keywords.
const CALL_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

// The loose interior: `fn <name>(` is a function definition; any other
// `<name>(` is a call reference. No scope/shadowing analysis, no types, false
// positives inside comments/strings. A SPIKE SEAM — see the spec's honest
// limitations (§11).
export class HeuristicExtractor implements Extractor {
  readonly language = 'rs-heuristic';

  extract(
    _path: string,
    text: string
  ): { readonly defs: readonly RawDef[]; readonly refs: readonly RawRef[] } {
    const defs: RawDef[] = [];
    const refs: RawRef[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const def = DEF_RE.exec(line);
      const defName = def?.[1] ?? null;
      if (defName !== null) {
        defs.push({ name: defName, kind: 'function', line: i + 1 });
      }
      // Every `name(` that is neither the `fn` keyword nor a definition's own
      // occurrence (`fn name(`) is a call reference. Detecting the def occurrence
      // by what precedes it (`fn` + whitespace) is robust to spacing, unlike
      // index arithmetic.
      CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CALL_RE.exec(line)) !== null) {
        const name = m[1] ?? '';
        if (name === 'fn') {
          continue;
        }
        if (/\bfn\s+$/.test(line.slice(0, m.index))) {
          continue; // this `name(` is a definition, not a call
        }
        refs.push({ name, line: i + 1 });
      }
    }
    return { defs, refs };
  }
}
