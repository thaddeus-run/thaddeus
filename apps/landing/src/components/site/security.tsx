import { useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useState } from 'react';

import { Section } from './section';
import { cn } from '@/lib/cn';
import { useInterval } from '@/lib/use-interval';

const HEX = '0123456789abcdef';
const COLS = 39;
const LINES = 12;
const FLICKER_MS = 300;
const REVEAL_EVERY_MS = 12000;
const REVEAL_FOR_MS = 3000;

// What the object decrypts to while a capability is held.
const plaintext = [
  'export function land(c, policy) {',
  '  const ops = verifyAll(c.operations);',
  '  for (const op of ops) {',
  '    if (policy.protects(op.path))',
  "      refuse(op, 'protected path');",
  '    if (!policy.budget.allows(op))',
  "      refuse(op, 'budget exhausted');",
  '  }',
  '  if (policy.vetoes.standing(c))',
  "    refuse(c, 'reviewer veto');",
  '  return owner.sign(advance(ops));',
  '}',
].join('\n');

// Small seeded generator so the server and first client render agree.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ciphertext(random: () => number): string {
  const lines: string[] = [];
  for (let i = 0; i < LINES; i += 1) {
    let line = '';
    for (let j = 0; j < COLS; j += 1) {
      line += j % 8 === 7 ? ' ' : HEX[Math.floor(random() * 16)];
    }
    lines.push(line);
  }
  return lines.join('\n');
}

const points: Array<[string, string]> = [
  [
    'Objects are encrypted and content-addressed.',
    'A mirror can verify them without reading them.',
  ],
  [
    'The shipped server holds no keys.',
    'It verifies signatures and serves ciphertext.',
  ],
  ['Writes are signed and nonce-bound.', 'Replays are rejected.'],
  [
    'Attestation signs with AWS KMS.',
    'Private key bytes never reach the process.',
  ],
  [
    'Apache-2.0.',
    'The server, the CLI and every package are public on GitHub.',
  ],
];

// A sealed object: ciphertext that keeps changing, briefly resolved to
// plaintext while a capability is held, then sealed again.
export function Security(): ReactNode {
  const reduced = useReducedMotion() === true;
  const [cipher, setCipher] = useState(() => ciphertext(mulberry32(41)));
  const [open, setOpen] = useState(false);

  useInterval(
    () => {
      if (!open) setCipher(ciphertext(Math.random));
    },
    reduced ? null : FLICKER_MS
  );

  useInterval(() => setOpen(true), reduced ? null : REVEAL_EVERY_MS);

  useEffect(() => {
    if (!open) return undefined;
    const id = setTimeout(() => setOpen(false), REVEAL_FOR_MS);
    return () => clearTimeout(id);
  }, [open]);

  return (
    <Section title="Security.">
      <div className="grid items-start gap-7 md:grid-cols-2">
        <div className="border-rule bg-surface overflow-hidden rounded-md border">
          <div className="border-rule text-muted flex justify-between border-b px-3 py-[9px] text-[11.5px]">
            <span>object 3f9a2c…b71e</span>
            <span className="text-accent">
              {open ? 'capability granted, plaintext' : 'sealed'}
            </span>
          </div>
          <pre
            className={cn(
              'm-0 h-[208px] overflow-hidden p-3 text-[11.5px] leading-normal whitespace-pre',
              open ? 'text-ink' : 'text-muted'
            )}
          >
            {open ? plaintext : cipher}
          </pre>
        </div>
        <ul className="border-rule m-0 list-none border-t p-0 text-[13px]">
          {points.map(([lead, rest]) => (
            <li
              key={lead}
              className="border-rule border-b py-[11px] leading-relaxed"
            >
              {lead} <span className="text-muted">{rest}</span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
