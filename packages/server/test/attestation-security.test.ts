import { signDelegation } from '@thaddeus.run/agent';
import { Identity, ready } from '@thaddeus.run/identity';
import { signOp } from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import { signRelease } from '@thaddeus.run/platform';
import { signClaim } from '@thaddeus.run/reputation';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  encodeBundle,
  encodeClaim,
  encodeDelegation,
  encodeRelease,
} from '../src/dto';
import { createServer, type Server } from '../src/server';
import { signRequest } from '../src/sign';
import { createRepoBody, landBody } from './heads';

beforeAll(async () => {
  await ready();
});

function signedPost(path: string, value: unknown, signer: Identity): Request {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const signed = signRequest(
    'POST',
    path,
    body,
    signer,
    new Date().toISOString()
  );
  return new Request(`http://t${path}`, {
    method: 'POST',
    body,
    headers: {
      'x-thaddeus-did': signed.did,
      'x-thaddeus-timestamp': signed.timestamp,
      'x-thaddeus-nonce': signed.nonce,
      'x-thaddeus-signature': signed.signature,
    },
  });
}

class FailingAttestationRateBackend extends MemoryBackend {
  override list(prefix: string): Promise<readonly string[]> {
    if (prefix.startsWith('attestation-rate/')) {
      return Promise.reject(new Error('rate storage unavailable'));
    }
    return super.list(prefix);
  }
}

async function createDelegatedRepo(
  server: Server,
  name: string,
  owner: Identity,
  author: Identity
): Promise<void> {
  expect(
    (
      await server.fetch(
        signedPost('/repos', createRepoBody(name, owner), owner)
      )
    ).status
  ).toBe(201);
  expect(
    (
      await server.fetch(
        signedPost(
          `/repos/${name}/grants`,
          {
            delegation: encodeDelegation(
              signDelegation(
                {
                  agent: author.did,
                  paths: ['**'],
                  maxChanges: 100,
                  maxSpend: 100,
                },
                owner
              )
            ),
          },
          owner
        )
      )
    ).status
  ).toBe(200);
}

