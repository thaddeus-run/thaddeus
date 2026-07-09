# Post-P3 Roadmap

After P3 the plan runs eight more phases, in dependency order. Here's the
sequence and why each sits where it does:

## P4 - Per-repo Policy

Persist a policy record per repo and wire the four gates that exist but are
never imported by the server: `restrictPaths`, `standingQuery`,
`requireVerifiedProvenance`, `requirePassingChecks`. Selectable over the wire,
no restart. This comes before releases because a release is the natural thing
you'd want policy-gated.

## P5 - Releases

A typed, signed `Release { tag, at, signed_by, commits }` record in `platform`,
a server route, `thaddeus release`/`releases`, and a TUI view. Needs P2's
nameable heads and P4 if releases should be gated.

## P6 - Query Surface

Expose `CodeDB` through `thaddeus query`: `why`, `touchedSince`, `by`,
`callers`, and `references`, plus the TUI. This is the payoff for the semantic
graph: the rename op is already first-class, but users cannot ask questions of
it from the CLI yet.

## P7 - Timed Reveal

Add `schedule-reveal` / `reveal`. This is the one phase with a genuine new
server dependency: reveal currently needs a manual trigger, so the server has to
grow a scheduled one.

## P8 - Watch / Subscriptions

Add `thaddeus watch` and live TUI updates. Blocked on P1's `pull`, which is now
in place as the polling primitive.

## P9 - Agent Budgets + Key Revocation

Add per-hour rate windows on delegations; today `--max-changes` is a lifetime
cap. Make `revoke` perform real key rotation and recall.

## P10 - Portable Reputation

Add `reputation export/import` across instances. Contributions are dual-signed
and self-verifying, so they're already portable in principle. This is the "your
reputation is yours, not the platform's" pillar.

## P11 - Hardening & Proof

Add benchmarks proving the Pillar-2 speed claims, the replay-nonce cache for the
signed-request envelope's current 5-minute replay window, outside-reviewer veto,
and TUI write actions.

## Loose Ends

- #14, the S3 backend: the portability/scale lever, deferred.
- Catch A: a `thaddeus track` convenience so a safe `.env` is easy to un-ignore.

## Reprioritization

Pull P9's rotate-and-recall forward, right after P3, ahead of policy, releases,
and query. The direct security gap is that a former DID with a grant could still
clone the repo and receive file keys. Every other remaining phase adds
capability; rotate-and-recall closes a gap between what the product promises and
what it does. Pillar 6 says "revoke his keys", and today revoke only removes
write authority. It is also the last structural change to the capability layer:
the server's cap-union exists specifically because revoke does not yet rotate,
so doing it later means revisiting that code anyway.

Everything after it is additive, so the order past that point is mostly taste.
