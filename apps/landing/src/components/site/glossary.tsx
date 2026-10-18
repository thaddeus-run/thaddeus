import { motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useState } from 'react';

import { Cursor } from './cursor';
import { Section } from './section';
import { glossary } from '@/content/glossary';
import { cn } from '@/lib/cn';
import { useInterval } from '@/lib/use-interval';

const DWELL_MS = 6000;

// The glossary reads itself: a block cursor rests after one term at a time and
// moves down the list every few seconds, lifting that definition from muted
// to ink. With reduced motion it stays on the first term.
export function Glossary(): ReactNode {
  const reduced = useReducedMotion() === true;
  const [active, setActive] = useState(0);
  useInterval(
    () => setActive((i) => (i + 1) % glossary.length),
    reduced ? null : DWELL_MS
  );

  return (
    <Section
      title="Glossary."
      intro="Thaddeus borrows a few words from Git and made up some others. What they mean here, in the order you tend to meet them."
    >
      <dl className="border-rule border-t">
        {glossary.map((entry, i) => {
          const isActive = i === active;
          return (
            <div
              key={entry.term}
              className="border-rule-soft grid gap-x-6 gap-y-1 border-b py-3 text-[13px] md:grid-cols-[180px_minmax(0,1fr)]"
            >
              <dt className="flex items-center gap-2">
                {entry.term}
                {isActive ? (
                  <motion.span
                    layoutId="glossary-cursor"
                    transition={{ duration: 0.8, ease: [0.2, 0.7, 0.2, 1] }}
                    className="inline-flex"
                  >
                    <Cursor />
                  </motion.span>
                ) : null}
              </dt>
              <dd
                className={cn(
                  'max-w-[72ch] text-xs leading-relaxed transition-colors duration-700',
                  isActive ? 'text-ink' : 'text-muted'
                )}
              >
                {entry.definition}
              </dd>
            </div>
          );
        })}
      </dl>
    </Section>
  );
}
