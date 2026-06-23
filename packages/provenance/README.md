# @thaddeus.run/provenance

The signed "why" layer for **Strata** (working name) — Pillar 04.

A `Provenance` record attaches the _why_ — actor, actor kind, intent, reasoning,
task, and an optional capability-gated prompt — to an `Op.id` from
`@thaddeus.run/log`. The record is signed by the actor over **all** of its
fields, so nothing on it is malleable on relay. Unsigned or signature-invalid
provenance renders as `unverified` and is kept (not rejected) so a reader sees
the untrustworthy claim flagged rather than silently dropped.

The prompt is stored by reference, never inline: its bytes live in
`@thaddeus.run/store` as a capability-gated object, and the record carries
`prompt_ref = blake3(prompt)` (a tamper-evident binding) plus the store `Ref`
(the gated pointer) — so a prompt containing secrets never enters world-readable
history.

> **Status: spike.** In-memory, single process. Reputation accrual,
> delegation/attestation, and a real `--why` query surface are deferred (see the
> design spec).
