import { describe, expect, test } from 'bun:test';

import type { Backend } from '../src/backend';
import { scoped } from '../src/scoped';

// A minimal in-test backend backed by a Map.
function mapBackend(): Backend {
  const m = new Map<string, Uint8Array>();
  return {
    put: async (k, b) => void m.set(k, new Uint8Array(b)),
    get: async (k) => {
      const v = m.get(k);
      return v === undefined ? undefined : new Uint8Array(v);
    },
    list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
    delete: async (k) => void m.delete(k),
  };
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('scoped', () => {
  test('two scopes over the same base backend do not collide', async () => {
    const base = mapBackend();
    const a = scoped(base, 'repo/a/');
    const b = scoped(base, 'repo/b/');

    await a.put('view/main', enc('A'));
    await b.put('view/main', enc('B'));

    expect(dec((await a.get('view/main'))!)).toBe('A');
    expect(dec((await b.get('view/main'))!)).toBe('B');
  });

  test('list strips the prefix and returns only keys within the scope', async () => {
    const base = mapBackend();
    const a = scoped(base, 'repo/a/');
    const b = scoped(base, 'repo/b/');

    await a.put('op/x', enc('x'));
    await a.put('op/y', enc('y'));
    await b.put('op/z', enc('z'));

    expect([...(await a.list('op/'))].sort()).toEqual(['op/x', 'op/y']);
    expect([...(await b.list('op/'))]).toEqual(['op/z']);
  });

  test('delete removes only the scoped key', async () => {
    const base = mapBackend();
    const a = scoped(base, 'repo/a/');
    const b = scoped(base, 'repo/b/');

    await a.put('k', enc('a'));
    await b.put('k', enc('b'));
    await a.delete('k');

    expect(await a.get('k')).toBeUndefined();
    expect(dec((await b.get('k'))!)).toBe('b');
  });
});
