import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog, verifyOp } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { StaleRename, SymbolGraph } from '../src/graph';
import { HeuristicExtractor } from '../src/symbol';
import { verifySymbolOp } from '../src/symbolop';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

async function seed(): Promise<{
  ws: Workspace;
  g: SymbolGraph;
  dev: Identity;
}> {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const dev = Identity.create();
  const ws = Workspace.open(log, store, { source: 'main', reader: dev });
  ws.write(
    'src/auth.rs',
    enc('fn refresh() {}\nfn login() {\n  refresh();\n}\n')
  );
  await ws.commit(dev);
  const g = SymbolGraph.over(ws, { extractor: new HeuristicExtractor() });
  return { ws, g, dev };
}

describe('SymbolGraph.rename — one signed op, rendered everywhere', () => {
  test('rename mints one SymbolOp and renders across def + every reference', async () => {
    const { ws, g, dev } = await seed();
    const id = (await g.resolve('refresh'))!;

    const { symbolOp, ops } = await g.rename(id, 'refreshToken', dev);

    // One signed semantic op, targeting the symbol id, not a path.
    expect(verifySymbolOp(symbolOp)).toBe(true);
    expect(symbolOp.kind).toBe('rename-symbol');
    expect(symbolOp.symbol).toBe(id);
    expect(symbolOp.from).toBe('refresh');
    expect(symbolOp.to).toBe('refreshToken');

    // Rendered across every occurrence — def AND call — from that one call.
    const src = dec((await ws.read('src/auth.rs'))!);
    expect(src).toContain('fn refreshToken()');
    expect(src).toContain('refreshToken();');
    expect(src).not.toContain('refresh(');

    // The rendered ops are ordinary signed P03 ops.
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((o) => verifyOp(o))).toBe(true);

    // Identity survived: same id, old name gone.
    expect(await g.resolve('refreshToken')).toBe(id);
    expect(await g.resolve('refresh')).toBeNull();

    // History records the rename.
    expect(g.history(id).map((h) => h.to)).toEqual(['refreshToken']);
  });

  test('a stale rename (the symbol moved under us) is rejected, writes nothing', async () => {
    const { ws, g, dev } = await seed();
    const id = (await g.resolve('refresh'))!;

    // Mutate the def name OUT from under the graph — not through rename — so the
    // ledger still binds `id` to 'refresh' but the text no longer defines it.
    ws.write(
      'src/auth.rs',
      enc('fn renamed() {}\nfn login() {\n  renamed();\n}\n')
    );
    await ws.commit(dev);

    let threw: unknown = null;
    try {
      await g.rename(id, 'somethingElse', dev);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(StaleRename);
    // Nothing was written: the def is still 'renamed', not 'somethingElse'.
    expect(dec((await ws.read('src/auth.rs'))!)).toContain('fn renamed()');
  });

  test('history reflects the order renames were applied (causal, single process)', async () => {
    const { g, dev } = await seed();
    const id = (await g.resolve('refresh'))!;
    await g.rename(id, 'aa', dev);
    await g.rename(id, 'bb', dev);
    expect(g.history(id).map((h) => `${h.from}->${h.to}`)).toEqual([
      'refresh->aa',
      'aa->bb',
    ]);
  });

  test('renaming a symbol to its current name is rejected as a no-op', async () => {
    const { g, dev } = await seed();
    const id = (await g.resolve('refresh'))!;

    let threw: unknown = null;
    try {
      await g.rename(id, 'refresh', dev);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(RangeError);
    // No from===to op is minted for a no-op rename.
    expect(g.history(id)).toEqual([]);
  });

  test('a commit that throws records no rename in history (no phantom entry)', async () => {
    const { ws, g, dev } = await seed();
    const id = (await g.resolve('refresh'))!;

    // Force the render's commit to fail after the writes are staged.
    (ws as unknown as { commit: () => Promise<never> }).commit = () =>
      Promise.reject(new Error('commit failed'));

    let threw = false;
    try {
      await g.rename(id, 'refreshToken', dev);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // The SymbolOp is recorded only after a successful commit, so a failed
    // render leaves the op log empty — history never reports a phantom rename.
    expect(g.history(id)).toEqual([]);
  });
});
