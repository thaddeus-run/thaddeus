# @thaddeus.run/review

The standing human veto for **Thaddeus** — Pillar 10 (review as policy).

Pillar 10 makes merge a _function_ — policy, proof, and reputation replace one
human reading a diff. But one human right survives the automation: a reviewer
may read any change and **veto** it, even one a green policy would merge.
Retiring the mandatory diff review must not retire the veto.

A `Veto` attaches a reviewer's standing "no" to an `Op.id` from
`@thaddeus.run/log`. It is **single-signed** by the reviewer over _all_ of its
fields (`op`, `reviewer`, `reason`, `at`), so nothing on it is malleable on
relay — unlike a `Contribution`, no host co-signature is involved: the veto _is_
the reviewer's own standing authority. An unsigned or signature-invalid veto
renders as `unverified` and is kept (not rejected) so a reader sees the disputed
claim flagged — and, critically, a forged veto can never deny service, because
policy counts only `verified` vetoes.

`@thaddeus.run/platform`'s `blockOnVeto(vetoes, reviewers?)` `LandPolicy` reads
this log at the land seam: a landing that includes any op under a verified
standing veto is rejected. Composed in the floor via `all(...)` (an AND), the
veto overrides every green gate — automation sets the floor, the veto is the
ceiling a person can always lower.

> **Status: spike.** In-memory, single process. Veto revocation, a positive
> approval-required gate, and a server-side review queue are deferred (see the
> design spec).
