import { createSubstrate } from '@thaddeus/core';
import type { ReactNode } from 'react';

// Touch the workspace package so the build/typecheck graph exercises the
// cross-package resolution (docs -> @thaddeus/core) end to end.
const substrate = createSubstrate({ name: 'docs' });

export default function HomePage(): ReactNode {
  return (
    <main
      style={{
        maxWidth: '42rem',
        margin: '0 auto',
        padding: '6rem 1.5rem',
      }}
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
        @thaddeus/core says: {substrate.name} v{substrate.version()}
      </p>
    </main>
  );
}
