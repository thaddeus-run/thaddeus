import { Identity, ready } from '@thaddeus.run/identity';
import { FileBackend } from '@thaddeus.run/persist';
// A stand-in for a trusted-service process, for the crash and restart test.
// `crash <dir>` does real work against a FileBackend, prints what it did and
// kills itself with SIGKILL. `recover <dir>` opens the same directory in a new
// process and reports what still holds.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  Authority,
  AuthorityError,
  KeyCustody,
  LocalRootKey,
  proveAction,
  proveIssue,
  proveRevoke,
  type SealedContent,
} from '../../src';

await ready();

const [mode, dir = ''] = process.argv.slice(2);
const state = join(dir, 'state');
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

// The host keeps the service seed and root key outside the backend.
const service = Identity.fromSeed(secret('service'));
const root = LocalRootKey.fromBytes(secret('root'));
const admin = Identity.fromSeed(secret('admin'));
const agent = Identity.fromSeed(secret('agent'));
const worker = Identity.fromSeed(secret('worker'));
const backend = new FileBackend(state);
const authority = await Authority.open({ backend, signer: service });
const custody = new KeyCustody({ authority, backend, root });
const TENANT = 'acme';
const READ = {
  scope: 'read' as const,
  tenant: TENANT,
  repo: 'app',
  paths: ['src/a.ts'],
};

async function credential(
  who: Identity,
  kind: 'agent' | 'worker',
  scopes: string[]
) {
  const request = {
    tenant: TENANT,
    principal: who.did,
    subject: who.did,
    kind,
    grants: [{ repo: 'app', scopes: scopes as never, paths: ['**'] }],
  };
  return (await authority.issue(request, proveIssue(who, request))).token;
}

async function code(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'ok';
  } catch (error) {
    return error instanceof AuthorityError ? error.code : String(error);
  }
}

if (mode === 'crash') {
  await authority.createTenant(TENANT, {
    admins: [admin.did],
    members: [
      {
        subject: agent.did,
        kind: 'agent',
        grants: [{ repo: 'app', scopes: ['read', 'edit'], paths: ['**'] }],
      },
      {
        subject: worker.did,
        kind: 'worker',
        grants: [
          { repo: 'app', scopes: ['integrate', 'execute'], paths: ['**'] },
        ],
      },
    ],
  });
  const kept = await credential(agent, 'agent', ['read', 'edit']);
  const revoked = await credential(agent, 'agent', ['read']);
  const workerToken = await credential(worker, 'worker', [
    'integrate',
    'execute',
  ]);

  const edit = { ...READ, scope: 'edit' as const };
  const sealed = await custody.seal(
    await authority.authorize(kept, edit, proveAction(agent, kept, edit)),
    'src/a.ts',
    new TextEncoder().encode('survives a crash')
  );
  const integrate = { ...READ, scope: 'integrate' as const };
  const head = await authority.advance(
    await authority.authorize(
      workerToken,
      integrate,
      proveAction(worker, workerToken, integrate)
    ),
    { view: 'main', expectedVersion: null, revision: 'rev-1' }
  );
  const execute = { ...READ, scope: 'execute' as const, paths: ['**'] };
  const ticket = await authority.queue(
    await authority.authorize(
      workerToken,
      execute,
      proveAction(worker, workerToken, execute)
    )
  );
  const usedProof = proveAction(agent, kept, READ);
  await authority.authorize(kept, READ, usedProof);
  const revokeRequest = {
    tenant: TENANT,
    actor: admin.did,
    target: { credential: revoked },
  };
  await authority.revoke(revokeRequest, proveRevoke(admin, revokeRequest));

  writeFileSync(
    join(dir, 'crash.json'),
    JSON.stringify({
      kept,
      revoked,
      ticket,
      usedProof,
      headId: head.id,
      sealed: {
        nonce: Buffer.from(sealed.nonce).toString('base64'),
        ciphertext: Buffer.from(sealed.ciphertext).toString('base64'),
      },
    })
  );
  // No shutdown, no flush: the process dies here.
  process.kill(process.pid, 'SIGKILL');
}

if (mode === 'recover') {
  const before = JSON.parse(readFileSync(join(dir, 'crash.json'), 'utf8'));
  const sealed: SealedContent = {
    v: 1,
    keyVersion: 1,
    nonce: new Uint8Array(Buffer.from(before.sealed.nonce, 'base64')),
    ciphertext: new Uint8Array(Buffer.from(before.sealed.ciphertext, 'base64')),
  };
  let plaintext = '';
  const read = await code(async () => {
    const auth = await authority.authorize(
      before.kept,
      READ,
      proveAction(agent, before.kept, READ)
    );
    plaintext = new TextDecoder().decode(
      await custody.open(auth, 'src/a.ts', sealed)
    );
  });
  const head = await authority.head(TENANT, 'app', 'main');
  const result = {
    read,
    plaintext,
    revoked: await code(() =>
      authority.authorize(
        before.revoked,
        READ,
        proveAction(agent, before.revoked, READ)
      )
    ),
    replayed: await code(() =>
      authority.authorize(before.kept, READ, before.usedProof)
    ),
    headVersion: head?.version ?? null,
    headSame: head?.id === before.headId,
    redeem: await code(() => authority.redeem(before.ticket)),
    redeemAgain: await code(() => authority.redeem(before.ticket)),
    audit: (await authority.audit(TENANT)).map(
      (r) => `${r.event}:${r.outcome}`
    ),
  };
  process.stdout.write(JSON.stringify(result));
}
