import { describe, expect, test } from 'bun:test';

import { normalizeRepoPolicy } from '../src/repo-policy';

const legacyPolicy = {
  version: 1,
  restrictPaths: [],
  standingQueries: [],
  requireVerifiedProvenance: false,
  requirePassingChecks: null,
};

describe('release policy normalization', () => {
  test('a policy without release settings remains owner-only', () => {
    expect(normalizeRepoPolicy(legacyPolicy).release).toEqual({
      creators: 'owner',
      allow: [],
    });
  });

  test('delegates and allowList modes normalize with their allow list', () => {
    expect(
      normalizeRepoPolicy({
        ...legacyPolicy,
        release: { creators: 'delegates', allow: [] },
      }).release
    ).toEqual({ creators: 'delegates', allow: [] });
    expect(
      normalizeRepoPolicy({
        ...legacyPolicy,
        release: { creators: 'allowList', allow: ['did:key:zListed'] },
      }).release
    ).toEqual({ creators: 'allowList', allow: ['did:key:zListed'] });
  });

  test('invalid release creator modes and allow lists are rejected', () => {
    expect(() =>
      normalizeRepoPolicy({
        ...legacyPolicy,
        release: { creators: 'everyone', allow: [] },
      })
    ).toThrow('release.creators');
    expect(() =>
      normalizeRepoPolicy({
        ...legacyPolicy,
        release: { creators: 'allowList', allow: [1] },
      })
    ).toThrow('release.allow');
  });
});
