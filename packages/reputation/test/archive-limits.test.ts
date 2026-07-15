import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  decodeReputationArchive,
  encodeReputationArchive,
  REPUTATION_ARCHIVE_FORMAT,
  ReputationArchiveLimitError,
} from '../src/archive';
import { signContribution } from '../src/contribution';

beforeAll(async () => {
  await ready();
});

describe('bounded reputation archive decoding', () => {
  test('checks UTF-8 archive bytes before parsing JSON', () => {
    expect(() => decodeReputationArchive('💥{', { maxBytes: 4 })).toThrow(
      ReputationArchiveLimitError
    );
    try {
      decodeReputationArchive('💥{', { maxBytes: 4 });
    } catch (error) {
      expect((error as ReputationArchiveLimitError).code).toBe(
        'archive_too_large'
      );
    }
  });

  test('checks raw count and multibyte logical fields inclusively', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const contribution = signContribution(
      { repo: 'é', ref: 'r', kind: 'merge', at: '2026-01-01T00:00:00Z' },
      subject,
      host
    );
    const encoded = encodeReputationArchive({
      format: REPUTATION_ARCHIVE_FORMAT,
      subject: subject.did,
      contributions: [contribution],
    });
    expect(
      decodeReputationArchive(encoded, {
        maxBytes: new TextEncoder().encode(encoded).length,
        maxContributions: 1,
        maxFieldBytes: 128,
      }).contributions
    ).toHaveLength(1);
    expect(() =>
      decodeReputationArchive(encoded, { maxContributions: 0 as never })
    ).toThrow(RangeError);
    expect(() =>
      decodeReputationArchive(encoded, { maxFieldBytes: 1 })
    ).toThrow(ReputationArchiveLimitError);

    const raw = JSON.parse(encoded) as { contributions: unknown[] };
    raw.contributions.push(null);
    expect(() =>
      decodeReputationArchive(JSON.stringify(raw), { maxContributions: 1 })
    ).toThrow(ReputationArchiveLimitError);
  });
});
