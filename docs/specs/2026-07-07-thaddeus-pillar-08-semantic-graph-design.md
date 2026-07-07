# Thaddeus — Pillar 08: code as a structured, queryable graph (design)

**Date:** 2026-07-07 **Status:** Design — pending user review, then
implementation plan **Product:** Strata (working name) · **Company/monorepo:**
Thaddeus (`@thaddeus.run/*`) **Source of truth (vision):**
`the-new-age-of-source-control.html`, Pillar 08 **Builds on:**
`docs/specs/2026-06-24-thaddeus-pillar-05-virtual-fs-design.md`,
`docs/specs/2026-06-23-thaddeus-pillar-03-operation-log-design.md`,
`docs/specs/2026-06-23-thaddeus-pillar-04-provenance-design.md`,
`docs/specs/2026-06-22-thaddeus-pillar-01-encrypted-capability-store-design.md`

---

## 1. Context — why this primitive, why now

Strata is an 11-pillar replacement for Git+GitHub, built **one primitive at a
time** (Pillar 01 spec §4). Tiers 0–3 have shipped: identity + store (P01), the
membrane (P02), the operation log (P03), provenance (P04), the virtual
filesystem (P05), the platform (P06), federated reputation (P07), agents as
principals (P09), and review-as-policy (P10). Two greenfield pillars remain — the
**semantic graph (P08)** and the **live database (P11)** — and P11 depends on
P08. This spec is P08.

**Pillar 08 — the semantic graph** is chosen now because:

- **It is the last foundational primitive, and it proves the manifesto's central
  claim.** The brief's thesis is that *code is not a pile of text files; it is a
  live, structured graph you query — files are one rendered view*. Everything
  built so far is the substrate plumbing that carries bytes; P08 is where the
  substrate first understands what those bytes **mean**. Without it, the "same
  pipeline, finer unit" promise of the brief's one-edit callout (line 638) — a
  `rename-symbol` op that targets a symbol id instead of a path — cannot be
  demonstrated.
- **It consumes Tier 0–2 across their public APIs only, and adds little new
  machinery.** Like P05, most of P08 is composition. The graph is *derived* from
  the plaintext a `Workspace` already materializes (P05), and a rename *renders*
  through the `Workspace.write` + `commit` path into ordinary signed P03 ops. The
  genuinely new code is one signed record type (`SymbolOp`, built the way P04
  built `Provenance`) and an in-memory symbol-identity ledger.
- **It redeems IOUs the CHANGELOG already owes.** Two deferred entries name P08
  by hand: *"Rename/move as a first-class op (P08) — currently two unlinked
  path-ops"* and *"Symbol-level addressing (P08) — `Op.path` generalizes to a
  symbol id."* This release pays both.

It resolves the brief's Pillar 08 problem cluster (`ARCHITECTURE.md` lists P08
against **P14, P5, P18**): meaning becomes the addressable artifact, a structural
change is one operation rather than a thousand-line find-and-replace, and a merge
can, in principle, raise a conflict only when a *contract* broke rather than on
whitespace.

## 2. Governing principle — _stable seams, playground interiors_

Unchanged from Pillars 01–07/09/10 (§2): **rigid** = the new package's public API
(`SymbolGraph` and its method shapes), the `SymbolOp` signed record shape, the
`Extractor` interface, and the north-star flow; **loose** = everything behind
those seams — the extractor's regex internals, the in-memory ledger
representation, the single supported language. Consequences here: in-memory only,
single process, no persistence, no network transport, no production hardening,
one heuristic language.

The genuinely rigid, expensive-to-reverse calls in this release are: **(a)** a
symbol's **identity lives in a ledger + signed rename ops, not in the bytes**
(§4, decision 3) — this is what lets rename be one op that preserves identity;
**(b)** a **rename is one signed `SymbolOp`; the N text ops it produces are its
rendering** (§4, decision 4) — the artifact of meaning is the record, not the
edits; and **(c)** extraction is **single-language behind a rigid `Extractor`
seam** (§4, decision 5) — text stays the universal fallback and the graph is an
opt-in overlay. All three are decided here on purpose rather than left to emerge
from code.

### 2.1 What the brief asks for, and what is buildable now

The manifesto's Pillar 08 block gives **Mechanics** and **Resolves → P14, P5,
P18**, but — unlike earlier pillars — carries **no formal "As data / As an API"
schema block**. The data model in §7 is therefore derived from the Mechanics
prose plus the load-bearing one-edit callout (line 638):

