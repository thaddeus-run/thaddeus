import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'Strata Docs — Thaddeus',
  description:
    'Documentation for Strata, the live, permissioned, agent-native code substrate from Thaddeus.',
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return (
    <html lang="en">
      <body>
        <header className="site-nav">
          <div className="site-nav__inner">
            <a className="site-nav__brand" href="/">
              Strata
            </a>
            <nav className="site-nav__links" aria-label="Primary">
              <a href="/">Permission model</a>
              <a href="/concepts">Concepts</a>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
