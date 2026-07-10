import { ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadIdentity } from '../src/identity';
import { run } from '../src/run';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-query-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface QueryOp {
  id: string;
  path: string;
  at: string;
  author: string;
  lamport: number;
  kind: 'write' | 'delete';
}

describe('thaddeus query', () => {
  test('exposes CodeDB over the current committed branch and keeps why as an alias', async () => {
    const server = createServer({ backend: new MemoryBackend() });
    const fetchImpl = server.fetch.bind(server);
    const home = mkdtempSync(join(tmp, 'home-'));
    const wc = mkdtempSync(join(tmp, 'wc-'));
    const feature = join(tmp, `feature-${randomUUID()}`);
    const out: string[] = [];
    const env = (cwd: string) => ({
      cwd,
      home,
      fetchImpl,
      out: (line: string) => out.push(line),
    });
    const invoke = async (cwd: string, args: string[]): Promise<number> => {
      out.length = 0;
      return run(args, env(cwd));
    };

    expect(await invoke(home, ['init'])).toBe(0);
    expect(await invoke(home, ['create', 'http://t', 'proj'])).toBe(0);
    expect(await invoke(wc, ['clone', 'http://t', 'proj', wc])).toBe(0);

    writeFileSync(
      join(wc, 'auth.rs'),
      'fn refresh() {}\nfn login() {\n  refresh();\n}\n'
    );
    expect(await invoke(wc, ['push', '-m', 'initial auth'])).toBe(0);
    expect(await invoke(wc, ['log', '--json'])).toBe(0);
    const initial = (JSON.parse(out.join('\n')) as { id: string }[])[0];
    expect(initial).toBeDefined();

    writeFileSync(join(wc, 'README.md'), 'second change\n');
    expect(await invoke(wc, ['push', '-m', 'documentation'])).toBe(0);

    expect(
      await invoke(wc, ['query', 'why', initial.id.slice(0, 10), '--json'])
    ).toBe(0);
    const nestedWhy = JSON.parse(out.join('\n')) as {
      op: QueryOp;
      verified: boolean;
      records: { status: string; intent: string; actor: string }[];
    };
    expect(nestedWhy.op.id).toBe(initial.id);
    expect(nestedWhy.verified).toBe(true);
    expect(nestedWhy.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'verified', intent: 'initial auth' }),
      ])
    );

    expect(await invoke(wc, ['why', initial.id.slice(0, 10), '--json'])).toBe(
      0
    );
    expect(JSON.parse(out.join('\n'))).toEqual(nestedWhy);

    const did = loadIdentity(home).did;
    expect(
      await invoke(wc, [
        'query',
        'touched-since',
        '2000-01-01T00:00:00.000Z',
        '--json',
      ])
    ).toBe(0);
    const touched = JSON.parse(out.join('\n')) as QueryOp[];
    expect(touched.map((op) => op.path)).toEqual(['README.md', 'auth.rs']);
    expect(touched[0].lamport).toBeGreaterThan(touched[1].lamport);
    expect(touched.every((op) => op.author === did)).toBe(true);

    expect(
      await invoke(wc, [
        'query',
        'touched-since',
        '2999-01-01T00:00:00.000Z',
        '--json',
      ])
    ).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual([]);
    expect(await invoke(wc, ['query', 'touched-since', 'not-a-date'])).toBe(2);
    expect(out.join('\n')).toContain('invalid timestamp');

    expect(await invoke(wc, ['query', 'by', did, '--json'])).toBe(0);
    expect(
      (JSON.parse(out.join('\n')) as QueryOp[]).map((op) => op.path)
    ).toEqual(['README.md', 'auth.rs']);
    expect(
      await invoke(wc, [
        'query',
        'by',
        did,
        '--since',
        '2999-01-01T00:00:00.000Z',
        '--json',
      ])
    ).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual([]);

    expect(await invoke(wc, ['query', 'callers', 'refresh', '--json'])).toBe(0);
    const callers = JSON.parse(out.join('\n')) as {
      symbol: { id: string; kind: string };
      definition: { name: string; path: string; line: number } | null;
    }[];
    expect(callers).toHaveLength(1);
    expect(callers[0].definition).toEqual(
      expect.objectContaining({ name: 'login', path: 'auth.rs', line: 2 })
    );

    expect(await invoke(wc, ['query', 'references', 'refresh', '--json'])).toBe(
      0
    );
    const references = JSON.parse(out.join('\n')) as {
      symbol: string;
      path: string;
      line: number;
    }[];
    expect(references).toEqual([
      expect.objectContaining({ path: 'auth.rs', line: 3 }),
    ]);
    const refreshId = references[0].symbol;
    expect(
      await invoke(wc, ['query', 'callers', refreshId.slice(0, 10), '--json'])
    ).toBe(0);
    expect((JSON.parse(out.join('\n')) as unknown[]).length).toBe(1);

    expect(await invoke(wc, ['query', 'references', 'login', '--json'])).toBe(
      0
    );
    expect(JSON.parse(out.join('\n'))).toEqual([]);
    expect(await invoke(wc, ['query', 'references', 'missing'])).toBe(1);
    expect(await invoke(wc, ['query', 'callers', 'missing'])).toBe(1);

    // Dirty disk state is deliberately not part of the committed query view.
    writeFileSync(
      join(wc, 'auth.rs'),
      'fn refresh() {}\nfn login() { refresh(); }\nfn dirty() { refresh(); }\n'
    );
    expect(await invoke(wc, ['query', 'callers', 'refresh', '--json'])).toBe(0);
    expect((JSON.parse(out.join('\n')) as unknown[]).length).toBe(1);
    expect(await invoke(wc, ['query', 'callers', 'dirty'])).toBe(1);

    // Another branch shares the durable store, but its op is excluded from a
    // query issued in the original main working copy.
    expect(await invoke(wc, ['branch', 'feature'])).toBe(0);
    expect(await invoke(wc, ['workspace', 'feature', feature])).toBe(0);
    writeFileSync(join(feature, 'feature.rs'), 'fn feature_only() {}\n');
    expect(await invoke(feature, ['push', '--no-land'])).toBe(0);

    expect(
      await invoke(wc, [
        'query',
        'touched-since',
        '2000-01-01T00:00:00.000Z',
        '--json',
      ])
    ).toBe(0);
    expect(
      (JSON.parse(out.join('\n')) as QueryOp[]).map((op) => op.path)
    ).not.toContain('feature.rs');

    expect(
      await invoke(feature, [
        'query',
        'touched-since',
        '2000-01-01T00:00:00.000Z',
        '--json',
      ])
    ).toBe(0);
    expect(
      (JSON.parse(out.join('\n')) as QueryOp[]).map((op) => op.path)
    ).toContain('feature.rs');
  });
});
