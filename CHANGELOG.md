# Changelog

All notable changes to Thaddeus. Format follows
[Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added

- (in progress) `@thaddeus.run/identity` — self-owned `did:key` identity:
  sign/verify, anonymous seal/unseal.
- (in progress) `@thaddeus.run/store` — encrypted, content-addressed objects
  with per-object capabilities (grant/revoke = key rotation). Pillar 01.

### Changed

- Re-scoped packages `@thaddeus/*` → `@thaddeus.run/*`; renamed the `core`
  placeholder package to `store`.