> "If the change is structural — a `rename-symbol` rather than a line edit —
> step 3's `Op` targets a symbol id instead of a path (Pillar 08), and the merge
> in step 3 raises a conflict only if a _contract_ broke, never on whitespace.
> Same pipeline, finer unit."

The brief's own frontier accounting (line 835) dictates the spike's shape:

> "text is the default and the universal fallback (you are never worse than
> Git), and the structured graph is an opt-in superpower lit up language by
> language."

Reading each of the brief's Pillar 08 claims, this release takes a position:

1. **Code is a graph of symbols, definitions, references, and edges — meaning is
   the artifact, text is one rendering** (buildable now, one language). A
   `SymbolGraph` projects symbols/defs/refs/call-edges from the plaintext a
   `Workspace` materializes.
2. **Symbol-level addressing — an op can target a symbol id, not a path**
   (buildable now). `SymbolOp` targets a stable `Symbol.id`; the ledger maps
   names ⇆ ids.
3. **Rename is a first-class operation — one op, not a find-and-replace**
   (buildable now, the proof point). `SymbolGraph.rename` mints one signed
   `SymbolOp` and renders it across every reference.
4. **A structured graph needs a language server per language** (the frontier —
   deliberately **not** built). The spike ships one regex heuristic behind the
   `Extractor` seam; real per-language parsing (tree-sitter / LSP) drops in
   later without touching `SymbolGraph`.
5. **Merge raises a conflict only if a contract broke** (partly deferred). The
   spike honors this *in miniature* via a staleness guard (a rename whose `from`
   no longer matches is rejected); full structural/contract conflict detection is
   P10 territory.

## 3. The release's job

Introduce `@thaddeus.run/graph`: the `SymbolGraph` read/rename surface over a P05
`Workspace`, plus the signed `SymbolOp` record. Deliverables:

- The **`Extractor`** seam and a **`HeuristicExtractor`** (§6): a single-language,
  regex-based symbol/reference extractor, explicitly a spike seam.
- The **`Symbol` / `Definition` / `Reference` / `Edge`** projection types (§7).
- The **`SymbolLedger`** (§6.2): the in-memory map that mints and retains a
  symbol's stable id across renames.
- The **`SymbolOp`** signed record with `signSymbolOp` / `verifySymbolOp` (§6.3,
  §8), modeled field-for-field on `Op` / `Provenance`, and an in-memory
  **`SymbolOpLog`** (keep-and-verify, `forSymbol` query), modeled on
  `ProvenanceLog`.
- The **`SymbolGraph`** class (§6): `over` (factory), the read queries
  (`symbols`, `resolve`, `resolveAt`, `definitionOf`, `referencesTo`,
  `callersOf`, `edges`, `history`), and the write **`rename`** (§6.4) — the
  differentiated operation.
- A **semantic-graph CLI demo** (`examples/semantic-graph/`) enacting
  define → resolve → rename (one op renders everywhere) → a decryption-bounded
  query (§9).
- The north-star integration test extended with a **structural-rename**
  assertion; `ARCHITECTURE.md` Pillar 08 row flipped `planned → built`; the flow
  stays green (§12).

Not the job: multi-language extraction, real parser / scope & shadowing
resolution, type inference and type edges, structural ops beyond `rename-symbol`,
whole-program call-graph completeness, per-symbol capability scope, durability /
federation of `SymbolOp`, and full contract-conflict detection (§5, §11).

## 4. Decisions taken (brainstorm outcomes)

1. **Home — a new package `@thaddeus.run/graph`** (primary export `SymbolGraph`).
   Neutral, product-agnostic name per the scope convention (AGENTS.md "Naming");
   matches the brief's "semantic graph" and the `ARCHITECTURE.md` Pillar 08
   label. It consumes `@thaddeus.run/fs` (`Workspace` — a value import),
   `@thaddeus.run/store` (`AccessDenied` value + `Ref` type), and
   `@thaddeus.run/identity` (`Identity` / `PublicIdentity` values, for signing)
   across their public APIs only, and imports `@thaddeus.run/log` (`Op`, `OpLog`)
   as types.

