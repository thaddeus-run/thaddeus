# THA-151 migrating encrypted repositories to trusted-service storage

**Date:** 2026-11-06 **Status:** Implemented in `@thaddeus.run/migrate`
**Issue:** [THA-151](https://linear.app/thaddeus-run/issue/THA-151) (GitHub
#220) **Plan:**
[`docs/plans/2026-11-06-tha-151-repository-migration.html`](../../plans/2026-11-06-tha-151-repository-migration.html),
published at <https://90p44kycb5ws.postplan.dev>

## Intent

[ADR 0003](../../adr/0003-trusted-code-processing-service.md) moves hosting to a
trusted service that can read plaintext. Repositories that already live on the
keyless server are encrypted to their owners' keys, and the service cannot read
them. Section 8 of the
[architecture contract](../../agent-first-architecture.md#8-migration-contract-for-existing-encrypted-repositories)
sets six rules for moving one. THA-151 implements them as a library in public
core, on top of the THA-150 authority. The hosted product's routes and screens
are separate work.

| Criterion                                                                           | Where                                                                 |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Explicit authorization to transfer and decrypt; no client key uploaded              | `signConsent`, `Migrator.begin`, `transfer`; sections 2 and 3         |
| Original signed records kept as evidence; files and history compared before cutover | `verifyEvidence`, `Migrator.verify`, `Migrator.cutover`; sections 4-6 |
| Resumable import, rollback and export, deterministic content and inventory checks   | `missing`, `rollback`, `export`, `verifyArchive`; sections 5, 7 and 8 |
| Interrupted migration, old and new clients, denied ownership, independent repos     | `packages/migrate/test/`; section 10                                  |

## Non-goals

- HTTP routes. Like THA-150, the shipped server is unchanged, and the hosted
  product puts these steps behind its own API.
- Freezing the keyless source. Rule 6 says repositories keep working on the
  keyless server, and the migration never writes to it. Cutover refuses if the
  source moved, but nothing stops the owner pushing to the source afterwards.
- Making provenance prompts and timed-reveal metadata readable by the service.
  They stay in the evidence as the original ciphertext.
- Releases, delegations and repository land policies. They stay on the source.
  The evidence holds what a verified pull returns: head chains, operations,
  ciphertext, capabilities, provenance, vetoes, review events and symbol
  operations.
- Importing the archive into another host. THA-74 owns portable export between
  trusted hosts.

## 1. Parties

- **Owner.** The DID that signs the source repository's head chains. It is the
  only identity that can read every file and the only one that may migrate.
- **Owner's client.** Runs on the owner's machine with the owner's keys. It
  reads the source, signs the consent and decrypts files one at a time.
- **Trusted service.** An `Authority`, a `KeyCustody` and a `Migrator` over one
  backend. It never receives a key and checks everything it receives.
- **Keyless server.** The shipped `thaddeus serve`. Migration reads it and never
  writes to it.

## 2. Consent

The owner signs a consent token,
`thm1.<base64url payload>.<base64url signature>`. The signature covers the
domain tag `thaddeus.migrate.consent.v1` and the exact payload text, as THA-150
credentials do. The payload holds:

- `service`, `tenant` and `repo`: where the repository goes.
- `source`: the keyless server URL, the source repository name and the owner
  DID.
- `views`: for each migrated view, sorted, the pinned version, the id of the
  owner-signed head record at that version and the revision id at every version
  from 0. The owner's client computes these from its own verified, decrypted
  copy.
- `transfer: "owner-decrypts"`: the owner's client decrypts and sends plaintext.
  It is the only value, so no consent can be read as permission to send keys.
- `issuedAt` and `expiresAt`. A consent lasts 24 hours by default and a week at
  most.

`decodeConsent` refuses unknown fields, a version other than 1, unsorted views,
a revision list of the wrong length and a signature by anyone but the DID in
`source.owner`.

## 3. Who may migrate

`Migrator.begin` accepts a consent when all of these hold:

1. It names this service's DID (`wrong_service`) and the tenant and repository
   of the caller's authorization (`wrong_target`).
2. The authorization's principal is `source.owner` (`not_owner`). An agent
   session the owner issued counts, because its principal is the owner.
3. The source's head chains in the evidence are signed by `source.owner`
   (`not_owner`). A delegate who signs a consent naming itself fails here.
4. It has not expired, and was not issued more than five minutes ahead of the
   service clock (`expired`, `invalid_consent`).
5. The authorization is a genuine, live `edit` authorization over `**`. Verify
   and export need `read`, cutover and rollback need `integrate`
   (`scope_denied`). The THA-150 authority checks expiry, revocation and the
   current policy on every step.

Every later step checks again that the principal owns the consent the repository
is currently migrating under. While one owner's migration is pending, a consent
for another source or from another owner is refused with `wrong_state`.

Plaintext moves only while the consent is current. `put` checks expiry for every
file. On the owner's side, `transfer` refuses unless the consent was signed by
the same owner for the service the migrator writes for, so the client sends
nothing to a service the owner did not name.

## 4. Evidence

The evidence is the source's original signed records as the keyless server
served them. `verifyEvidence` refuses anything that is not exactly the pinned
source:

- Each pinned view's chain is walked from the pinned head id back to genesis and
  checked with `verifyHeadChain` against the source repository, view and owner.
- Each chain's newest record must have exactly its operation closure in the
  evidence, checked with `verifyHeadSnapshot`. An operation or head record not
  on a pinned chain is refused.
- Every operation's content must arrive with its ciphertext, addressed by
  ciphertext. An object nothing references is refused, as are two objects for
  one plaintext id.
- Capabilities, provenance claims, vetoes, review events and symbol operations
  must verify. A provenance claim must name a migrated operation.
- Every migrated path must be one the authority can bind content to: relative,
  POSIX, with no empty, `.`, `..` or wildcard segment.
- The revisions rebuilt from the evidence must equal the ones the owner signed
  in the consent (`mismatch`).

Records are stored unchanged under content keys: the record id for heads,
operations and objects, and a hash of the record with its fields sorted for the
rest. A per-consent index lists every key with a digest, and later steps reload
the evidence through that index and verify it again. Nothing is re-signed and no
record gets a new meaning.

## 5. Import

`put` takes one file the owner decrypted. It must be at a path some migrated
version holds, with bytes whose BLAKE3 address is the content id the owner's
operations signed (`not_in_evidence`, `content_mismatch`). The file is sealed
through `KeyCustody.seal`, which audits the write, and stored with an atomic
create. A file already stored is left alone.

`missing` lists the files not stored yet, in path order. An import interrupted
at any point resumes by calling `begin` again with the same consent and sending
what `missing` lists. If the source moved, the owner signs a new consent,
`begin` replaces the pending one, and only files the new history adds are sent.

## 6. Verification and cutover

`verify` reloads the consent and evidence from storage and checks them again. It
opens every sealed file through `KeyCustody.open`, which audits the read, checks
each file hashes to its content id, and refuses with `incomplete` while any file
is missing. It returns a report and records its digest in the state log.

A report has no timestamps. It holds the consent id, the source and target, each
view's versions with the source head id, revision id and file count, the number
of distinct files and bytes, a digest of every (path, content id, size) and a
digest of the evidence index. Two verifications of the same migration produce
the same report.

`cutover` needs a `verified` state. The host reads the source's current signed
heads just before (`Source.latest`). If any pinned view has a newer record, the
cutover is refused with `source_moved`. Then each source version becomes a
`ServiceHeadRecord` at the same version through `Authority.advance`, with the
version's revision id and the paths it changed. `requestedBy` names the owner's
credential and no actor claim is added, so the record is the service's account
and never passes for the owner's signature. The original owner-signed head
records stay in the evidence.

If a view already has service records, each must match the migrated revision at
its version, and the cutover continues after the last one. That makes an
interrupted cutover resumable, and lets an owner who rolled back migrate again
later without forking the service history. A record that does not match is
`diverged`.

## 7. Rollback

`rollback` hands authority back to the keyless source. It is allowed in any
state but `rolled_back`, as long as every view's service head is absent or
matches the migrated revision at its version. Otherwise service history has gone
further, and rolling back would lose it (`diverged`). It deletes the sealed
content and revisions under `trusted/` and appends `rolled_back`. The consent,
evidence and state log stay.

Service head records are append-only under THA-150, so a rollback after cutover
leaves them in place. A host must read `status` and serve a repository only in
the `cutover` state. `tree` and `read` already refuse otherwise.

## 8. Export

`export` needs `verified` or `cutover`. It returns JSON text with the format
`thaddeus.migration-archive.v1`, the consent token, every evidence record in key
order, every migrated file in path order and the report. The same migration
exports the same text.

`verifyArchive` checks an archive on its own: the consent signature, that each
evidence key is the one its record produces, all of section 4, every file's
hash, that the files are exactly the migrated set, and that the report equals
one rebuilt from the contents. `restoreArchive` writes the original records into
a keyless repository store with `Platform.createDurable`, so the owner can read
every file with its own keys from the original ciphertext and capabilities.

## 9. Format and state

The backend layout, under the tenant and a hash of the repository name:

| Key                                     | Holds                                                      |
| --------------------------------------- | ---------------------------------------------------------- |
| `trusted/<t>/<r>/format`                | `{ format: "thaddeus.trusted-repo.v1" }`                   |
| `trusted/<t>/<r>/content/<path>/<id>`   | One file sealed by `KeyCustody`, with its path and size    |
| `trusted/<t>/<r>/revision/<id>`         | The (path, content id) list a service head record names    |
| `authority/head/...`                    | Service head records, written by `@thaddeus.run/authority` |
| `migrate/<t>/<r>/consent/<id>`          | The consent token                                          |
| `migrate/<t>/<r>/evidence/<kind>/<key>` | One original record, unchanged                             |
| `migrate/<t>/<r>/index/<id>`            | The evidence keys for one consent and their digest         |
| `migrate/<t>/<r>/state/<seq>`           | The append-only state log                                  |

Every record carries a version, and a reader refuses one it does not know with
`unsupported_format` instead of guessing. State entries are created atomically
at the next sequence number, so two migrators over one backend get `conflict`
instead of both moving the state. The states are `importing`, `verified`,
`cutover` and `rolled_back`. Each names the consent and the principal, subject
and credential that moved it.

A revision id is the BLAKE3 of the domain tag `thaddeus.migrate.revision.v1` and
the sorted (path, content id) pairs. Revisions are rebuilt with the shipped
`OpLog.materialize`, so a migrated revision is exactly what a keyless clone
checks out at that version.

## 10. Verification

`moonx migrate:test` runs 22 tests.

- **The real user path.** `real-path.test.ts` compiles the CLI, starts
  `thaddeus serve`, and has an owner create and push a repository, grant a
  second identity, and land that identity's change. A process reads the owner's
  identity from the CLI config home, begins the migration, sends two of four
  files and dies by SIGKILL. The keyless server restarts on its data. A second
  process resumes with two files missing, verifies, and dies by SIGKILL after
  writing two of four service head records. A third finishes the cutover from
  version 2, reads the files back, exports and checks the archive. Throughout,
  the shipped CLI keeps pushing, pulling and cloning the migrated repository and
  a repository that was never migrated. The second identity reads only the paths
  its grant covers, and its consent and its `begin` are refused with
  `not_owner`. A scan of every file the service wrote finds neither the owner's
  seed nor any content key nor any file's plaintext.
- **Ownership and authorization.** A delegate's consent, the owner's consent run
  by a delegate, a takeover of a pending target, a consent for another service
  or repository, an expired consent, the wrong scope and a path-limited
  authorization are refused.
- **Evidence.** A missing, extra or forged operation, a forged capability, a
  chain re-signed by someone else, a consent with other revisions and evidence
  changed in storage after `begin` are refused.
- **A moving source.** A push after the consent blocks cutover; a new consent
  sends only the new file, and cutover lands the new version.
- **Restarts.** An import and a cutover interrupted in one process resume in
  another over the same `FileBackend`, and a finished cutover is idempotent.
- **Rollback.** Before and after cutover, then a new migration that continues
  the service history, and a refusal once service history went further.
- **Independent repositories.** Two owners and two tenants with the same
  repository name migrate interleaved, and rolling one back leaves the other
  served.
- **Formats.** A newer state, repository or archive format is refused, and a
  second migrator reads what the first wrote.

Breaking each guard in turn makes at least one test fail. The PR lists the
guards and the failing-test counts.

## Limits

- One process owns a backend, as with THA-150. Atomic creates stop two processes
  from forking the state log, a head chain or a stored file.
- `historyOf` replays the operation log once per version, and `verify` and
  `export` open every file through key custody, writing an audit record each
  time. Neither has been measured on a large repository.
- The real-path fixture runs the owner's client and the service in one process.
  The service state lives only in its own directory, and the owner's keys only
  in the owner's config home.
- `FileBackend` never calls fsync, so the restart tests cover killed processes,
  not a machine crash.

## Decisions taken without a grill round

The issue was worked end to end without a planning conversation. These are the
choices a reviewer should check first:

1. One new package, `@thaddeus.run/migrate`, and no server or CLI changes.
2. The owner's client decrypts and sends plaintext. No content key or identity
   key is ever sent, so there is no mode that uploads keys.
3. Only the source owner may migrate, through its own credential or an agent
   session it issued.
4. The consent pins the revision at every version, so the service proves it
   rebuilt the same history the owner saw.
5. The evidence keeps the original ciphertext and capabilities, so an archive
   restores the keyless repository exactly.
6. Every source version becomes a service head record at the same version.
7. The keyless source is never frozen or changed. Cutover only refuses a source
   that moved.
8. Rollback deletes the trusted content but keeps evidence, state and service
   head records, and hosts serve only the `cutover` state.
