# P10 Portable Reputation Design

**Date:** 2026-07-11 **Status:** Shipped

## Context

P07 already produces durable, dual-signed `Contribution` records: the subject
signs the portable work claim and the host signs the complete attestation. P10
adds the missing transport so leaving an instance is an export rather than the
loss of contribution history.

## Chosen protocol

- A `thaddeus.reputation.v1` JSON archive contains one subject and a
  deterministic, deduplicated list of contributions. Signature bytes are
  canonical base64. The archive is public metadata, not encrypted content.
- Export includes every contribution whose subject and host signatures verify.
  It does not assert that the exporting server returned a complete history.
- Import validates the complete archive before state changes, requires the HTTP
  request signer to equal the archive subject, and persists the missing delta as
  one content-addressed `rep-import/` record. Identical retries are no-ops.
- A destination retains valid foreign proofs but counts only host DIDs in its
  explicit trust set. Its own configured host DID is trusted automatically. This
  prevents a subject from minting a second DID as a fake host and using invented
  contributions to clear a reputation policy.

## Interfaces

`@thaddeus.run/reputation` exports `ReputationArchive`,
`REPUTATION_ARCHIVE_FORMAT`, `encodeReputationArchive`, and
`decodeReputationArchive`. `ReputationLog.archive` produces portable proofs;
`ingestArchive` performs the atomic durable merge; and
`profile(subject, trustedHosts?)` separates trusted `attested`, valid
`untrusted`, and subject-only `claimed` records.

The server exposes public `GET /reputation/:did/export` and subject-signed
`POST /reputation/import`. `ServerConfig.trustedReputationHosts` supplies the
static trust set used by profile reads and `requireReputationTier`.

The CLI exposes archive files/stdin and direct transfer:

```sh
thaddeus reputation export <did> [--server URL] [--output path]
thaddeus reputation import <path|-> [--server URL]
thaddeus reputation import --from <source> --server <destination>
thaddeus serve --trust-host <did> --trust-host <did>
```

## Compatibility

Legacy individual `rep/` records continue to load. Calling
`ReputationLog.profile(subject)` or `requireReputationTier(log, n)` without a
trust set preserves the package's prior cryptographic-attestation behavior; the
server always supplies an explicit set.

## Deferred

Dynamic trust discovery and administration, transitive/web-of-trust policy,
contribution revocation or expiry, archive/request size limits, proof of export
completeness, and multi-node concurrency remain later hardening work.
