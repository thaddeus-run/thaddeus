# P9 Agent Rate Windows Design

**Date:** 2026-07-11 **Status:** Approved

## Context

P9's rotate-and-recall half shipped earlier (pulled forward per the post-P3
roadmap). The remaining half is agent budgets: `Delegation.maxChanges` is a
lifetime cap enforced by `delegationPolicy` against the `AgentRegistry` meter,
so a delegated agent may burn its entire budget in one burst. The roadmap calls
for per-hour rate windows on delegations.

Today the pieces are: a signed
`Delegation { operator, agent, paths, maxChanges, maxSpend }` under the
`thaddeus.delegation.v1` domain tag; an in-memory per-agent meter in
`AgentRegistry` (`{ changes, spend }` running totals, recorded by the server
after a successful land); and `delegationPolicy`, a read-only `LandPolicy` that
rejects a landing when `usage.changes + count > maxChanges`.

## Goals

- An operator can grant `thaddeus grant <did> --max-changes-per-hour N` and the
  server rejects any landing that would push the agent past N ops within the
  trailing hour.
- Existing signed delegations keep verifying unchanged.
- The rate cap composes with (does not replace) the lifetime cap.
- Deterministic tests: no sleeps, no wall-clock coupling.

## Non-goals

- No durable window state. The lifetime meter is already durable server-side
  (`meter/<agent>` records replayed by `buildRegistry`); the hourly window's
  timestamped entries are NOT persisted, so a restart forgets the current hour's
  usage (documented spike behavior). Crucially, the meter replay must bypass
  window accounting — otherwise a restart would stamp an agent's whole lifetime
  total into the current hour and block it for an hour.
- No per-minute/per-day generalization; the window is fixed at one hour. The
  record field is a count, not a `{count, windowMs}` pair — a future window size
  would be a new field under the same dual-verify pattern.
- No spend-rate window; `maxSpend` stays a lifetime cap.
- No retroactive enforcement across restarts or between servers.

## Chosen approach

A sliding one-hour window accounted inside the `AgentRegistry` meter, enforced
by `delegationPolicy` alongside the lifetime check. Chosen over fixed hourly
buckets (which allow a ~2x burst straddling the boundary for no real saving) and
over a policy-side landing ledger (which would split usage accounting across two
owners and make the deliberately stateless policy stateful).

### Record shape and signature compatibility (dual-verify)

`DelegationFields` gains `maxChangesPerHour?: number | null`; `null` or absent
means no rate limit. The property is optional so the ~30 existing
`signDelegation` call sites (and records persisted before the field existed,
which decode without the property) stay valid; canonicalization treats
`undefined` and `null` identically. Canonicalization is presence-keyed:

- `maxChangesPerHour === null` → the canonical tuple is byte-identical to the
  existing v1 tuple. New no-limit grants verify under old code and vice versa.
- `maxChangesPerHour` is a non-negative integer → the canonical tuple appends
  the field after `maxSpend`.

`verifyDelegation` needs no fallback chain: the record's own field value picks
the tuple deterministically. Legacy records decode with
`maxChangesPerHour: null`. `assertCanonical` accepts null or a non-negative
integer (0 is legal: zero changes allowed per hour).

### Registry meter

- `AgentRegistry` takes an optional injectable clock (`now?: () => number`,
  default `Date.now`) at construction.
- `record(agent, changes, spend)` additionally appends `{ at: now(), changes }`
  to a per-agent window list, pruning entries older than one hour.
- New method `replayMeter(agent, changes, spend)` restores lifetime totals
  WITHOUT touching the window list; the server's `buildRegistry` meter replay
  switches to it so a restart never attributes historical changes to the current
  hour.
- New accessor `recentChanges(agent): number` returns the pruned sum of changes
  within the trailing hour. `usage()` (lifetime totals) is unchanged.
- Re-registering a delegation continues to NOT reset the meter — neither the
  lifetime totals nor the window.

### Enforcement

`delegationPolicy` adds one check per agent in the projected landing, after the
lifetime check: when the agent's delegation has a non-null `maxChangesPerHour`
and `recentChanges(agent) + count > maxChangesPerHour`, reject with reason
`agent <did> is over its hourly rate window` (distinct from the lifetime
`over its change budget` reason). Exempt authors (the repo owner) skip both, as
today.

### Wire and CLI surface

- `encodeDelegation`/`decodeDelegation` (server DTO) carry the field; a missing
  field decodes to `null`.
- `thaddeus grant <did> [--paths a,b] [--max-changes N] [--max-changes-per-hour N]`
  — absent means `null` (no rate limit); validation mirrors `--max-changes`
  (non-negative integer, exit 2 with a terse message otherwise).
- `thaddeus grants` output includes the rate cap when present.

## Error and concurrency behavior

- Fail-closed like every other delegation check: a landing that would exceed the
  window is rejected atomically under the repo lock; nothing is recorded for
  rejected landings.
- The window list is only mutated via `record()` under the server's existing
  land path; reads prune lazily, so an idle agent's stale entries cost nothing
  until the next check.

## Testing

- `delegation.test`: a null-field record signs to the exact v1 bytes; a
  pre-existing v1-signed record verifies; a rate-capped record round-trips and
  verifies; tampering with `maxChangesPerHour` breaks verification; canonical
  rejection of negatives/non-integers.
- `registry.test`: windowed accounting with an injected clock — entries expire
  after one hour, pruning keeps totals exact, lifetime totals unaffected,
  re-register preserves both meters.
- `policy.test`: a landing inside the window that exceeds the cap is rejected
  with the hourly reason; the same landing after the clock advances past the
  window is allowed; lifetime and hourly caps compose (whichever trips first
  rejects); null cap never rejects; owner exemption skips the window.
- `server` integration: grant with a rate cap over the wire, land up to the cap,
  next land rejected, advance beyond restart (registry reload) documents the
  in-memory reset.
- `cli`: flag parsing, validation errors, `grants` output.

## Documentation and roadmap

Update CLI help/README, getting-started, CHANGELOG, and the post-P3 roadmap (P9
gains its budget "Shipped" note; also backfill the missing Shipped markers for
P4, P5, and rotate-and-recall while touching the file).
