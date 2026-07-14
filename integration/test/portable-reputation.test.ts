import { signDelegation } from '@thaddeus.run/agent';
import { Client } from '@thaddeus.run/client';
import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { Platform } from '@thaddeus.run/platform';
import { signClaim } from '@thaddeus.run/reputation';
import { createServer } from '@thaddeus.run/server';
import { beforeAll, describe, expect, test } from 'bun:test';

beforeAll(async () => {
  await ready();
});

async function committedRepo(subject: Identity, name: string, path: string) {
  const repo = new Platform().createRepo(name);
  const workspace = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: subject,
    name: 'portable',
  });
  workspace.write(path, new TextEncoder().encode('fn portable() {}'));
  const [op] = await workspace.commit(subject);
  if (op === undefined) throw new Error('expected one committed op');
  return { repo, op, heads: repo.log.heads('portable') };
}

describe('P10 portable reputation between real server instances', () => {
  test('foreign proofs are retained, policy-trusted explicitly, and durable', async () => {
    const subject = Identity.create();
    const sourceOwnerIdentity = Identity.create();
    const sourceHost = Identity.create();
    const sourceBackend = new MemoryBackend();
    const sourceServer = createServer({
      backend: sourceBackend,
      host: sourceHost,
    });
    const source = new Client(
      'http://source',
      subject,
      sourceServer.fetch.bind(sourceServer)
    );
    const sourceOwner = new Client(
      'http://source',
      sourceOwnerIdentity,
      sourceServer.fetch.bind(sourceServer)
    );
    await sourceOwner.createRepo('source');
    await sourceOwner.grant(
      'source',
      signDelegation(
        {
          agent: subject.did,
          paths: ['**'],
          maxChanges: 10,
          maxSpend: 100,
        },
        sourceOwnerIdentity
      )
    );
    const sourceWork = await committedRepo(
      subject,
      'source',
      'source-proof.rs'
    );
    await source.push('source', sourceWork.repo, sourceWork.heads);
    const sourceClaim = signClaim(
      {
        repo: 'source',
        ref: sourceWork.op.id,
        kind: 'merge',
        at: '2026-07-11T00:00:00Z',
      },
      subject
    );
    expect(
      await sourceOwner.land(
        'source',
        sourceWork.repo,
        sourceWork.heads,
        'main',
        [sourceClaim]
      )
    ).toMatchObject({ landed: true });
    const archive = await source.exportReputation(subject.did);
    expect(archive.contributions).toHaveLength(1);

    const destinationBackend = new MemoryBackend();
    const otherTrustedHost = Identity.create();
    const untrustedServer = createServer({
      backend: destinationBackend,
      minMerges: 1,
      trustedReputationHosts: [otherTrustedHost.did],
    });
    const untrusted = new Client(
      'http://destination',
      subject,
      untrustedServer.fetch.bind(untrustedServer)
    );
    expect(await untrusted.importReputation(archive)).toMatchObject({
      imported: 1,
      duplicates: 0,
    });
    expect(await untrusted.reputation(subject.did)).toMatchObject({
      attested: 0,
      untrusted: 1,
    });
    await untrusted.createRepo('destination');
    const destinationWork = await committedRepo(
      subject,
      'destination',
      'destination.rs'
    );
    await untrusted.push(
      'destination',
      destinationWork.repo,
      destinationWork.heads
    );
    const destinationClaim = signClaim(
      {
        repo: 'destination',
        ref: destinationWork.op.id,
        kind: 'merge',
        at: '2026-07-11T00:01:00Z',
      },
      subject
    );
    expect(
      await untrusted.land(
        'destination',
        destinationWork.repo,
        destinationWork.heads,
        'main',
        [destinationClaim]
      )
    ).toMatchObject({ landed: false });

    const trustedServer = createServer({
      backend: destinationBackend,
      minMerges: 1,
      trustedReputationHosts: [sourceHost.did],
    });
    const trusted = new Client(
      'http://destination',
      subject,
      trustedServer.fetch.bind(trustedServer)
    );
    expect(await trusted.reputation(subject.did)).toMatchObject({
      attested: 1,
      untrusted: 0,
    });
    expect(await trusted.importReputation(archive)).toMatchObject({
      imported: 0,
      duplicates: 1,
    });
    expect(
      await trusted.land(
        'destination',
        destinationWork.repo,
        destinationWork.heads,
        'main',
        [destinationClaim]
      )
    ).toMatchObject({ landed: true });
  });
});
