// A stand-in for the owner's migration client and the trusted service, for
// the real-path test. The owner's identity is read from the CLI's own config
// home, the source is a real `thaddeus serve` over HTTP, and the service
// keeps its state in a FileBackend directory and nothing else.
//
//   import-crash  <dir> <url> <ownerHome> <guestHome>  begin, send two files, SIGKILL
//   cutover-crash <dir> <url> <ownerHome> <guestHome>  resume, verify, SIGKILL mid-cutover
//   finish        <dir> <url> <ownerHome> <guestHome>  finish cutover, read, export, report
import {
  Authority,
  AuthorityError,
  KeyCustody,
  LocalRootKey,
  proveAction,
  proveIssue,
  type Scope,
} from '@thaddeus.run/authority';
import { Client } from '@thaddeus.run/client';
import { Identity, ready } from '@thaddeus.run/identity';
import { FileBackend } from '@thaddeus.run/persist';
import { unwrapKey } from '@thaddeus.run/store';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MigrationError,
  Migrator,
  signConsent,
  Source,
  transfer,
  verifyArchive,
} from '../../src';

await ready();

const [mode, dir = '', url = '', ownerHome = '', guestHome = ''] =
  process.argv.slice(2);
const TENANT = 'acme';
const REPO = 'web';
const SOURCE = 'acme/web';

const secret = (name: string): Uint8Array => {
  const file = join(dir, `${name}.key`);
  try {
    return new Uint8Array(readFileSync(file));
  } catch {
    const fresh = crypto.getRandomValues(new Uint8Array(32));
    writeFileSync(file, fresh);
    return fresh;
  }
};
// The CLI keeps a base64 seed in ~/.config/thaddeus/identity.json.
const cliIdentity = (home: string): Identity => {
  const stored = JSON.parse(
    readFileSync(join(home, '.config', 'thaddeus', 'identity.json'), 'utf8')
  ) as { seed: string };
  return Identity.fromSeed(new Uint8Array(Buffer.from(stored.seed, 'base64')));
};

const owner = cliIdentity(ownerHome);
const guest = cliIdentity(guestHome);
const serviceIdentity = Identity.fromSeed(secret('service'));
const backend = new FileBackend(join(dir, 'state'));
const authority = await Authority.open({ backend, signer: serviceIdentity });
const custody = new KeyCustody({
  authority,
  backend,
  root: LocalRootKey.fromBytes(secret('root')),
});
const migrator = new Migrator({ authority, custody, backend });

try {
  authority.policy(TENANT);
} catch {
  await authority.createTenant(TENANT, {
    admins: [Identity.fromSeed(secret('admin')).did],
    members: [
      {
        subject: owner.did,
        kind: 'human',
        grants: [
          { repo: REPO, scopes: ['read', 'edit', 'integrate'], paths: ['**'] },
        ],
      },
      {
        subject: guest.did,
        kind: 'human',
        grants: [
          { repo: REPO, scopes: ['read'], paths: ['src/**'] },
          { repo: REPO, scopes: ['edit'], paths: ['**'] },
        ],
      },
    ],
  });
}

async function session(who: Identity, scopes: Scope[], paths: string[]) {
  const request = {
    service: authority.did,
    tenant: TENANT,
    principal: who.did,
    subject: who.did,
    kind: 'human' as const,
    grants: [{ repo: REPO, scopes, paths }],
  };
  const { token } = await authority.issue(request, proveIssue(who, request));
  return (scope: Scope) => {
    const action = { scope, tenant: TENANT, repo: REPO, paths };
    return authority.authorize(token, action, proveAction(who, token, action));
  };
}

async function code(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'ok';
  } catch (error) {
    if (error instanceof MigrationError || error instanceof AuthorityError) {
      return error.code;
    }
    return String(error);
  }
}

const source = await Source.read(
  new Client(url, owner, (req) => fetch(req)),
  SOURCE,
  {
    server: url,
  }
);
const use = await session(owner, ['read', 'edit', 'integrate'], ['**']);
const edit = await use('edit');
const consentFile = join(dir, 'consent.txt');

if (mode === 'import-crash') {
  const token = source.consent(owner, {
    service: authority.did,
    tenant: TENANT,
    repo: REPO,
  });
  writeFileSync(consentFile, token);
  const progress = await migrator.begin(edit, token, source.evidence);
  const sent = await transfer(source, owner, migrator, edit, token, {
    limit: 2,
  });
  writeFileSync(
    join(dir, 'import.json'),
    JSON.stringify({ ...progress, ...sent })
  );
  process.kill(process.pid, 'SIGKILL');
}

