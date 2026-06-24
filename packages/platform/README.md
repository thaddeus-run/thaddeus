# @thaddeus.run/platform

The platform for **Strata** (working name) — Pillar 06.

A `Platform` allocates named repos (scopes) in one call (`createRepo`) or by
bare reference (`open` auto-vivifies). A `Repo` owns its own operation log +
store and a `main` shared view; the `@thaddeus.run/fs` `Workspace` opens over it
unchanged.

`Repo.land` is **landing-as-policy**: it re-points a shared view to include a
workspace's committed heads, gated by a pluggable `LandPolicy`, surfacing P03
conflicts and **failing closed** (a rejected landing leaves the target
untouched). Ships `allowAll`, `blockOnConflict`, and `requireVerifiedProvenance`
— the seam Pillar 10 fills with review and reputation gates.

> **Status: spike.** In-memory, single process. The throughput envelope,
> discoverability-as-query, typed releases, and mirror/peer transport are
> deferred (see the design spec).
