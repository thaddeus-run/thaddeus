'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';

import PackageFlows from './package-flows';

// The demo runs the real @thaddeus.run/identity + store (libsodium WASM) in the
// browser, so it must never render on the server — ssr:false keeps the crypto
// module graph out of the build's prerender entirely.
const PermissionModelDemo = dynamic(() => import('./permission-model-demo'), {
  ssr: false,
  loading: () => (
    <p className="pm-loading">starting the substrate in your browser…</p>
  ),
});

export default function HomePage(): ReactNode {
  return (
    <main className="pm-shell">
      <p className="pm-eyebrow">Thaddeus · permission model</p>
      <h1 className="pm-h1">Permission lives on the secret, not the repo.</h1>
      <p className="pm-lede">
        One encrypted object, two people. The bytes stay sealed at rest — a
        mirror can verify them without ever reading them. Grant Bob a capability
        and his view resolves to plaintext; revoke it and the key rotates in
        front of you. Nothing here is faked: it&rsquo;s the real{' '}
        <code>@thaddeus.run/identity</code> and <code>@thaddeus.run/store</code>{' '}
        running in your browser.
      </p>

      <PermissionModelDemo />

      <PackageFlows />

      <p className="pm-foot">
        Built on Pillar 01 — encrypted objects with per-object capabilities.
        Access is a content key <code>seal</code>ed to an identity; revoke
        rotates that key and re-issues it to whoever is left. Revocation is
        forward-only: it closes the door going forward — it can&rsquo;t un-read
        what was already read.
      </p>
    </main>
  );
}
