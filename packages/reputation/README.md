# @thaddeus.run/reputation

Portable, federated reputation for **Thaddeus** — Pillar 07.

A `Contribution` is a dual-signed record of a merge/review/release: `subj_sig`
(the subject's five-field self-claim: subject, repo, ref, kind, at) and
`host_sig` (the host's six-field attestation: subject, host, repo, ref, kind,
at). `verifyContribution` returns `{ authentic, attested }` — any holder of the
record and the two `did:key`s verifies it alone, with no trust in any server. A
`ReputationLog` is an untrusted, keep-and-label aggregator whose `profile` is
the gathered, self-verifying record set (trusted-attested, valid-but-untrusted,
or claimed; counted by kind) — reputation is the records, not a number.

`ReputationLog.archive` produces a deterministic `thaddeus.reputation.v1` JSON
proof set; `ingestArchive` strictly verifies and durably merges its missing
records in one write. `encodeReputationArchive` and `decodeReputationArchive`
are the public file/wire codec. A destination may pass an explicit host-DID
trust set to `profile`; valid foreign attestations remain portable even when
that destination does not count them.

Archives contain public contribution metadata, never identity seeds or content
keys. They prove each included record, not that an exporting server supplied a
complete history. Dynamic host discovery/trust, revocation/expiry, size limits,
and multi-process concurrency remain deferred.
