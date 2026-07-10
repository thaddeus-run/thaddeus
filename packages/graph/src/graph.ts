import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import type { Workspace } from '@thaddeus.run/fs';
import type { Identity } from '@thaddeus.run/identity';
import type { Op } from '@thaddeus.run/log';

import type { Definition, Edge, Extractor, Reference, Symbol } from './symbol';
import { signSymbolOp, type SymbolOp, verifySymbolOp } from './symbolop';
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

function symbolIdFor(binding: Binding): string {
  return bytesToHex(
    blake3(
      new TextEncoder().encode(
        JSON.stringify([
          SYMBOL_DOMAIN,
          binding.path,
          binding.name,
          binding.kind,
        ])
      )
    )
  );
}

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
    const id = symbolIdFor(b);
    this.#byKey.set(key, id);
    // Do not clobber an existing id→binding (a name resurrected after a rename is
    // a known spike edge, spec §11); the first binding for an id wins.
    if (!this.#byId.has(id)) {
      this.#byId.set(id, b);
    }
    return id;
  }

  // The id a binding resolves to WITHOUT granting it stable ownership: its
  // stable owner when bound, otherwise its deterministic content address. Lets
  // snapshots show an unaccepted rename target consistently while the target
  // stays mintable and retryable.
  project(b: Binding): string {
    return this.#byKey.get(bindingKey(b)) ?? symbolIdFor(b);
  }

  stableOwner(b: Binding): string | null {
    return this.#byKey.get(bindingKey(b)) ?? null;
  }

  // Whether `bind` would succeed: the target key must be free or already owned
  // by this id. Reconciliation preflights with this so a claim it accepts can
  // never fail to apply.
  canBind(id: string, target: Binding): boolean {
    const owner = this.#byKey.get(bindingKey(target));
    return owner === undefined || owner === id;
  }

  // Bind `id` at `target`: mint an unknown id there, or move a known id off its
  // previous key. Never seizes a key owned by a different identity.
  bind(id: string, target: Binding): boolean {
    if (!this.canBind(id, target)) {
      return false;
    }
    const existing = this.#byId.get(id);
    if (existing !== undefined) {
      this.#byKey.delete(bindingKey(existing));
    }
    this.#byKey.set(bindingKey(target), id);
    this.#byId.set(id, target);
    return true;
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

interface ProjectedDefinition extends Binding {
  readonly line: number;
}

interface RenameStep {
  readonly from: string;
  readonly to: string;
  readonly ops: readonly SymbolOp[];
}

// Collapse equivalent signed records into semantic edges so duplicate support
// is synchronized together without manufacturing competing rename routes.
function renameSteps(history: readonly SymbolOp[]): readonly RenameStep[] {
  const steps = new Map<
    string,
    { from: string; to: string; ops: SymbolOp[] }
  >();
  for (const op of history) {
    const key = JSON.stringify([op.from, op.to]);
    const step = steps.get(key) ?? { from: op.from, to: op.to, ops: [] };
    step.ops.push(op);
    steps.set(key, step);
  }
  return [...steps.values()];
}

// Bound the route search: a legitimate per-symbol history is a short chain,
// but any key can sign records, so a crafted dense history could make simple-
// path enumeration exponential. Past this many step visits the history gets
// the same verdict as a competing route — not authoritative.
const RENAME_ROUTE_BUDGET = 100_000;

// Find exactly one cycle-free semantic route; zero, competing, or search-
// budget-exhausting routes are not authoritative enough to restore identity
// from an unordered peer history.
function uniqueRenamePath(
  history: readonly SymbolOp[],
  from: string,
  to: string
): readonly SymbolOp[] | null {
  if (from === to) {
    return [];
  }
  const steps = renameSteps(history);
  const paths: RenameStep[][] = [];
  let visits = 0;
  let exhausted = false;
  const visit = (
    name: string,
    path: readonly RenameStep[],
    seen: ReadonlySet<string>
  ): void => {
    if (paths.length > 1 || exhausted) {
      return;
    }
    for (const step of steps) {
      visits += 1;
      if (visits > RENAME_ROUTE_BUDGET) {
        exhausted = true;
        return;
      }
      if (step.from !== name || seen.has(step.to)) {
        continue;
      }
      const nextPath = [...path, step];
      if (step.to === to) {
        paths.push(nextPath);
      } else {
        visit(step.to, nextPath, new Set([...seen, step.to]));
      }
    }
  };
  visit(from, [], new Set([from]));
  if (exhausted) {
    return null;
  }
  return paths.length === 1
    ? (paths[0]?.flatMap((step) => step.ops) ?? [])
    : null;
}

// Return only candidates whose projected binding has exactly one stable-symbol
// claimant. Candidate selection must finish before any ledger mutation.
function uncontended<T extends { readonly target: Binding }>(
  candidates: readonly T[]
): readonly T[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = bindingKey(candidate.target);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return candidates.filter(
    (candidate) => counts.get(bindingKey(candidate.target)) === 1
  );
}

// One symbol's claim on one projected definition, resolved during a
// reconciliation transaction. `projectedId` is the target's content address —
// equal to `symbol` exactly when the target sits at the symbol's birth.
interface RenameClaim {
  readonly symbol: string;
  readonly target: Binding;
  readonly projectedId: string;
}

// The birth name for `symbol` anchored at a definition's site: the history
// `from` whose content address at (path, kind) equals the symbol id. At most
// one name can hash to the id, so the first match is the only match.
function birthNameAt(
  symbol: string,
  history: readonly SymbolOp[],
  site: Binding
): string | null {
  for (const from of new Set(history.map((op) => op.from))) {
    if (
      symbolIdFor({ path: site.path, name: from, kind: site.kind }) === symbol
    ) {
      return from;
    }
  }
  return null;
}

// The read/rename surface over a Workspace. Reads re-extract from decryptable
// Workspace text on each call — the capability boundary is inherited from
// Workspace (a null read ⇒ the symbol is invisible). Spike — single process.
export class SymbolGraph {
  protected readonly ws: Workspace;
  readonly #extractor: Extractor;
  protected readonly ledger: SymbolLedger;
  readonly #ops: SymbolOpLog;
  // Verified rename records accumulated across syncRenames calls, per symbol,
  // deduped by content-addressed op id so each signature is checked once.
  readonly #renameHistory: Map<string, Map<string, SymbolOp>> = new Map();
  // Binding keys of definitions claimed by live-but-unapplied renames; #model()
  // projects these instead of minting so the claims stay retryable. Recomputed
  // from scratch by every reconciliation — a marker cannot outlive its claim.
  readonly #provisionalRenameTargets = new Set<string>();

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

  // Extract definition bindings without consulting or mutating identity state.
  // Rename reconciliation uses this immutable projection for global preflight.
  async #projectedDefinitions(): Promise<readonly ProjectedDefinition[]> {
    const definitions: ProjectedDefinition[] = [];
    for (const path of await this.ws.list()) {
      const bytes = await this.ws.read(path);
      if (bytes === null) {
        continue;
      }
      const raw = this.#extractor.extract(
        path,
        new TextDecoder().decode(bytes)
      );
      for (const definition of raw.defs) {
        definitions.push({
          path,
          name: definition.name,
          kind: definition.kind,
          line: definition.line,
        });
      }
    }
    return definitions;
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
        const binding = { path, name: d.name, kind: d.kind };
        const id = this.#provisionalRenameTargets.has(bindingKey(binding))
          ? this.ledger.project(binding)
          : this.ledger.mintOrGet(binding);
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

  // Ingest verified rename records into the accumulated per-symbol history
  // (dedup by content-addressed op id, so each signature is checked at most
  // once across the watch loop's repeated full-history calls), then reconcile.
  // The first and every later call share one reconciliation transaction, so a
  // claim rejected today — contention, an unlanded rename, an ambiguous route —
  // stays retryable on any later call, whether or not this graph served reads
  // before the claim arrived.
  async syncRenames(ops: readonly SymbolOp[]): Promise<void> {
    for (const op of ops) {
      const history = this.#renameHistory.get(op.symbol);
      if (history?.has(op.id) === true) {
        continue;
      }
      if (!verifySymbolOp(op)) {
        continue;
      }
      if (history === undefined) {
        this.#renameHistory.set(op.symbol, new Map([[op.id, op]]));
      } else {
        history.set(op.id, op);
      }
    }
    if (
      this.#renameHistory.size === 0 &&
      this.#provisionalRenameTargets.size === 0
    ) {
      return;
    }
    await this.#reconcileRenames();
  }

  // One reconciliation transaction over the accumulated history and the
  // current projected text. Each claimed symbol is anchored at its ledger
  // binding when known, else at a birth reconstructed from its history; a
  // claim applies only when exactly one authoritative route reaches exactly
  // one viable definition, no other claim contends for that definition, and
  // the preflighted ledger bind cannot fail. Every other live claim keeps its
  // target provisional until a later call resolves or refutes it.
  async #reconcileRenames(): Promise<void> {
    const definitions = await this.#projectedDefinitions();
    const present = new Set(definitions.map((d) => bindingKey(d)));
    const claimed = new Set(this.#renameHistory.keys());

    const selected: RenameClaim[] = [];
    // Live claims that cannot apply this call (ambiguous routes) but whose
    // targets must stay provisional rather than mint as fresh identities.
    const deferred: RenameClaim[] = [];
    for (const [symbol, records] of this.#renameHistory) {
      const history = [...records.values()];
      const binding = this.ledger.bindingOf(symbol);
      if (binding !== null && present.has(bindingKey(binding))) {
        continue; // current name still projected — its rename has not landed
      }
      const candidates: RenameClaim[] = [];
      for (const definition of definitions) {
        const target: Binding = {
          path: definition.path,
          name: definition.name,
          kind: definition.kind,
        };
        const anchor =
          binding !== null
            ? binding.path === target.path && binding.kind === target.kind
              ? binding.name
              : null
            : birthNameAt(symbol, history, target);
        if (anchor === null) {
          continue;
        }
        const projectedId = symbolIdFor(target);
        // A target that is already someone else's identity — stably owned,
        // known to the ledger under another binding, or the birth of another
        // claimed history — can never become this symbol's binding.
        if (
          projectedId !== symbol &&
          (this.ledger.bindingOf(projectedId) !== null ||
            claimed.has(projectedId))
        ) {
          continue;
        }
        const owner = this.ledger.stableOwner(target);
        if (owner !== null && owner !== symbol) {
          continue;
        }
        if (uniqueRenamePath(history, anchor, target.name) === null) {
          continue;
        }
        candidates.push({ symbol, target, projectedId });
      }
      const candidate = candidates[0];
      if (candidates.length === 1 && candidate !== undefined) {
        selected.push(candidate);
      } else {
        deferred.push(...candidates);
      }
    }

    const accepted = uncontended(selected).filter((claim) =>
      this.ledger.canBind(claim.symbol, claim.target)
    );
    const acceptedSet = new Set(accepted);
    for (const claim of accepted) {
      this.ledger.bind(claim.symbol, claim.target);
    }
    // Recompute the provisional markers from the claims still live this call:
    // an accepted, refuted, or disappeared claim releases its target, and a
    // released ordinary definition then promotes through mintOrGet on read.
    this.#provisionalRenameTargets.clear();
    for (const claim of [...selected, ...deferred]) {
      if (acceptedSet.has(claim) || claim.projectedId === claim.symbol) {
        continue;
      }
      if (this.ledger.stableOwner(claim.target) === null) {
        this.#provisionalRenameTargets.add(bindingKey(claim.target));
      }
    }
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
    // (1) Current binding + the live occurrence set from a SINGLE fresh
    // extraction, so the definition and the reference set can't desync — two
    // separate extractions would leave a window where a write between them
    // changes the caller set the rewrite pass then misses (a TOCTOU).
    const from = this.ledger.currentName(symbolId);
    const model = await this.#model();
    const def = model.defs.find((d) => d.symbol === symbolId) ?? null;
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
    const refs = model.refs.filter((r) => r.symbol === symbolId);

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

  // The signed structural records for a symbol, in the order the renames were
  // applied (the SymbolOpLog's insertion order — causal for the single-process
  // spike). Cross-peer ordering under out-of-order wire ingest needs the
  // SymbolOp `base` chain and is deferred (spec §11). Empty if never renamed.
  history(symbolId: string): readonly SymbolOp[] {
    return this.#ops.forSymbol(symbolId);
  }
}
