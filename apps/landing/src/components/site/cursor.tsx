import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

// The blinking block cursor from the README wordmark ("THADDEUS █").
export function Cursor({ className }: { className?: string }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-[15px] w-[9px] animate-blink bg-ink align-[-2px]',
        className
      )}
    />
  );
}
