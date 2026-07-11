import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import {
  encodeReputationArchive,
  REPUTATION_ARCHIVE_FORMAT,
  signContribution,
} from '@thaddeus.run/reputation';
import { beforeAll, describe, expect, test } from 'bun:test';

import { createServer } from '../src/server';
import { signRequest } from '../src/sign';

beforeAll(async () => {
  await ready();
});

async function signedPost(
  fetchImpl: (request: Request) => Promise<Response>,
  bodyObj: unknown,
  signer: Identity
): Promise<Response> {
  const path = '/reputation/import';
  const body = new TextEncoder().encode(JSON.stringify(bodyObj));
  const signed = signRequest(
    'POST',
    path,
    body,
    signer,
    new Date().toISOString()
  );
  return fetchImpl(
    new Request(`http://t${path}`, {
      method: 'POST',
      body,
      headers: {
        'x-thaddeus-did': signed.did,
        'x-thaddeus-timestamp': signed.timestamp,
        'x-thaddeus-nonce': signed.nonce,
        'x-thaddeus-signature': signed.signature,
      },
    })
  );
}

describe('server portable reputation routes', () => {
  test('requires a signed subject request and rejects a bad batch atomically', async () => {
    const subject = Identity.create();
    const host = Identity.create();
    const contribution = signContribution(
      { repo: 'r', ref: 'op', kind: 'merge', at: '2026-07-11T00:00:00Z' },
      subject,
      host
    );
    const valid = encodeReputationArchive({
      format: REPUTATION_ARCHIVE_FORMAT,
      subject: subject.did,
      contributions: [contribution],
    });
    const srv = createServer({ backend: new MemoryBackend() });
    const fetchImpl = srv.fetch.bind(srv);

    const unsigned = await fetchImpl(
      new Request('http://t/reputation/import', {
        method: 'POST',
        body: JSON.stringify({ archive: valid }),
      })
    );
    expect(unsigned.status).toBe(401);

    const wire = JSON.parse(valid) as {
      contributions: { host_sig: string }[];
    };
    wire.contributions[0].host_sig = Buffer.from(new Uint8Array(64)).toString(
      'base64'
    );
    const bad = await signedPost(
      fetchImpl,
      { archive: JSON.stringify(wire) },
      subject
    );
    expect(bad.status).toBe(400);
    const profile = (await (
      await fetchImpl(
        new Request(`http://t/reputation/${encodeURIComponent(subject.did)}`)
      )
    ).json()) as { untrusted: number };
    expect(profile.untrusted).toBe(0);
  });

  test('exports imported proofs and trusts the local host automatically', async () => {
    const subject = Identity.create();
    const host = Identity.create();
    const archive = encodeReputationArchive({
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
    const srv = createServer({ backend: new MemoryBackend(), host });
    const fetchImpl = srv.fetch.bind(srv);
    const imported = await signedPost(fetchImpl, { archive }, subject);
    expect(imported.status).toBe(200);

    const profile = (await (
      await fetchImpl(
        new Request(`http://t/reputation/${encodeURIComponent(subject.did)}`)
      )
    ).json()) as { attested: number; untrusted: number };
    expect(profile).toMatchObject({ attested: 1, untrusted: 0 });

    const exported = (await (
      await fetchImpl(
        new Request(
          `http://t/reputation/${encodeURIComponent(subject.did)}/export`
        )
      )
    ).json()) as { archive: string };
    expect(exported.archive).toContain(REPUTATION_ARCHIVE_FORMAT);
  });
});
