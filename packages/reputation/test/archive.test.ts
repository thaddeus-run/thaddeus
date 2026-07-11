import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  decodeReputationArchive,
  encodeReputationArchive,
  REPUTATION_ARCHIVE_FORMAT,
  type ReputationArchive,
} from '../src/archive';
import { signContribution } from '../src/contribution';

beforeAll(async () => {
  await ready();
});

describe('portable reputation archive', () => {
  test('round-trips signature bytes and normalizes order and duplicates', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const first = signContribution(
      { repo: 'r', ref: 'a', kind: 'merge', at: '2026-07-01T00:00:00Z' },
      subject,
      host
    );
    const second = signContribution(
      { repo: 'r', ref: 'b', kind: 'review', at: '2026-07-02T00:00:00Z' },
      subject,
      host
    );
    const archive: ReputationArchive = {
      format: REPUTATION_ARCHIVE_FORMAT,
      subject: subject.did,
      contributions: [second, first, first],
    };

    const encoded = encodeReputationArchive(archive);
    const decoded = decodeReputationArchive(encoded);
    expect(decoded.contributions.map((c) => c.ref)).toEqual(['a', 'b']);
    expect(decoded.contributions[0]?.subj_sig).toEqual(first.subj_sig);
    expect(decoded.contributions[0]?.host_sig).toEqual(first.host_sig);
    expect(encodeReputationArchive(decoded)).toBe(encoded);
  });

  test('accepts an empty archive for a valid subject', () => {
    const subject = Identity.create();
    const decoded = decodeReputationArchive(
      encodeReputationArchive({
        format: REPUTATION_ARCHIVE_FORMAT,
        subject: subject.did,
        contributions: [],
      })
    );
    expect(decoded.contributions).toEqual([]);
  });

  test('rejects malformed, mixed-subject, and non-verifying records', () => {
    const subject = Identity.create();
    const other = Identity.create();
    const host = Identity.create();
    const contribution = signContribution(
      { repo: 'r', ref: 'a', kind: 'merge', at: '2026-07-01T00:00:00Z' },
      subject,
      host
    );
    expect(() => decodeReputationArchive('{')).toThrow('malformed');
    expect(() =>
      decodeReputationArchive(
        JSON.stringify({
          format: 'future',
          subject: subject.did,
          contributions: [],
        })
      )
    ).toThrow('unsupported');
    expect(() =>
      encodeReputationArchive({
        format: REPUTATION_ARCHIVE_FORMAT,
        subject: other.did,
        contributions: [contribution],
      })
    ).toThrow('different subject');
    expect(() =>
      encodeReputationArchive({
        format: REPUTATION_ARCHIVE_FORMAT,
        subject: subject.did,
        contributions: [
          { ...contribution, host_sig: new Uint8Array(contribution.host_sig) },
        ],
      })
    ).not.toThrow();
    const bad = new Uint8Array(contribution.host_sig);
    bad[0] = (bad[0] ?? 0) ^ 1;
    expect(() =>
      encodeReputationArchive({
        format: REPUTATION_ARCHIVE_FORMAT,
        subject: subject.did,
        contributions: [{ ...contribution, host_sig: bad }],
      })
    ).toThrow('authentic and host-attested');
  });

  test('rejects non-canonical base64', () => {
    const subject = Identity.create();
    const host = Identity.create();
    const contribution = signContribution(
      { repo: 'r', ref: 'a', kind: 'merge', at: '2026-07-01T00:00:00Z' },
      subject,
      host
    );
    const wire = JSON.parse(
      encodeReputationArchive({
        format: REPUTATION_ARCHIVE_FORMAT,
        subject: subject.did,
        contributions: [contribution],
      })
    ) as { contributions: { subj_sig: string }[] };
    wire.contributions[0].subj_sig += '=';
    expect(() => decodeReputationArchive(JSON.stringify(wire))).toThrow(
      'canonical base64'
    );
  });
});
