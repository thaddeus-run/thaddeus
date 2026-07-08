# @thaddeus.run/graph

The semantic graph for **Thaddeus** (working name) — Pillar 08.

`SymbolGraph` projects a graph of symbols, definitions, references, and call
edges from the plaintext a `@thaddeus.run/fs` `Workspace` materializes — so code
is something you _query_, and files are one rendered view. It addresses code by
a stable `Symbol.id` (minted once at birth, retained across renames by a
`SymbolLedger`) and makes **rename a first-class operation**: one signed
`SymbolOp` rendered across the definition and every reference, not a
thousand-line find-and-replace. The graph is **decryption-bounded** — you only
see the meaning of code your identity can decrypt.

> **Status: spike.** In-memory, single process. One heuristic language behind
> the `Extractor` seam (a real tree-sitter/LSP parser drops in there); type
> edges, structural ops beyond rename, per-symbol capability scope, and
> durability are deferred (see the design spec).
