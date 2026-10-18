import { useReducedMotion } from 'motion/react';
import { type ReactNode, useState } from 'react';

import { Section } from './section';
import { features } from '@/content/features';
import { cn } from '@/lib/cn';
import { useInterval } from '@/lib/use-interval';

// A braille spinner, the way a terminal shows work in progress.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Features(): ReactNode {
  const reduced = useReducedMotion() === true;
  const [frame, setFrame] = useState(0);
  useInterval(
    () => setFrame((f) => (f + 1) % SPINNER.length),
    reduced ? null : 140
  );

  return (
    <Section
      title="Features."
      intro="Shipped means it is in the current alpha release. Planned means it is on the build queue and has no date."
    >
      <div className="border-rule grid border-t sm:grid-cols-2">
        {features.map((feature, i) => (
          <div
            key={feature.name}
            className={cn(
              'border-b border-rule py-3.5 text-[13px]',
              i % 2 === 0 ? 'sm:border-r sm:pr-5' : 'sm:pl-5'
            )}
          >
            <span
              className={cn(
                'mb-1.5 block text-[11.5px]',
                feature.status === 'shipped' ? 'text-accent' : 'text-muted'
              )}
            >
              {feature.status === 'shipped' ? (
                '● shipped'
              ) : (
                <>
                  <span className="inline-block w-[1ch]">{SPINNER[frame]}</span>{' '}
                  planned
                </>
              )}
            </span>
            <span className="block">{feature.name}</span>
            <span className="text-muted mt-[3px] block text-xs leading-relaxed">
              {feature.description}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}
