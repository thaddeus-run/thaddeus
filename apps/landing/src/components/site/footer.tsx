import type { ReactNode } from 'react';

import { site } from '@/content/site';

export function Footer(): ReactNode {
  return (
    <footer className="border-rule text-muted mt-16 flex flex-wrap justify-between gap-x-6 gap-y-2 border-t px-7 pt-[18px] pb-[22px] text-xs">
      <span>2026 Thaddeus. Apache-2.0.</span>
      <span className="flex flex-wrap gap-x-4 gap-y-1">
        <a className="hover:text-ink" href={site.links.github}>
          [github]
        </a>
        <a className="hover:text-ink" href={site.links.status}>
          [status]
        </a>
        <a className="hover:text-ink" href={site.links.email}>
          [{site.contactEmail}]
        </a>
      </span>
    </footer>
  );
}
