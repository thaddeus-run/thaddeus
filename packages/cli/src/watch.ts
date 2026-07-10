import { Client } from '@thaddeus.run/client';
import { Workspace } from '@thaddeus.run/fs';
import { HeuristicExtractor, SymbolGraph } from '@thaddeus.run/graph';
import type { Identity } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import {
  type EventKind,
  type SemanticEvent,
  SemanticWatcher,
} from '@thaddeus.run/watch';

export type WatchSleep = (
  milliseconds: number,
  signal: AbortSignal
) => Promise<void>;

export interface WatchRemoteOptions {
  readonly server: string;
  readonly repo: string;
  readonly view: string;
  readonly identity: Identity;
  readonly fetchImpl?: (request: Request) => Promise<Response>;
  readonly symbol?: string;
  readonly kinds?: readonly EventKind[];
  readonly intervalMs: number;
  readonly signal: AbortSignal;
  readonly sleep?: WatchSleep;
  readonly onEvent: (event: SemanticEvent) => void;
  readonly onError: (error: Error) => void;
}

export function parseWatchInterval(value?: string): number {
  if (value === undefined) {
    return 2_000;
  }
  const match = /^(\d+)(ms|s|m)$/.exec(value);
  if (match === null) {
    throw new RangeError(`invalid watch interval: ${value}`);
  }
  const amount = Number(match[1]);
  const multiplier = match[2] === 'ms' ? 1 : match[2] === 's' ? 1_000 : 60_000;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RangeError(`invalid watch interval: ${value}`);
  }
  if (milliseconds < 100) {
    throw new RangeError('watch interval must be at least 100ms');
  }
  return milliseconds;
}

export async function resolveWatchSymbol(
  graph: SymbolGraph,
  value: string
): Promise<string> {
  const named = await graph.resolve(value);
  if (named !== null) {
    return named;
  }
  const matches = (await graph.symbols()).filter((symbol) =>
    symbol.id.startsWith(value)
  );
  if (matches.length === 0) {
    throw new Error(`no symbol matching ${value}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `ambiguous symbol prefix ${value} (${matches.length} matches)`
    );
  }
  return matches[0].id;
}

export function formatSemanticEvent(event: SemanticEvent): string {
  switch (event.kind) {
    case 'defined':
      return `defined  ${event.symbol}  ${event.name} at ${event.path}`;
    case 'removed':
      return `removed  ${event.symbol}  ${event.name}`;
    case 'renamed':
      return `renamed  ${event.symbol}  ${event.from} → ${event.to}`;
    case 'moved':
      return `moved  ${event.symbol}  ${event.from.path}:${event.from.line} → ${event.to.path}:${event.to.line}`;
    case 'references-changed': {
      const added = event.added.map((ref) => `+${ref.path}:${ref.line}`);
      const removed = event.removed.map((ref) => `-${ref.path}:${ref.line}`);
      return `references-changed  ${event.symbol}  ${[...added, ...removed].join(' ')}`;
    }
  }
}

// Wait for the next polling tick, resolving early when the watch is aborted.
export function abortableSleep(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      // Required in the timer path: `once` only auto-removes when the abort
      // fires, and the signal lives for the whole watch — without this, every
      // tick would leave one more stale listener on it.
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

// Mirror one remote view in memory and emit semantic changes sequentially.
export async function watchRemote(options: WatchRemoteOptions): Promise<void> {
  const backend = new MemoryBackend();
  const client = new Client(
    options.server,
    options.identity,
    options.fetchImpl
  );
  const initial = await client.clone(options.repo, backend, options.view);
  const watchView = 'watch/live';
  const workspace = Workspace.open(initial.repo.log, initial.repo.store, {
    source: options.view,
    reader: options.identity,
    name: watchView,
  });
  const graph = SymbolGraph.over(workspace, {
    extractor: new HeuristicExtractor(),
    ops: initial.symbols,
  });
  await graph.syncRenames(initial.symbols.all());
  const symbol =
    options.symbol === undefined
      ? undefined
      : await resolveWatchSymbol(graph, options.symbol);
  const watcher = await SemanticWatcher.over(graph);
  const subscription = watcher.watch({ symbol, kinds: options.kinds });
  const sleep = options.sleep ?? abortableSleep;

  while (!options.signal.aborted) {
    await sleep(options.intervalMs, options.signal);
    if (options.signal.aborted) {
      break;
    }
    try {
      const pulled = await client.pull(
        options.repo,
        initial.repo,
        backend,
        options.view
      );
      await initial.repo.log.repoint(watchView, [...pulled.heads]);
      // Fold pulled records into the graph's own op log (append dedupes; the
      // pull already persisted them) so graph.history() stays truthful.
      for (const op of pulled.symbols.all()) {
        initial.symbols.append(op);
      }
      await graph.syncRenames(initial.symbols.all());
      await watcher.poll();
      for (const event of subscription.take()) {
        options.onEvent(event);
      }
    } catch (error) {
      options.onError(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
}
