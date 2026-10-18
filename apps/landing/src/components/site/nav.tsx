import type { ReactNode } from 'react';

import { Cursor } from './cursor';
import { ThemeToggle } from './theme-toggle';
import { site } from '@/content/site';

export function Nav(): ReactNode {
  return (
    <header className="border-rule flex items-center justify-between border-b px-7 py-[18px] text-[13px]">
      <a href="/" className="flex items-center gap-2.5 tracking-[0.1em]">
        THADDEUS <Cursor />
      </a>
      <nav className="text-muted flex items-center gap-[18px]">
        <a className="hover:text-ink hidden sm:inline" href={site.links.docs}>
          [docs]
        </a>
        <a className="hover:text-ink hidden sm:inline" href={site.links.github}>
          [github]
        </a>
        <a
          className="hover:text-ink hidden sm:inline"
          href={site.links.changelog}
        >
          [changelog]
        </a>
        <span>{site.version}</span>
        <ThemeToggle />
      </nav>
    </header>
  );
}
