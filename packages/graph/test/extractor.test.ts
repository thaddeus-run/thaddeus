import { describe, expect, test } from 'bun:test';

import { HeuristicExtractor } from '../src/symbol';

const ex = new HeuristicExtractor();

describe('HeuristicExtractor', () => {
  test('extracts a function definition', () => {
    const { defs, refs } = ex.extract('src/auth.rs', 'fn refresh() {}\n');
    expect(defs).toEqual([{ name: 'refresh', kind: 'function', line: 1 }]);
    expect(refs).toEqual([]);
  });

  test('a call site is a reference, not a definition', () => {
    const text = 'fn refresh() {}\nfn login() {\n  refresh();\n}\n';
    const { defs, refs } = ex.extract('src/auth.rs', text);
    expect(defs.map((d) => d.name).sort()).toEqual(['login', 'refresh']);
    expect(refs).toEqual([{ name: 'refresh', line: 3 }]);
  });

  test('the `fn` keyword is never a symbol name', () => {
    const { defs, refs } = ex.extract('a.rs', 'fn a() {}\n');
    expect(defs).toEqual([{ name: 'a', kind: 'function', line: 1 }]);
    expect(refs.some((r) => r.name === 'fn')).toBe(false);
  });
});
