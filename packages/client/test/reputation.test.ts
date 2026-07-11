import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import {
  REPUTATION_ARCHIVE_FORMAT,
  signContribution,
} from '@thaddeus.run/reputation';
import { createServer } from '@thaddeus.run/server';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '../src/client';

beforeAll(async () => {
  await ready();
});

describe('Client — portable reputation', () => {
  test('imports, profiles, exports, and reimports a signed archive', async () => {
    const subject = Identity.create();
    const host = Identity.create();
    const backend = new MemoryBackend();
    const srv = createServer({ backend });
    const client = new Client(
      'http://destination',
      subject,
      srv.fetch.bind(srv)
    );
    const contribution = signContribution(
      {
        repo: 'acme/web',
        ref: 'op-1',
        kind: 'merge',
        at: '2026-07-11T00:00:00Z',
      },
      subject,
      host
    );
    const archive = {
      format: REPUTATION_ARCHIVE_FORMAT,
      subject: subject.did,
      contributions: [contribution],
    } as const;

    expect(await client.importReputation(archive)).toEqual({
      subject: subject.did,
      imported: 1,
      duplicates: 0,
      total: 1,
    });
    expect(await client.reputation(subject.did)).toMatchObject({
      attested: 0,
      untrusted: 1,
      claimed: 0,
    });
    expect(
      (await client.exportReputation(subject.did)).contributions[0]
    ).toEqual(contribution);
    expect(await client.importReputation(archive)).toMatchObject({
      imported: 0,
      duplicates: 1,
      total: 1,
    });

    const restarted = createServer({
      backend,
      trustedReputationHosts: [host.did],
    });
    const afterRestart = new Client(
      'http://destination',
      subject,
      restarted.fetch.bind(restarted)
    );
    expect(await afterRestart.reputation(subject.did)).toMatchObject({
      attested: 1,
      untrusted: 0,
      byKind: { merge: 1 },
    });
  });

  test('the destination rejects an importer other than the archive subject', async () => {
    const subject = Identity.create();
    const other = Identity.create();
    const host = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const client = new Client('http://destination', other, srv.fetch.bind(srv));
    let message = '';
    try {
      await client.importReputation({
        format: REPUTATION_ARCHIVE_FORMAT,
        subject: subject.did,
        contributions: [
          signContribution(
            { repo: 'r', ref: 'op', kind: 'merge', at: '2026-07-11T00:00:00Z' },
            subject,
            host
          ),
        ],
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('only the archive subject');
  });
});
