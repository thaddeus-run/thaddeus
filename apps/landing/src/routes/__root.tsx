import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from '@tanstack/react-router';
import { MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';

import appCss from '@/styles.css?url';

// Runs before first paint: applies the saved theme, or the OS preference, as a
// class on <html> so the page never flashes the wrong colours. useTheme reads
// the result once React mounts.
const themeInit = `(function(){try{var s=localStorage.getItem('thaddeus-theme');var d=s?s==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;if(d)document.documentElement.classList.add('dark')}catch(e){}})();`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Thaddeus, source control for a thousand agents' },
      {
        name: 'description',
        content:
          'Source control built for many agents editing one repository at once. Copy-on-write workspaces, signed operations with a signed why, and merge as policy with a standing human veto.',
      },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent(): ReactNode {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        <HeadContent />
      </head>
      <body>
        {/* reducedMotion="user" drops transform and layout animations for
            visitors who prefer reduced motion and keeps opacity fades. */}
        <MotionConfig reducedMotion="user">
          <Outlet />
        </MotionConfig>
        <Scripts />
      </body>
    </html>
  );
}
