import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

// Shared vertical rhythm and heading style for every page section.
export function Section({
  title,
  intro,
  children,
  className,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section className={cn('px-7 pt-16', className)}>
      <h2 className="max-w-[30ch] text-[22px] tracking-[-0.02em]">{title}</h2>
      {intro !== undefined ? (
        <p className="text-muted mt-2 max-w-[60ch] text-[13px] leading-relaxed">
          {intro}
        </p>
      ) : null}
      <div className="mt-6">{children}</div>
    </section>
  );
}
