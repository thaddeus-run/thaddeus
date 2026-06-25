# @thaddeus.run/agent

Agents as first-class principals for **Strata** (working name) — Pillar 09.

An agent is a `did:key`, distinct from the human who operates it. An operator
signs a `Delegation` — a scoped, budgeted grant of authority (`paths`,
`maxChanges`, `maxSpend`) — that makes a change by the agent verifiably
attributable to the operator. `AgentRegistry` holds verified delegations, a
quarantine set, and a per-agent meter; it rejects forged grants.
`delegationPolicy` is a fail-closed `LandPolicy`: at `Repo.land` it rejects an
op whose author is revoked, undelegated, out of scope, or over budget —
substrate-enforced, not by hope. Revocation is `registry.revoke` (quarantine)
plus `store.revoke` (key rotation, P01).

> **Status: spike.** In-memory, single process. Reputation tiers (P10), the paid
> economy leg, per-symbol scope (P08), and per-hour rate limits are deferred
> (see the design spec).