2. **The graph is a projection of Workspace text, not a stored artifact.**
   Symbols, definitions, references, and edges are **re-extracted from the
   plaintext the `Workspace` materializes** on each query — never signed, never
   persisted. Because `Workspace.read`/`grep` are decryption-bounded (P05 §6.4),
   the semantic graph is **decryption-bounded for free**: you can only see
   symbols in code your identity can decrypt. The capability model is inherited,
   not re-implemented. The alternative — a separately-stored, separately-signed
   graph index — was rejected: it would be a parallel source of truth that can
   drift from the text and would have to re-derive the same capability boundary
   by hand.

3. **A symbol's identity lives in a ledger + signed rename ops, not in the
   bytes.** This is the rigid call. A `Symbol.id` is minted **once at birth**
   (`blake3(domain-tag ‖ birthKey)`, content-addressed → deterministic and
   test-reproducible) and thereafter **retained** in an in-memory `SymbolLedger`
   that maps the current lookup key `(path, name, kind) → id` and back.
   Re-extraction of unchanged text re-links to the same id via the lookup key; a
   rename rewrites the ledger binding `(path, from, kind) → (path, to, kind)`
   **atomically with** the text rewrite, so post-rename extraction of the now-`to`
   definition re-links to the *same* id. Identity is preserved across a rename
   precisely because the id is not derived from the current name — it is minted
   at birth and carried by the rename op. The alternative — deriving the id from
   the current name/text — was rejected: it makes rename mint a new symbol, which
   is exactly the churn the pillar exists to eliminate.

4. **A rename is one signed `SymbolOp`; the text ops are its rendering.**
   `SymbolGraph.rename(symbolId, newName, author)` mints **one** signed
   `SymbolOp{ kind:'rename-symbol', symbol, from, to, base, author, sig }` — the
   source of truth for the change — and then *renders* it by rewriting the
   identifier at the definition site and every reference through
   `Workspace.write` + a single `Workspace.commit(author)`, producing the normal
   P03 `Op`s the rest of the substrate (provenance, land, mirror) consumes
   unchanged. "A rename is *one* operation, not a thousand-line find-and-replace"
   (brief line 621); the N text ops are explicitly the *projection* of the one
   `SymbolOp`, mirroring the pillar's own "text is one rendering."

5. **Extraction is single-language behind a rigid seam; text is the universal
   fallback.** `Extractor` is the rigid interface; `HeuristicExtractor` is the
   loose interior — a few regexes that recognize `fn <name>(` as a function
   definition and `<name>(` elsewhere as a call reference, matching the
   substrate's existing `.rs` fixtures (`fn refresh() {}`). Real per-language
   parsing (tree-sitter, rust-analyzer/tsserver) is the frontier's actual hard
   problem — seconds to cold-index, hundreds of MB to GBs of RAM per workspace,
   and putting that on the canonical write path for a fleet of agents is the
   thing to get *right*, later. The spike's job is to prove the substrate shape
   (identity, rename-as-op, symbol queries), not to ship a language server. A
   real parser drops in behind `Extractor` without touching `SymbolGraph`.

6. **Conflict-as-function, in miniature.** The brief's "raises a conflict only if
   a contract broke" is honored by the `from` field: a rename whose `from` no
   longer matches the ledger's current name for the symbol is **stale** (the
   symbol moved under the caller) and is rejected before any text is written.
   Full structural conflict detection (signature compatibility across callers,
   behavioral diff) is deferred to a later pass and P10.

### 4.1 Why this is almost no new machinery (honest claim)

Like P05, the differentiated capability is mostly *composition* of primitives
already shipped:

| P08 capability                     | Mechanism (existing)                                       |
| ---------------------------------- | ---------------------------------------------------------- |
| read source text for extraction    | `Workspace.read` / `list` (P05) — decryption-bounded       |
| render a rename across references   | `Workspace.write` + `Workspace.commit` (P05) → P03 ops      |
| the signed structural op           | the `Op` / `Provenance` signed-record pattern (P03/P04)     |
| keep-and-verify structural history  | the `ProvenanceLog` in-memory registry pattern (P04)       |
| capability boundary on the graph    | inherited from `Workspace` reads (P05 §6.4)                |

P08's genuinely new code is small: the `Extractor` heuristic, the read-model
projection (`SymbolGraph` queries), the `SymbolLedger` (stable-id minting +
retention), and the `SymbolOp` record + `SymbolOpLog`. That is the point — the
substrate was designed so meaning is a thin, honest overlay, not a parallel
source of truth.

