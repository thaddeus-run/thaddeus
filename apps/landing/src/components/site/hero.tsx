import type { ReactNode } from 'react';

import { DotLattice } from './dot-lattice';
import { InstallCommand } from './install-command';
import { site } from '@/content/site';

export function Hero(): ReactNode {
  return (
    <section className="dot-grid relative px-7 pt-[76px] lg:grid lg:grid-cols-[minmax(0,1fr)_440px] lg:items-center lg:gap-10 lg:pb-16">
      <div className="relative">
        <h1 className="max-w-[15ch] text-[clamp(38px,8vw,60px)] leading-[1.02] tracking-[-0.045em]">
          Source control for a thousand agents.
        </h1>
        <p className="text-muted mt-[22px] max-w-[58ch] text-[15px] leading-relaxed">
          Built for many agents editing one repository at once.
        </p>
        <div className="mt-[34px] flex flex-wrap items-center gap-x-[18px] gap-y-3.5">
          <InstallCommand />
          <a
            className="text-muted hover:text-ink text-[13px]"
            href={site.links.docs}
          >
            [read the getting-started guide]
          </a>
        </div>
      </div>
      <div className="relative -mx-7 mt-7 h-[340px] lg:mx-0 lg:mt-0 lg:h-[440px]">
        <DotLattice shape="lattice" />
      </div>
    </section>
  );
}
