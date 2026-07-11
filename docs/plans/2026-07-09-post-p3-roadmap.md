# Post-P3 Roadmap

After P3 the plan runs eight more phases, in dependency order. Here's the
sequence and why each sits where it does:

## P4 - Per-repo Policy

Persist a policy record per repo and wire the four gates that exist but are
never imported by the server: `restrictPaths`, `standingQuery`,
`requireVerifiedProvenance`, `requirePassingChecks`. Selectable over the wire,
no restart. This comes before releases because a release is the natural thing
you'd want policy-gated.

**Shipped:** repos persist a policy record selectable over the wire; the four
gates are enforced at land without a restart.

## P5 - Releases

A typed, signed `Release { tag, at, signed_by, commits }` record in `platform`,
a server route, `thaddeus release`/`releases`, and a TUI view. Needs P2's
nameable heads and P4 if releases should be gated.

**Shipped:** typed, signed `Release` records with a server route,
`thaddeus release`/`releases`, and a lazythad view, gated by P4 policy.

## P6 - Query Surface

Expose `CodeDB` through `thaddeus query`: `why`, `touchedSince`, `by`,
`callers`, and `references`, plus the TUI. This is the payoff for the semantic
graph: the rename op was already first-class, and P6 makes it interrogable from
the CLI and TUI.

**Shipped:** the CLI exposes these as `query why`, `query touched-since`,
`query by`, `query callers`, and `query references` over the current committed
branch, with `why` retained as an alias. Lazythad's `/` palette delegates local,
decryption-bounded queries to the CLI without giving the untrusted server keys
or publishing a plaintext semantic index.

## P7 - Timed Reveal

Add `schedule-reveal` / `reveal`. This is the one phase with a genuine new
server dependency: reveal currently needs a manual trigger, so the server has to
grow a scheduled one.

**Shipped:** `thaddeus schedule-reveal <path> --at <ISO>` creates a signed
public capability locally and sends it to the owner-gated server route. Pending
capabilities are durable, withheld from ordinary pulls, released by the server's
scheduled scan, and immediately usable by any fresh clone after release;
`thaddeus reveal <path>` provides an idempotent manual trigger that still obeys
the server's clock. Recall re-wraps and transports pending reveals so a P9 key
rotation does not break the schedule. The commands reveal committed file
content; path and operation metadata were already visible on the ciphertext
mirror. As specified by the P02 membrane, unattended release is store-honest:
scheduling trusts the selected host not to unwrap or publish the well-known
public capability early. Trustless time-lock crypto remains deferred.

## P8 - Watch / Subscriptions

Add `thaddeus watch` and live TUI updates. Blocked on P1's `pull`, which is now
in place as the polling primitive.

**Shipped:** `thaddeus watch` polls the existing atomic pull route into an
isolated in-memory mirror and streams decryption-bounded semantic events, with
optional stable-symbol/event-kind filters and JSONL output. The silent baseline
and every later diff stay client-side; the command never changes checked-out
files or the durable working-copy store. Lazythad now refreshes in a
single-flight background worker while preserving selection and last-known-good
data. This is live polling, not durable offline delivery, SSE/WebSockets, or a
server-side plaintext semantic index.

## P9 - Agent Budgets + Key Revocation

Add per-hour rate windows on delegations; today `--max-changes` is a lifetime
cap. Make `revoke` perform real key rotation and recall.

**Shipped (rotate-and-recall, pulled forward):** `thaddeus revoke <did>` rotates
every reachable content key and re-wraps for the remaining members; recall
preserves pending reveals across key changes.

**Shipped (budgets):** delegations carry an optional signed `maxChangesPerHour`;
`thaddeus grant <did> --max-changes-per-hour N` bounds ops landed within any
trailing hour, composing with the lifetime cap and enforced server-side at land.
The window is in-memory; durable lifetime meters replay outside it on restart.

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
