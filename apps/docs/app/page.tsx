import { address } from '@thaddeus.run/store';
import type { ReactNode } from 'react';

// Touch the workspace package so the build/typecheck graph exercises the
// cross-package resolution (docs -> @thaddeus.run/store) end to end.
const sample = address(new TextEncoder().encode('Strata'));

export default function HomePage(): ReactNode {
  return (
    <main
      style={{ maxWidth: '42rem', margin: '0 auto', padding: '6rem 1.5rem' }}
    >
      <h1
        style={{
          fontSize: '2.5rem',
          fontWeight: 700,
          letterSpacing: '-0.02em',
        }}
      >
        Strata Docs
      </h1>
      <p style={{ color: 'var(--thaddeus-muted)', fontSize: '1.125rem' }}>
        Documentation for Strata — the live, permissioned, agent-native code
        substrate from Thaddeus.
      </p>
      <p style={{ marginTop: '2rem', fontFamily: 'ui-monospace, monospace' }}>
        content address of &ldquo;Strata&rdquo;: {sample.slice(0, 16)}…
      </p>
    </main>
  );
}
