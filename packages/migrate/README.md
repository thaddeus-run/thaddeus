# @thaddeus.run/migrate

Moves a repository from the keyless Thaddeus server into trusted-service
storage, as the
[architecture contract](../../docs/agent-first-architecture.md#8-migration-contract-for-existing-encrypted-repositories)
requires. The repository owner authorizes each migration, the owner's own client
decrypts the content, and the service checks everything it receives against the
signatures already on the source.

- `Source.read` clones every signed view through `@thaddeus.run/client`, which
  verifies the owner-signed head chains and the exact operation closure.
  `source.consent` signs the owner's consent: the service, the target tenant and
  repository, the exact source history with the revision at every version, and
  an expiry. No key leaves the owner's machine.
- `Migrator.begin` refuses unless the consent is signed by the DID that signs
  the source's head chains, names this service and target, and is current, and
  unless the caller's credential belongs to that same owner. It checks every
  original record, then stores each one unchanged.
- `transfer` sends one decrypted file at a time. `Migrator.put` seals a file
  only if its bytes hash to the content id the owner's signed operations name,
  at a path a migrated version holds. `missing` lists what is left, so an import
  interrupted at any point resumes where it stopped.
- `Migrator.verify` reloads the stored evidence, checks it again, opens every
  sealed file through key custody and rebuilds the revision of every version. It
  must match the revisions the owner signed.
- `Migrator.cutover` refuses if the source has moved since the consent, then
  writes each source version as a service head record at the same version. A
  cutover that stopped halfway continues from its last record.
- `Migrator.rollback` withdraws the trusted copy while no service history goes
  past what was migrated. The keyless source was never changed.
- `Migrator.export` writes a deterministic archive of the consent, the original
  records and the files. `verifyArchive` checks it with nothing else at hand,
  and `restoreArchive` writes the original records back into a keyless
  repository store that the owner reads with its own keys.

```ts
import { Client } from '@thaddeus.run/client';
import { Migrator, Source, transfer } from '@thaddeus.run/migrate';

// On the owner's machine.
const source = await Source.read(new Client(url, owner), 'acme/web', {
  server: url,
});
const consent = source.consent(owner, {
  service: authority.did,
  tenant: 'acme',
  repo: 'web',
});

// Each step takes an authorization from the service's Authority for the
// owner: edit to import, read to verify, integrate to cut over.
const migrator = new Migrator({ authority, custody, backend });
await migrator.begin(edit, consent, source.evidence);
await transfer(source, owner, migrator, edit, consent);
const report = await migrator.verify(read);
await migrator.cutover(integrate, await source.latest());
```

The trusted-service format, `thaddeus.trusted-repo.v1`, keeps sealed content and
revisions under `trusted/`, and the consent, evidence and an append-only state
log under `migrate/`. Service head records stay where `@thaddeus.run/authority`
writes them. A reader refuses a record whose format version it does not know.

There are no HTTP routes. The hosted product puts these steps behind its own
API. A host must check `status` before serving a migrated repository, because a
rollback leaves the service head records in place as part of the audit trail.
The
[design](../../docs/superpowers/specs/2026-11-06-tha-151-repository-migration-design.md)
holds the full contract and its limits.
