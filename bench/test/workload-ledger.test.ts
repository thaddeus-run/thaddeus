import { expect, test } from 'bun:test';

import { Ledger } from '../src/workload/ledger';
import { fileContent } from '../src/workload/schedule';

const REPO = 'bench/hot';
const PATH = 'agents/a0/f0.ts';

function main(entries: [string, number][]): Map<string, string> {
  return new Map(
    entries.map(([path, token]) => [path, fileContent(path, token)])
  );
}

test('an acknowledged file on main with its content passes', () => {
  const ledger = new Ledger();
  ledger.attempt(REPO, [{ path: PATH, token: 1 }]);
  ledger.ack(REPO, [{ path: PATH, token: 1 }]);
  expect(ledger.check(REPO, main([[PATH, 1]]))).toEqual({
    checked: 1,
    violations: [],
  });
});

test('an acknowledged file missing from main is a violation', () => {
  const ledger = new Ledger();
  ledger.attempt(REPO, [{ path: PATH, token: 1 }]);
  ledger.ack(REPO, [{ path: PATH, token: 1 }]);
  const { violations } = ledger.check(REPO, new Map());
  expect(violations).toHaveLength(1);
  expect(violations[0]).toContain('missing from main');
});

test('main rolled back to an older acknowledged version is a violation', () => {
  const ledger = new Ledger();
  for (const token of [1, 2]) {
    ledger.attempt(REPO, [{ path: PATH, token }]);
    ledger.ack(REPO, [{ path: PATH, token }]);
  }
  const { violations } = ledger.check(REPO, main([[PATH, 1]]));
  expect(violations).toHaveLength(1);
  expect(violations[0]).toContain('#2');
});

test('a later write whose answer was lost may be what main holds', () => {
  const ledger = new Ledger();
  ledger.attempt(REPO, [{ path: PATH, token: 1 }]);
  ledger.ack(REPO, [{ path: PATH, token: 1 }]);
  ledger.attempt(REPO, [{ path: PATH, token: 2 }]);
  expect(ledger.check(REPO, main([[PATH, 2]])).violations).toEqual([]);
  expect(ledger.check(REPO, main([[PATH, 1]])).violations).toEqual([]);
});

test('a write that was never acknowledged is not required', () => {
  const ledger = new Ledger();
  ledger.attempt(REPO, [{ path: PATH, token: 1 }]);
  expect(ledger.check(REPO, new Map())).toEqual({ checked: 0, violations: [] });
});

test('a refused path that reached main is a violation', () => {
  const ledger = new Ledger();
  ledger.forbid(REPO, 'probe/a0-3.ts');
  expect(ledger.check(REPO, new Map()).violations).toEqual([]);
  const { violations } = ledger.check(REPO, main([['probe/a0-3.ts', 3]]));
  expect(violations).toEqual([
    `${REPO}: refused write probe/a0-3.ts is on main`,
  ]);
});

test('acknowledging a write that was never attempted is a bug', () => {
  expect(() => new Ledger().ack(REPO, [{ path: PATH, token: 1 }])).toThrow(
    'unattempted'
  );
});