describe('reputation attestation security', () => {
  test('rejects conflicting signers and unsafe rate limits', () => {
    const host = Identity.create();
    expect(() =>
      createServer({
        backend: new MemoryBackend(),
        host,
        attester: {
          did: host.did,
          sign: () => Promise.resolve(new Uint8Array()),
        },
      })
    ).toThrow('cannot both be set');
    expect(() =>
      createServer({ backend: new MemoryBackend(), attestationRateLimit: 21 })
    ).toThrow('between 0 and 20');
    expect(() =>
      createServer({
        backend: new MemoryBackend(),
        trustedReputationHosts: ['not-a-did'],
      })
    ).toThrow('invalid trusted reputation host DID');
    expect(() =>
      createServer({
        backend: new MemoryBackend(),
        trustedReputationHosts: [host.did, host.did],
      })
    ).not.toThrow();
    expect(() =>
      createServer({ backend: new MemoryBackend(), minMerges: 1 })
    ).toThrow(
      'positive minMerges requires a trusted reputation host or attester'
    );
    expect(() =>
      createServer({ backend: new MemoryBackend(), minMerges: 0 })
    ).not.toThrow();
    expect(() =>
      createServer({
        backend: new MemoryBackend(),
        minMerges: 1,
        trustedReputationHosts: [host.did],
      })
    ).not.toThrow();
  });

  test('reports issuance disabled when the configured ceiling is zero', async () => {
    const owner = Identity.create();
    const author = Identity.create();
    const server = createServer({
      backend: new MemoryBackend(),
      host: Identity.create(),
      attestationRateLimit: 0,
    });
    const metrics = await (
      await server.fetch(new Request('http://t/metrics'))
    ).text();
    expect(metrics).toContain('thaddeus_attestation_enabled 0');
    expect(metrics).toContain('thaddeus_attestation_rate_limit 0');

    await createDelegatedRepo(server, 'disabled', owner, author);
    const op = signOp(
      {
        path: 'disabled.ts',
        parents: [],
        lamport: 0,
        at: '2026-07-14T00:00:00.000Z',
        payload: null,
      },
      author
    );
    await server.fetch(
      signedPost('/repos/disabled/push', encodeBundle([op], [], []), author)
    );
    const claim = signClaim(
      { repo: 'disabled', ref: op.id, kind: 'merge', at: op.at },
      author
    );
    const response = await server.fetch(
      signedPost(
        '/repos/disabled/land',
        await landBody(server.fetch, 'disabled', [op.id], owner, 'main', {
          contrib: [encodeClaim(claim)],
        }),
        owner
      )
    );
    expect(await response.json()).toMatchObject({
      landed: true,
      attestations: {
        received: 1,
        issued: 0,
        skipped: { not_attesting: 1, rate_limited: 0 },
      },
    });
  });

  test('does not attest an owner-authored merge into the owner repository', async () => {
    const backend = new MemoryBackend();
    const owner = Identity.create();
    const host = Identity.create();
    const server = createServer({ backend, host });
    await server.fetch(
      signedPost('/repos', createRepoBody('owned', owner), owner)
    );
    const op = signOp(
      {
        path: 'README.md',
        parents: [],
        lamport: 0,
        at: '2026-07-14T00:00:00.000Z',
        payload: null,
      },
      owner
    );
    await server.fetch(
      signedPost('/repos/owned/push', encodeBundle([op], [], []), owner)
    );
    const claim = signClaim(
      { repo: 'owned', ref: op.id, kind: 'merge', at: op.at },
      owner
    );
    const response = await server.fetch(
      signedPost(
        '/repos/owned/land',
        await landBody(server.fetch, 'owned', [op.id], owner, 'main', {
          contrib: [encodeClaim(claim)],
        }),
        owner
      )
    );
    expect(await response.json()).toMatchObject({
      landed: true,
      attestations: { received: 1, issued: 0, skipped: { ineligible: 1 } },
    });
    const profile = (await (
      await server.fetch(
        new Request(`http://t/reputation/${encodeURIComponent(owner.did)}`)
      )
    ).json()) as { counted: number };
    expect(profile.counted).toBe(0);
  });

  test('fails closed for proofs but still lands when limiter storage is unavailable', async () => {
    const owner = Identity.create();
    const author = Identity.create();
    const host = Identity.create();
    const errors: string[] = [];
    const server = createServer({
      backend: new FailingAttestationRateBackend(),
      host,
      onError: (_error, context) => errors.push(context.operation),
    });
    await createDelegatedRepo(server, 'limiter-outage', owner, author);
    const op = signOp(
      {
        path: 'limited.ts',
        parents: [],
        lamport: 0,
        at: '2026-07-14T00:00:00.000Z',
        payload: null,
      },
      author
    );
    await server.fetch(
      signedPost(
        '/repos/limiter-outage/push',
        encodeBundle([op], [], []),
        author
      )
    );
    const claim = signClaim(
      {
        repo: 'limiter-outage',
        ref: op.id,
        kind: 'merge',
        at: op.at,
      },
      author
    );
    const response = await server.fetch(
      signedPost(
        '/repos/limiter-outage/land',
        await landBody(server.fetch, 'limiter-outage', [op.id], owner, 'main', {
          contrib: [encodeClaim(claim)],
        }),
        owner
      )
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      landed: true,
      attestations: {
        received: 1,
        issued: 0,
        skipped: { limiter_unavailable: 1 },
      },
    });
    expect(errors).toContain('attestation-rate-store');
  });

  test('binds repo, deduplicates events, and rate-limits eligible delegated merges', async () => {
    const backend = new MemoryBackend();
    const owner = Identity.create();
    const author = Identity.create();
    const host = Identity.create();
    const server = createServer({ backend, host, attestationRateLimit: 1 });
    await createDelegatedRepo(server, 'delegated', owner, author);
    const first = signOp(
      {
        path: 'one.ts',
        parents: [],
        lamport: 0,
        at: '2026-07-14T00:00:00.000Z',
        payload: null,
      },
      author
    );
    const second = signOp(
      {
        path: 'two.ts',
        parents: [first.id],
        lamport: 1,
        at: '2026-07-14T00:00:01.000Z',
        payload: null,
      },
      author
    );
    await server.fetch(
      signedPost(
        '/repos/delegated/push',
        encodeBundle([first, second], [], []),
        author
      )
    );
    const firstClaim = signClaim(
      { repo: 'delegated', ref: first.id, kind: 'merge', at: first.at },
      author
    );
    const secondClaim = signClaim(
      { repo: 'delegated', ref: second.id, kind: 'merge', at: second.at },
      author
    );
    const wrongRepo = signClaim(
      { repo: 'other', ref: first.id, kind: 'merge', at: first.at },
      author
    );
    const wrongKind = signClaim(
      { repo: 'delegated', ref: first.id, kind: 'review', at: first.at },
      author
    );
    const wrongRef = signClaim(
      {
        repo: 'delegated',
        ref: 'not-an-incoming-op',
        kind: 'merge',
        at: first.at,
      },
      author
    );
    const wrongSubject = signClaim(
      { repo: 'delegated', ref: first.id, kind: 'merge', at: first.at },
      owner
    );
    const invalidSignature = {
      ...firstClaim,
      subj_sig: new Uint8Array(64),
    };
    const response = await server.fetch(
      signedPost(
        '/repos/delegated/land',
        await landBody(server.fetch, 'delegated', [second.id], owner, 'main', {
          contrib: [
            encodeClaim(firstClaim),
            encodeClaim(firstClaim),
            encodeClaim(secondClaim),
            encodeClaim(wrongRepo),
            encodeClaim(wrongKind),
            encodeClaim(wrongRef),
            encodeClaim(wrongSubject),
            encodeClaim(invalidSignature),
          ],
        }),
        owner
      )
    );
    expect(await response.json()).toMatchObject({
      landed: true,
      attestations: {
        received: 8,
        issued: 1,
        skipped: { duplicate: 1, ineligible: 5, rate_limited: 1 },
      },
    });
    const profile = (await (
      await server.fetch(
        new Request(`http://t/reputation/${encodeURIComponent(author.did)}`)
      )
    ).json()) as { attested: number; counted: number };
    expect(profile).toMatchObject({ attested: 1, counted: 1 });

    expect(
      (
        await server.fetch(
          signedPost(
            '/repos/delegated/policy',
            {
              policy: {
                version: 1,
                release: { creators: 'delegates', allow: [] },
              },
            },
            owner
          )
        )
      ).status
    ).toBe(200);
    const release = signRelease(
      {
        repo: 'delegated',
        tag: 'shared-limit',
        view: 'main',
        at: '2026-07-14T00:00:02.000Z',
        heads: [second.id],
        commits: [first.id, second.id],
        notes: null,
        artifacts: [],
      },
      author
    );
    const releaseClaim = signClaim(
      {
        repo: 'delegated',
        ref: release.id,
        kind: 'release',
        at: release.at,
      },
      author
    );
    const releaseResponse = await server.fetch(
      signedPost(
        '/repos/delegated/releases',
        { release: encodeRelease(release), claim: encodeClaim(releaseClaim) },
        author
      )
    );
    expect(releaseResponse.status).toBe(201);
    expect(await releaseResponse.json()).toMatchObject({
      attestations: {
        received: 1,
        issued: 0,
        skipped: { rate_limited: 1 },
      },
    });
  });

  test('continues landing when the asynchronous signer is unavailable', async () => {
    const owner = Identity.create();
    const author = Identity.create();
    const host = Identity.create();
    const errors: string[] = [];
    let signerCalls = 0;
    const server = createServer({
      backend: new MemoryBackend(),
      attester: {
        did: host.did,
        sign: () => {
          signerCalls += 1;
          return Promise.reject(new Error('KMS throttled'));
        },
      },
      onError: (_error, context) => errors.push(context.operation),
    });
    await createDelegatedRepo(server, 'outage', owner, author);
    const op = signOp(
      {
        path: 'outage.ts',
        parents: [],
        lamport: 0,
        at: '2026-07-14T00:00:00.000Z',
        payload: null,
      },
      author
    );
    const next = signOp(
      {
        path: 'outage-next.ts',
        parents: [op.id],
        lamport: 1,
        at: '2026-07-14T00:00:01.000Z',
        payload: null,
      },
      author
    );
    await server.fetch(
      signedPost('/repos/outage/push', encodeBundle([op, next], [], []), author)
    );
    const claim = signClaim(
      { repo: 'outage', ref: op.id, kind: 'merge', at: op.at },
      author
    );
    const nextClaim = signClaim(
      { repo: 'outage', ref: next.id, kind: 'merge', at: next.at },
      author
    );
    const response = await server.fetch(
      signedPost(
        '/repos/outage/land',
        await landBody(server.fetch, 'outage', [next.id], owner, 'main', {
          contrib: [encodeClaim(claim), encodeClaim(nextClaim)],
        }),
        owner
      )
    );
    expect(await response.json()).toMatchObject({
      landed: true,
      attestations: {
        received: 2,
        issued: 0,
        skipped: { signer_unavailable: 2 },
      },
    });
    expect(signerCalls).toBe(1);
    expect(errors).toContain('attestation-sign');
    const metrics = await (
      await server.fetch(new Request('http://t/metrics'))
    ).text();
    expect(metrics).toContain(
      'thaddeus_attestation_outcomes_total{outcome="signer_unavailable"} 2'
    );
  });
});
