import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { Section } from './section';
import { type LedgerOp, ledgerOps } from '@/content/ledger';
import { cn } from '@/lib/cn';
import { useInterval } from '@/lib/use-interval';

interface Row extends LedgerOp {
  id: number;
  time: string;
  settled: boolean;
}

const MAX_ROWS = 8;
const SEED_ROWS = 6;
const NEW_ROW_EVERY_MS = 5000;
const VERIFY_FOR_MS = 1800;

function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds / 60) % 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function decision(op: LedgerOp): string {
  if (op.state === 'landed') return 'landed';
  if (op.state === 'refused') return `refused: ${op.note ?? ''}`;
  return `vetoed by ${op.note ?? ''}`;
}

// Deterministic so the server and the first client render agree.
function seedRows(): { rows: Row[]; next: number; clock: number } {
  const rows: Row[] = [];
  let clock = 7 * 3600 + 2 * 60 + 7;
  for (let i = 0; i < SEED_ROWS; i += 1) {
    const op = ledgerOps[i % ledgerOps.length];
    if (op === undefined) continue;
    clock += 1 + (i % 3);
    rows.unshift({ ...op, id: i, time: formatClock(clock), settled: true });
  }
  return { rows, next: SEED_ROWS, clock };
}

// The live operation log: a new signed operation arrives every few seconds,
// shows as "verifying signature", then settles into landed, refused or vetoed.
//
// The box has a fixed height, but inserting a row still shifts the rows below
// it in layout. Browsers with scroll anchoring (Chrome, Firefox) treat that as
// content moving under the reader and scroll the page to follow it, which
// reads as the page jumping every few seconds. overflow-anchor: none tells
// them to anchor on something outside the log instead.
export function Ledger(): ReactNode {
  const reduced = useReducedMotion() === true;
  const [seed] = useState(seedRows);
  const [rows, setRows] = useState<Row[]>(seed.rows);
  const counter = useRef(seed.next);
  const clock = useRef(seed.clock);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => clearTimeout(t));
  }, []);

  const addRow = useCallback(() => {
    const index = counter.current;
    counter.current += 1;
    clock.current += 1 + (index % 3);
    const op = ledgerOps[index % ledgerOps.length];
    if (op === undefined) return;
    const row: Row = {
      ...op,
      id: index,
      time: formatClock(clock.current),
      settled: false,
    };
    setRows((prev) => [row, ...prev].slice(0, MAX_ROWS));
    const t = window.setTimeout(() => {
      setRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, settled: true } : r))
      );
    }, VERIFY_FOR_MS);
    timers.current.push(t);
  }, []);

  useInterval(addRow, reduced ? null : NEW_ROW_EVERY_MS);

  return (
    <Section
      title="The operation log."
      intro="One repository while agents work on it. Each operation arrives signed, with a signed why, and landing accepts, refuses or vetoes it."
    >
      <div
        className="border-rule bg-surface overflow-hidden rounded-md border [overflow-anchor:none]"
        aria-label="Live operation log"
      >
        <div className="border-rule text-muted flex items-center justify-between border-b px-3.5 py-2.5 text-xs">
          <span>acme/web, shared view main</span>
          <span className="inline-flex items-center gap-2">
            <i className="animate-pulse-dot bg-accent size-1.5 rounded-full" />
            operations landing
          </span>
        </div>
        <div className="relative h-[352px] overflow-hidden">
          <AnimatePresence initial={false}>
            {rows.map((row) => (
              <motion.div
                key={row.id}
                layout
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.8, ease: [0.2, 0.7, 0.2, 1] }}
                className="border-rule-soft grid grid-cols-[66px_minmax(0,1fr)] gap-x-3.5 gap-y-[3px] border-b px-3.5 py-2.5 text-[12.5px] leading-[1.45] sm:grid-cols-[66px_minmax(0,1fr)_auto]"
              >
                <span className="text-muted">{row.time}</span>
                <span className="truncate">
                  <span className="text-muted">{row.who}</span> {row.op}
                </span>
                <span
                  className={cn(
                    'col-start-2 transition-colors duration-300 sm:col-auto sm:whitespace-nowrap',
                    !row.settled && 'text-muted',
                    row.settled && row.state === 'landed' && 'text-accent',
                    row.settled && row.state !== 'landed' && 'text-refuse'
                  )}
                >
                  {row.settled ? decision(row) : 'verifying signature'}
                </span>
                <span className="text-muted col-span-2 col-start-2 truncate italic">
                  “{row.why}”
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
          <div className="to-surface pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-b from-transparent" />
        </div>
      </div>
    </Section>
  );
}
