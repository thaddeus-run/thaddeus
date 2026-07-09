import { Identity, ready } from '@thaddeus.run/identity';
import { signRelease } from '@thaddeus.run/platform';
import { beforeAll, expect, test } from 'bun:test';

import { decodeRelease, encodeRelease } from '../src/dto';

beforeAll(async () => {
  await ready();
});

test('release DTO preserves signature bytes', () => {
  const release = signRelease(
    {
      repo: 'r',
      tag: 'v1',
      view: 'main',
      at: '2026-07-09T12:00:00.000Z',
      heads: [],
      commits: [],
      notes: null,
      artifacts: [],
    },
    Identity.create()
  );

  expect(decodeRelease(encodeRelease(release))).toEqual(release);
});
