import { useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useState } from 'react';

import { Cursor } from './cursor';
import { Section } from './section';

const endings = [
  'for a thousand agents.',
  'after Git.',
  'with a signed why.',
  'where merge is policy.',
];

const TYPE_MS = 90;
const DELETE_MS = 45;
const HOLD_MS = 3200;

// Types and erases the tagline endings. The line reserves two rows of height
// so the paragraph below never moves.
function Tagline(): ReactNode {
  const reduced = useReducedMotion() === true;
  const [text, setText] = useState(endings[0] ?? '');

  useEffect(() => {
    if (reduced) return undefined;
    let ending = 0;
    let pos = (endings[0] ?? '').length;
    // The first ending is already on screen in full, so the cycle starts by
    // erasing it after the initial hold.
    let deleting = true;
    let timer = 0;
    const step = (): void => {
      const current = endings[ending] ?? '';
      let delay = TYPE_MS;
      if (deleting) {
        pos -= 1;
        delay = DELETE_MS;
        if (pos === 0) {
          deleting = false;
          ending = (ending + 1) % endings.length;
        }
      } else {
        pos += 1;
        if (pos === current.length) {
          deleting = true;
          delay = HOLD_MS;
        }
      }
      setText(current.slice(0, pos));
      timer = window.setTimeout(step, delay);
    };
    timer = window.setTimeout(step, HOLD_MS);
    return () => clearTimeout(timer);
  }, [reduced]);

  return (
    <p className="text-ink min-h-[3.2em] text-[15px] leading-relaxed">
      Thaddeus is source control {text}
      <Cursor className="ml-0.5" />
    </p>
  );
}

export function About(): ReactNode {
  return (
    <Section title="About.">
      <div className="text-muted grid gap-7 text-[13px] leading-[1.7] md:grid-cols-2">
        <div>
          <Tagline />
          <p className="mt-4">
            Open source under Apache-2.0, written in TypeScript and Rust, and
            pre-alpha. Interfaces still move.
          </p>
        </div>
        <p>
          Built in the open by a small team. The thesis: Git was built for one
          person at one keyboard, and the next decade of software will be
          written by many agents at once. Placeholder copy, to be replaced with
          the team&rsquo;s own words.
        </p>
      </div>
    </Section>
  );
}
