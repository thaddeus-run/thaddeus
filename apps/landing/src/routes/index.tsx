import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';

export const Route = createFileRoute('/')({
  component: LandingPage,
});

function LandingPage(): ReactNode {
  return (
    <main className="landing">
      <h1 className="wordmark">Thaddeus</h1>
      <p className="deck">
        Source control is the wrong category. Thaddeus is the one that replaces
        it — a live, permissioned, agent-native code substrate for an age of
        secrets, coordinated security, private-by-default work, and a million
        agents writing code in parallel.
      </p>
      <p className="by">
        A <strong>Thaddeus</strong> project.
      </p>
    </main>
  );
}
