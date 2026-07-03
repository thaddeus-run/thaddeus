# @thaddeus.run/platform

The platform for **Thaddeus** — Pillar 06.

A `Platform` allocates named repos (scopes) in one call (`createRepo`) or by
bare reference (`open` auto-vivifies). A `Repo` owns its own operation log +
store and a `main` shared view; the `@thaddeus.run/fs` `Workspace` opens over it
unchanged.

`Repo.land` is **landing-as-policy**: it re-points a shared view to include a
workspace's committed heads, gated by a pluggable `LandPolicy`, surfacing P03
conflicts and **failing closed** (a rejected landing leaves the target
untouched). Ships `allowAll`, `blockOnConflict`, `requireVerifiedProvenance`,
`requireReputationTier` — Pillar 10's reputation gate, allowing a landing only
when every incoming op's author has enough attested `merge` contributions (P07)
— and `requirePassingChecks` — Pillar 10's test/proof gate, allowing a landing
only when every incoming op carries a verified provenance record from an
automated checker (a CI runner, a proof engine), rather than a human reading a
diff.

> **Status: spike.** In-memory, single process. The throughput envelope,
> discoverability-as-query, typed releases, and mirror/peer transport are
> deferred (see the design spec).
