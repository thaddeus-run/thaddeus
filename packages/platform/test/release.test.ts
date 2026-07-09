import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  canonicalRelease,
  type ReleaseFields,
  releaseId,
  signRelease,
  verifyRelease,
} from '../src/release';

beforeAll(async () => {
  await ready();
});

const fields: ReleaseFields = {
  repo: 'acme/web',
  tag: 'v1.2.3',
  view: 'main',
  at: '2026-07-09T12:00:00.000Z',
  heads: ['head-b', 'head-a'],
  commits: ['op-1', 'op-2'],
  notes: 'First public release',
  artifacts: [
    {
      name: 'web-linux-x64.tar.gz',
      uri: 'https://cdn.example/web-linux-x64.tar.gz',
      sha256:
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      size: 5,
      mediaType: 'application/gzip',
    },
  ],
};

describe('signed releases', () => {
  test('canonical bytes, id, and signature are deterministic', () => {
    const signer = Identity.create();
    const release = signRelease(fields, signer);

    expect(release.id).toBe(releaseId(fields, signer.did));
    expect(release.sig).toEqual(
      signer.sign(canonicalRelease(fields, signer.did))
    );
    expect(verifyRelease(release)).toBe(true);
  });

  test('tampering with an artifact or commit list fails verification', () => {
    const signer = Identity.create();
    const release = signRelease(fields, signer);

    expect(
      verifyRelease({
        ...release,
        artifacts: [{ ...release.artifacts[0], size: 6 }],
      })
    ).toBe(false);
    expect(
      verifyRelease({ ...release, commits: [...release.commits, 'op-3'] })
    ).toBe(false);
  });

  test('malformed release fields fail closed', () => {
    const signer = Identity.create();
    const release = signRelease(fields, signer);

    expect(
      verifyRelease({
        ...release,
        artifacts: [{ ...release.artifacts[0], sha256: 'not-a-hash' }],
      })
    ).toBe(false);
    expect(verifyRelease({ ...release, sig: new Uint8Array(2) })).toBe(false);
  });
});
