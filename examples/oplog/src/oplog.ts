// Operation-log demo for @thaddeus.run/log (Pillar 03).
// Run: CI= moon run oplog:demo
//
// Two acts: (1) convergence + zero-copy views; (2) an embargoed op whose public
// view is only an opaque ordering token until a scheduled reveal at T.

import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const rule = (): void => console.log('—'.repeat(60));

await ready();
const store = new MemoryStore();
const author = Identity.create();
const log = new OpLog(store);

// Act 1 — convergence + views.
const a = await log.write('main', 'a.ts', enc('a1'), author);
await log.write('main', 'b.ts', enc('b1'), author);
await log.write('main', 'a.ts', enc('a2'), author);
console.log('1. main materializes to:', [...log.materialize('main').keys()]);

log.fork('feature', 'main');
await log.write('feature', 'a.ts', enc('a3'), author);
console.log(
  '2. fork is zero-copy; main head still:',
  log.heads('main'),
  '(base',
  `${a.id.slice(0, 8)}…)`
);

// Order independence: replay the same ops reversed into a fresh log.
const replay = new OpLog(store);
for (const op of [...log.ops()].reverse()) replay.append(op);
const key = (l: OpLog): string =>
  [...l.materialize().entries()]
    .map(([p, { op }]) => `${p}=${op.id.slice(0, 6)}`)
    .sort()
    .join(',');
console.log('3. order-independent projection:', key(log) === key(replay));
rule();

// Act 2 — embargoed op.
const T = '2030-01-01T00:00:00.000Z';
const beforeT = '2026-06-23T00:00:00.000Z';
const fix = await log.write(
  'main',
  'src/auth.ts',
  enc('constant-time compare'),
  author,
  { embargoUntil: T }
);
console.log(
  '4. public view of the fix:',
  JSON.stringify(log.publicView(fix.id))
);
console.log(
  '   public materialize places src/auth.ts?',
  log.materialize('main').has('src/auth.ts')
);
console.log('5. reveal before T:', await log.reveal(fix.id, beforeT));
console.log('   reveal at T:', await log.reveal(fix.id, T));
console.log(
  '   public materialize places src/auth.ts now?',
  log.materialize('main').has('src/auth.ts')
);
rule();
console.log(
  'the log is the truth · views are pointers · an embargoed op leaks only a token until T'
);