### 4.2 `rename` step order (the one subtle rule)

`rename(symbolId, newName, author)` executes in this order, and the order
matters: **(1)** resolve the symbol's current binding (`from` name, def path) and
reference set from a **fresh** decryption-bounded extraction — you can only
rename what you can read; **(2)** guard: if `from` no longer matches the ledger's
current name, throw `StaleRename` before touching anything; **(3)** mint and
record the signed `SymbolOp`; **(4)** rewrite the identifier `from → newName` at
the def site and every reference via `Workspace.write`, then one
`Workspace.commit(author)`; **(5)** update the ledger binding atomically so
re-extraction re-links the same id. The `SymbolOp` is minted *before* the text
render so the artifact of meaning exists even if a later store write is fallible;
the ledger update happens *after* a successful commit so the projection and the
identity map never disagree.

## 5. Scope

**In (this release):**

- Package `@thaddeus.run/graph` with `SymbolGraph` and its `over` factory.
- `Extractor` interface + `HeuristicExtractor` (one language: the `.rs` fixture
  dialect — `fn <name>(` defs, `<name>(` call refs).
- Read queries: `symbols`, `resolve` / `resolveAt` (name → stable id),
  `definitionOf`, `referencesTo`, `callersOf`, `edges`, `history`.
- `SymbolLedger` (stable-id mint + retention across renames).
- `SymbolOp` signed record (`signSymbolOp` / `verifySymbolOp`, domain tag,
  `assertCanonical`) + `SymbolOpLog` (keep-and-verify, `forSymbol`).
- `SymbolGraph.rename` (mint op → render via `Workspace` → update ledger) with
  the staleness guard.
- `examples/semantic-graph/` demo; north-star structural-rename assertion;
  `ARCHITECTURE.md` + `CHANGELOG.md`.

**Out (deferred, named so scope stays honest):**

- **Multi-language extraction** → one heuristic language ships; `Extractor` is
  the drop-in seam for tree-sitter/LSP per language. Text is the universal
  fallback.
- **Real parser / scope & shadowing resolution** → the regex extractor has no
  scope analysis; a real language server is the "do it great" target (aligns with
  the existing "Rust hot-path reimplementation … likely P03 and P08" research
  ledger entry).
- **Type inference and type edges** → `Edge` ships `calls`/`references` only.
- **Structural ops beyond `rename-symbol`** → `change-signature`,
  `move-definition`, `extract-function` share the `SymbolOp` record shape but are
  not built.
- **Whole-program call-graph completeness** → `callersOf` is best-effort within
  the decryptable, single-language view.
