import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { About } from '@/components/site/about';
import { Features } from '@/components/site/features';
import { Footer } from '@/components/site/footer';
import { Glossary } from '@/components/site/glossary';
import { Hero } from '@/components/site/hero';
import { HowItWorks } from '@/components/site/how-it-works';
import { Ledger } from '@/components/site/ledger';
import { Nav } from '@/components/site/nav';
import { Security } from '@/components/site/security';

export const Route = createFileRoute('/')({
  component: LandingPage,
});

function LandingPage(): ReactNode {
  return (
    <div className="mx-auto max-w-[1120px]">
      <Nav />
      <main>
        <Hero />
        <Ledger />
        <HowItWorks />
        <Features />
        <Security />
        <Glossary />
        <About />
      </main>
      <Footer />
    </div>
  );
}