if (mode === 'cutover-crash') {
  const token = readFileSync(consentFile, 'utf8');
  const resumed = await migrator.begin(edit, token, source.evidence);
  const sent = await transfer(source, owner, migrator, edit, token);
  const report = await migrator.verify(await use('read'));
  writeFileSync(
    join(dir, 'resume.json'),
    JSON.stringify({ missingAtResume: resumed.missing, ...sent, report })
  );
  // Die after the second service head record is written.
  const advance = authority.advance.bind(authority);
  let written = 0;
  authority.advance = async (...args: Parameters<typeof advance>) => {
    const record = await advance(...args);
    written += 1;
    if (written === 2) process.kill(process.pid, 'SIGKILL');
    return record;
  };
  await migrator.cutover(await use('integrate'), await source.latest());
}

if (mode === 'finish') {
  const before = await migrator.status(TENANT, REPO);
  const headBefore = await authority.head(TENANT, REPO, 'main');
  const cut = await migrator.cutover(
    await use('integrate'),
    await source.latest()
  );
  const read = await use('read');
  const files: Record<string, string> = {};
  for (const entry of await migrator.tree(read, 'main')) {
    files[entry.path] = new TextDecoder().decode(
      await migrator.read(read, 'main', entry.path)
    );
  }

  // A second identity with a narrower read grant sees only its paths.
  const guestRead = await (await session(guest, ['read'], ['src/**']))('read');
  const guestFiles = (await migrator.tree(guestRead, 'main')).map(
    (e) => e.path
  );

  // The guest may edit the whole target repository, but is not the owner
  // the source's head chains name.
  const guestEdit = await (await session(guest, ['edit'], ['**']))('edit');
  const guestConsent = await code(() =>
    Promise.resolve().then(() =>
      source.consent(guest, {
        service: authority.did,
        tenant: TENANT,
        repo: REPO,
      })
    )
  );
  const forged = signConsent(guest, {
    service: authority.did,
    tenant: TENANT,
    repo: REPO,
    source: { server: url, repo: SOURCE },
    views: source.pinned(),
  });
  const guestBegin = await code(() =>
    migrator.begin(guestEdit, forged, source.evidence)
  );

  const archive = await migrator.export(read);
  const checked = verifyArchive(archive, { service: authority.did });

  // Scan everything the service wrote to disk for the owner's secrets.
  const blobs: Buffer[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (!name.endsWith('.key')) blobs.push(readFileSync(full));
    }
  };
  walk(dir);
  const forms = (b: Uint8Array) => [
    Buffer.from(b),
    Buffer.from(Buffer.from(b).toString('hex')),
    Buffer.from(Buffer.from(b).toString('base64')),
    Buffer.from(Buffer.from(b).toString('base64url')),
  ];
  const leaks = (b: Uint8Array) =>
    blobs.some((blob) => forms(b).some((f) => blob.includes(f)));
  const stored = JSON.parse(
    readFileSync(
      join(ownerHome, '.config', 'thaddeus', 'identity.json'),
      'utf8'
    )
  ) as { seed: string };
  const ownerCaps = source.evidence.caps.filter((c) => c.grantee === owner.did);
  const audit = await authority.audit(TENANT);

  console.log(
    JSON.stringify({
      stateBefore: before?.state,
      headVersionBefore: headBefore?.version,
      stateAfter: (await migrator.status(TENANT, REPO))?.state,
      versions: cut.views.map((v) => [v.view, v.head.version]),
      requestedBy: cut.views[0]?.head.requestedBy.principal === owner.did,
      files,
      guestFiles,
      guestConsent,
      guestBegin,
      archiveFiles: checked.report.files,
      archiveSame: archive === (await migrator.export(read)),
      reportViews: checked.report.views.map((v) => [v.view, v.versions.length]),
      seedLeak: leaks(new Uint8Array(Buffer.from(stored.seed, 'base64'))),
      keysChecked: ownerCaps.length,
      keyLeak: ownerCaps.some((c) => leaks(unwrapKey(c, owner))),
      plaintextLeak: Object.values(files).some((content) =>
        blobs.some((blob) => blob.includes(Buffer.from(content)))
      ),
      plaintextReads: audit.filter((r) => r.event === 'plaintext.read').length,
      plaintextWrites: audit.filter((r) => r.event === 'plaintext.write')
        .length,
    })
  );
}