- **Per-symbol capability scope** (the brief's "hide one function inside a public
  file") → powerful and easy to get wrong; a P01/P02 × P08 integration pass.
- **Durability / federation of `SymbolOp`** → the ledger and `SymbolOpLog` are
  in-memory only (like `ProvenanceLog`); Backend persistence and wire ingest are
  deferred.
- **Structural conflict-as-function** → only staleness (`from` mismatch) is
  checked; real "conflict iff a contract broke" is P10.
- Persistence, network transport, multi-process concurrency.

## 6. The seam (public API delta)

New package. No changes to `@thaddeus.run/identity`, `@thaddeus.run/store`,
`@thaddeus.run/log`, or `@thaddeus.run/fs` — `graph` consumes their existing
public surfaces.

### `@thaddeus.run/graph`

```ts
import type { Identity } from '@thaddeus.run/identity';
import type { Op } from '@thaddeus.run/log';
import type { Workspace } from '@thaddeus.run/fs';

// A symbol's DURABLE identity — minted once at birth, independent of path, name,
// and text. Rename changes the binding, never this id.
interface Symbol {
  readonly id: string; // opaque, content-addressed at birth
  readonly kind: 'function' | 'type' | 'const'; // spike set; extend later
}

// WHERE a symbol is currently defined — a projection that changes as the symbol
// is renamed. `name` is the current rendered name.
interface Definition {
  readonly symbol: string; // Symbol.id
  readonly name: string; // current name (post any renames)
  readonly path: string; // current file
  readonly line: number; // 1-based def site
}

// A use-site of a symbol — the edges "references-to" reads off.
interface Reference {
  readonly symbol: string; // Symbol.id
  readonly path: string;
  readonly line: number;
}

// A typed edge in the call/reference graph. Spike ships 'calls' + 'references';
// 'defines' is implicit in Definition. Type edges are deferred.
interface Edge {
  readonly kind: 'calls' | 'references';
  readonly from: string; // Symbol.id (caller)
  readonly to: string; // Symbol.id (callee)
}

// The single-language extraction seam. A real implementation is tree-sitter or a
// language server; the spike ships one regex heuristic. Swapping in a real parser
// is a drop-in behind this interface — that is the point.
interface Extractor {
  readonly language: string;
  extract(
    path: string,
    text: string
  ): {
    readonly defs: readonly {
      name: string;
      kind: Symbol['kind'];
      line: number;
    }[];
    readonly refs: readonly { name: string; line: number }[];
  };
}

// The loose interior: recognizes `fn <name>(` as a function definition and
// `<name>(` elsewhere as a call reference. No scope/shadowing, no types, false
// positives inside comments/strings. A SPIKE SEAM.
class HeuristicExtractor implements Extractor {
  readonly language: string; // e.g. 'rs-heuristic'
}

// A signed structural operation over the semantic graph. Targets a Symbol.id,
// never a path — the manifesto's "step 3's Op targets a symbol id". The spike
// ships 'rename-symbol'; other structural ops are the same record shape.
interface SymbolOp {
  readonly id: string;
  readonly kind: 'rename-symbol';
  readonly symbol: string; // Symbol.id being renamed
  readonly from: string; // old name (binds intent; detects staleness)
  readonly to: string; // new name
  readonly base: string | null; // optional prior SymbolOp.id it extends
  readonly author: string; // did
  readonly sig: Uint8Array;
}

function signSymbolOp(
  fields: {
    kind: 'rename-symbol';
    symbol: string;
    from: string;
    to: string;
    base: string | null;
  },
  author: Identity
): SymbolOp;
function verifySymbolOp(op: SymbolOp): boolean;

// Keep-and-verify registry of SymbolOps keyed by Symbol.id — modeled on
// ProvenanceLog. In-memory, single process. Invalid records are kept and
// rendered unverifiable rather than rejected.
class SymbolOpLog {
  append(op: SymbolOp): void;
  forSymbol(symbolId: string): readonly SymbolOp[];
  verify(op: SymbolOp): boolean;
}

// The read/rename surface over a Workspace. Reads re-derive from decryptable
// Workspace text; rename mints one SymbolOp and renders it through the Workspace.
class SymbolGraph {
  // Construct over a Workspace with an extractor and (optionally) a shared ledger
  // and op-log. Reads re-extract on each call; nothing is cached across edits.
  static over(
    workspace: Workspace,
    opts: {
      extractor: Extractor;
      ledger?: SymbolLedger;
      ops?: SymbolOpLog;
    }
  ): SymbolGraph;

  // All symbols currently visible in decryptable code.
  symbols(): Promise<readonly Symbol[]>;

  // Symbol-level addressing: a current name → its stable Symbol.id (or null).
  // `resolveAt` disambiguates by definition path.
  resolve(name: string): Promise<string | null>;
  resolveAt(path: string, name: string): Promise<string | null>;

  // Where a symbol is currently defined (definition-of), or null.
  definitionOf(symbolId: string): Promise<Definition | null>;

  // Every use-site of a symbol (references-to), deterministic order.
  referencesTo(symbolId: string): Promise<readonly Reference[]>;

  // Symbols that call this one (callers-of) — best-effort, single-language.
  callersOf(symbolId: string): Promise<readonly Symbol[]>;

  // The raw call/reference graph — the read model Pillar 11 will index.
  edges(): Promise<readonly Edge[]>;

  // The signed structural history of a symbol (its SymbolOps), oldest binding
  // first. Empty if the symbol has never been renamed.
  history(symbolId: string): readonly SymbolOp[];

  // The differentiated write: rename a symbol as ONE signed SymbolOp that renders
  // across the def site and every reference. Returns the semantic op plus the
  // rendered P03 text ops. Throws StaleRename if the symbol's current name no
  // longer matches (it moved under you).
  rename(
    symbolId: string,
    newName: string,
    author: Identity
  ): Promise<{ readonly symbolOp: SymbolOp; readonly ops: readonly Op[] }>;
}

// In-memory symbol-identity map: (path, name, kind) ⇆ Symbol.id. Mints an id at
// first sight of a definition and retains it across renames. Spike — not durable.
class SymbolLedger {
  /* mint / lookup / rebind — see §6.2 */
}

export { SymbolGraph, SymbolLedger, SymbolOpLog, HeuristicExtractor };
export { signSymbolOp, verifySymbolOp };
export type { Symbol, Definition, Reference, Edge, Extractor, SymbolOp };
```

### 6.1 Extraction — the projection

On every read query, `SymbolGraph` walks `workspace.list()`, reads each
decryptable file (`workspace.read`, `null` skipped), and runs the `Extractor`
over its text. Definitions populate/consult the ledger (§6.2) to attach a stable
`Symbol.id`; references and calls become `Reference`s and `Edge`s pointing at the
resolved ids. Undecryptable files never enter the graph — the capability boundary
is inherited from `Workspace`, not re-checked.

### 6.2 The `SymbolLedger` — stable identity

The ledger is the graph's only mutable, non-projection state:

- **Birth mint:** the first time extraction sees a definition whose lookup key
  `(path, name, kind)` is unknown, mint
  `id = blake3('thaddeus.graph.symbol.v1' ‖ path ‖ name ‖ kind)` and record both
  directions: `(path, name, kind) → id` and `id → { path, name, kind }`. (Using
  the introducing `Op.id` in the birth key is a stronger-uniqueness option;
  `(path, name, kind)` is the deterministic spike default.)
- **Re-link:** subsequent extraction of unchanged text finds the key and reuses
  the id.
- **Rebind (rename):** `rebind(id, from → to)` rewrites `(path, from, kind) → id`
  to `(path, to, kind) → id`, keeping the *same* id. Re-extraction of the now-`to`
  definition therefore re-links to the same symbol.

The ledger is seeded lazily by extraction and shared across a `SymbolGraph`'s
queries within one construction; a caller may pass a persistent `SymbolLedger` to
carry identity across `over` calls on the same evolving workspace.

### 6.3 `SymbolOp` — the signed structural op

`SymbolOp` follows the `Op`/`Provenance` record discipline exactly (§8): a
`SymbolOpFields` tuple, a domain-tagged canonical JSON encoding, an
`assertCanonical` that rejects empty/malformed fields before hashing, `id =
blake3(canonical)`, `sig = author.sign(canonical)`, and a fail-closed
`verifySymbolOp` (any mismatch or malformed input → `false`, never throws). The
`SymbolOpLog` is the `ProvenanceLog` pattern: keep-and-verify, dedup on a total
content key, `forSymbol(id)` in deterministic order.

### 6.4 `rename` — rendering one op across references

Per §4.2: resolve → staleness-guard → mint+record `SymbolOp` → for each file
containing the def or a reference, rewrite the identifier `from → newName`
(whole-word) in the text and `workspace.write` it, then one
`workspace.commit(author)` → `rebind` the ledger. Returns
`{ symbolOp, ops }`. The rewrite is name-based (the heuristic has no scope), so a
same-named symbol in another scope would also be rewritten — an honest limitation
of the single-language heuristic (§11), not of the op model.

## 7. Data model

P08 introduces **one** persisted-shape record — the signed `SymbolOp` — and two
in-memory projections. Nothing else is stored: symbols, definitions, references,
and edges are re-derived from `Workspace` text on demand.

```
SymbolOp (signed, on the wire) {
  id: string                       // blake3(canonical)
  kind: 'rename-symbol'
  symbol: string                   // Symbol.id
  from: string; to: string
  base: string | null              // prior SymbolOp.id
  author: string                   // did
  sig: Uint8Array                  // author over the canonical tuple
}

SymbolGraph (in-memory) {
  workspace: Workspace             // source of truth for text (P05)
  extractor: Extractor             // single-language projection
  ledger:    SymbolLedger          // (path,name,kind) ⇆ Symbol.id (mutable)
  ops:       SymbolOpLog           // signed structural history (keep-and-verify)
}

Symbol/Definition/Reference/Edge   // pure projections, never stored
```

The durable artifacts of a rename are the one `SymbolOp` plus the ordinary P03
`Op`s and P01 store objects its render produces. The symbol id is content-
addressed at birth; there is nothing new to encrypt.

## 8. Crypto choices

**One new signed record, no new primitives.** `SymbolOp` reuses the exact scheme
`Op` (P03) and `Provenance` (P04) use:

- `blake3` (`@noble/hashes/blake3`) for the id and the canonical byte digest.
- The author `Identity.sign` / `PublicIdentity.fromDid(...).verify` (P01) over
  domain-tagged canonical JSON — domain tag `'thaddeus.graph.symbolop.v1'`, so a
  `SymbolOp` signature can never be confused with an op (`thaddeus.log.op.v1`) or
  provenance (`thaddeus.provenance.v1`) signature.
- `assertCanonical` rejects non-canonical field values (empty strings, wrong
  types) before hashing, exactly as `op.ts`/`provenance.ts` do, so a poisoning
  value cannot be signed and `verifySymbolOp` rejects it.

The symbol id mint is `blake3` over a domain-tagged birth key (§6.2) — a
content-address, not a signature. `SymbolGraph` performs no encryption of its own;
all content encryption/decryption stays in `store`/`Workspace`. Methods that
touch identity/store/log `await ready()` transitively; the package documents that
`ready()` must be awaited before use (consistent with Tier 0–3).

## 9. The demo — the semantic graph (CLI)

`examples/semantic-graph/` (sibling to `workspace/`, `provenance/`, `oplog/`),
deterministic via injected identities/seeds. Three acts:

**Act 1 — code is a graph you query.**

1. Seed a repo/op-log/store; open a `Workspace`; write `src/auth.rs` with a
   definition `fn refresh() { ... }` and a caller `fn login() { refresh(); }`;
   `commit`.
2. `const g = SymbolGraph.over(ws, { extractor: new HeuristicExtractor() });`
   Show `g.resolve('refresh')` → a stable id, `g.definitionOf(id)`,
   `g.referencesTo(id)` (the call site), and `g.callersOf(id)` (`login`).

**Act 2 — rename is one operation.**

3. `const { symbolOp, ops } = await g.rename(id, 'refreshToken', dev);` Show
   `verifySymbolOp(symbolOp) === true`, `symbolOp.symbol === id` — **one** signed
   op — and that `ws.grep('refresh(')` now returns only `refreshToken(` at both
   the def and the call site, from that single call. Show `g.resolve
   ('refreshToken') === id` (identity survived) and `g.history(id)` lists the
   rename.

**Act 3 — the graph stops at the capability boundary.**

4. A teammate writes an ungranted `src/secret.rs` with `fn hidden() {}`; show it
   appears in `ws.list()` (cleartext path) but `g.resolve('hidden')` is `null`
   and `g.symbols()` omits it — you can only see the meaning of code you can
   decrypt. Print the acceptance facts.

## 10. Acceptance criteria (measurable; written test-first)

1. **Extract a symbol** — after writing `fn refresh() {}` and committing,
   `resolve('refresh')` returns a non-null id and `definitionOf(id)` reports the
   right path/line/kind.
2. **Symbol-level addressing** — `resolve(name)` is stable across repeated
   queries over unchanged text (same id), and `resolveAt(path, name)`
   disambiguates by def path.
3. **References and callers** — `referencesTo(id)` includes each call site;
   `callersOf(id)` includes the calling symbol; both in deterministic order.
4. **Rename is one signed op** — `rename(id, 'refreshToken', author)` returns a
   `symbolOp` with `verifySymbolOp === true`, `kind === 'rename-symbol'`,
   `symbol === id`, `from === 'refresh'`, `to === 'refreshToken'`. _(Pins
   decision 4.)_
5. **Rename renders across every reference** — after the rename, `grep('refresh(')`
   matches only `refreshToken(` at both the def and the call site; no site is
   missed and none is left stale.
6. **Identity survives rename** — `resolve('refreshToken') === id` (same id;
   rename did not mint a new symbol) and `resolve('refresh') === null`. _(Pins
   decision 3.)_
7. **Rendered ops are ordinary P03 ops** — the returned `ops` are signed
   `verifyOp`-valid ops on the workspace's view; a subsequent `ws.read` of the
   file shows the renamed text.
8. **Staleness guard** — a `rename` whose `from` no longer matches the ledger's
   current name throws `StaleRename` and writes no text. _(Pins decision 6.)_
9. **`SymbolOp` verify fails closed** — tampering any signed field
   (`{ ...op, to: 'x' }`) renders `verifySymbolOp === false`; a malformed record
   does not throw.
10. **`history`** — after a rename, `history(id)` lists the `SymbolOp`; a symbol
    never renamed returns `[]`.
11. **Decryption-bounded graph** — a definition in an object the reader cannot
    decrypt is absent from `symbols`/`resolve`/`edges` (no throw), while its path
    still appears in `ws.list()`. _(Pins decision 2.)_
12. **Composition (north-star)** — the seeded flow gains a structural-rename
    assertion: define a symbol + a caller in a `Workspace`, `resolve`, `rename`,
    and assert one signed `SymbolOp`, all references updated, identity preserved,
    a `ProvenanceLog` "why" bound to the rename, and the rendered ops landing +
    mirror-servable; the flow stays green.

## 11. Honest limitations (stated, not hidden)

- **One heuristic language, no real parser.** The `HeuristicExtractor` recognizes
  `fn <name>(` / `<name>(` only; it mis-identifies symbols inside comments and
  strings, cannot resolve scope or shadowing, and knows nothing of types. It is a
  spike seam; `Extractor` is where a real parser lands.
- **Name-based rename render.** With no scope analysis, `rename` rewrites the
  identifier by whole-word match, so a same-named symbol in another scope would
  also be rewritten. Correct scoping is a real-parser concern.
- **No type edges, no structural ops beyond rename.** `Edge` ships
  `calls`/`references`; `change-signature`/`move-definition`/`extract-function`
  share the record shape but are not built.
- **Conflict is staleness-only.** The `from` guard catches a symbol that moved
  under you; real "conflict iff a contract broke" (signature compatibility) is
  P10.
- **In-memory ledger and op-log.** `SymbolLedger` and `SymbolOpLog` are not
  durable and not concurrency-safe; Backend persistence and wire ingest are
  deferred (like `ProvenanceLog`).
- **`callersOf` is best-effort and single-language** over the decryptable view;
  no whole-program resolution.
- **In-memory, single process.** No persistence, no network transport, no
  multi-process concurrency. Inherits Tier 0–3 spike limits.

## 12. Seeded/updated docs

- **`CHANGELOG.md`** — under `[Unreleased] → Added`: the P08 semantic graph
  (`@thaddeus.run/graph` `SymbolGraph`: decryption-bounded symbol/def/ref/edge
  projection over a `Workspace`; stable `Symbol.id` in a `SymbolLedger`;
  `rename-symbol` as one signed `SymbolOp` rendered across every reference; the
  `Extractor` seam with a single-language `HeuristicExtractor`). Move the two
  existing P08 IOUs (**rename/move as a first-class op**, **symbol-level
  addressing**) out of Deferred; add new Deferred entries: **multi-language /
  real parser**, **type edges & structural ops beyond rename**, **whole-program
  call graph**, **per-symbol capability scope**, **`SymbolOp` durability /
  federation**, **structural conflict-as-function (→P10)**.
- **`ARCHITECTURE.md`** — flip the **Pillar 08** row `planned → built` (package
  `@thaddeus.run/graph`). The `Op` primitive row already lists P08; add a `graph`
  consumer note (the rename render produces ops). _(Do the queued P10
  housekeeping in the same pass — the table still marks Pillar 10 "planned"
  though `@thaddeus.run/review` shipped; flip it to `built`.)_
- **North-star** — add the structural-rename assertion (§10.12) to
  `integration/test/one-edit-end-to-end.test.ts`; the flow stays green.

## 13. Open items / next primitives

- **Pillar 11 (live database)** is the natural next primitive and depends on
  this one: wrap `SymbolGraph`'s read model (`edges`, `referencesTo`,
  `definitionOf`) with a subscription/trigger surface — "query the present
  semantic state; stand up triggers that fire on *meaning*" (brief line 721) —
  plus the deferred `--why` provenance-history query surface. The `Op` wall-clock
  timestamp (a small P03 change the CHANGELOG defers) unblocks time-range history
  there.
- **A real `Extractor`** (tree-sitter / language server) behind the seam is the
  first "do it great" follow-on, and the point where multi-language and correct
  scoping arrive.
- **Structural ops beyond rename** (`change-signature`, `move-definition`) reuse
  the `SymbolOp` record shape and the render pipeline built here.
- Confirm whether per-symbol capability scope (the brief's "hide one function
  inside a public file") is a P08 extension or a dedicated P01/P02 × P08 pass.
