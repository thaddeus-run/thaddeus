# @thaddeus.run/reputation

Portable, federated reputation for **Thaddeus** — Pillar 07.

A `Contribution` is a dual-signed record of a merge/review/release: `subj_sig`
(the subject's five-field self-claim: subject, repo, ref, kind, at) and
`host_sig` (the host's six-field attestation: subject, host, repo, ref, kind,
at). `verifyContribution` returns `{ authentic, attested }` — any holder of the
record and the two `did:key`s verifies it alone, with no trust in any server. A
`ReputationLog` is an untrusted, keep-and-label aggregator whose `profile` is
the gathered, self-verifying record set (attested vs claimed, counted by kind) —
reputation is the records, not a number.

> **Status: spike.** In-memory, single process. Network transport, the two-party
> co-sign handshake, scoring/tiers, and revocation are deferred (see the design
> spec).
