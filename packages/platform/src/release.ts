import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { Identity, PublicIdentity } from '@thaddeus.run/identity';

export interface ReleaseArtifact {
  name: string;
  uri: string;
  sha256: string;
  size: number | null;
  mediaType: string | null;
}

export interface ReleaseFields {
  repo: string;
  tag: string;
  view: string;
  at: string;
  heads: string[];
  commits: string[];
  notes: string | null;
  artifacts: ReleaseArtifact[];
}

export interface Release extends ReleaseFields {
  id: string;
  signed_by: string;
  sig: Uint8Array;
}

const RELEASE_DOMAIN = 'thaddeus.release.v1';
const SHA256_HEX = /^[0-9a-f]{64}$/;

function nonEmptyString(
  value: unknown,
  label: string
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`release.${label} must be a non-empty string`);
  }
}

function stringSet(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`release.${label} must be an array`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    nonEmptyString(entry, `${label} entries`);
    if (seen.has(entry)) {
      throw new TypeError(`release.${label} must not contain duplicates`);
    }
    seen.add(entry);
  }
}

function assertArtifact(value: unknown): asserts value is ReleaseArtifact {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('release.artifacts entries must be objects');
  }
  const artifact = value as Partial<ReleaseArtifact>;
  nonEmptyString(artifact.name, 'artifact.name');
  nonEmptyString(artifact.uri, 'artifact.uri');
  if (
    typeof artifact.sha256 !== 'string' ||
    !SHA256_HEX.test(artifact.sha256)
  ) {
    throw new TypeError(
      'release.artifact.sha256 must be a lowercase 64-character hex string'
    );
  }
  if (
    artifact.size !== null &&
    (!Number.isSafeInteger(artifact.size) || (artifact.size ?? -1) < 0)
  ) {
    throw new TypeError(
      'release.artifact.size must be a non-negative safe integer or null'
    );
  }
  if (
    artifact.mediaType !== null &&
    (typeof artifact.mediaType !== 'string' || artifact.mediaType.length === 0)
  ) {
    throw new TypeError(
      'release.artifact.mediaType must be a non-empty string or null'
    );
  }
}

function assertCanonical(fields: ReleaseFields, signedBy: string): void {
  nonEmptyString(fields.repo, 'repo');
  nonEmptyString(fields.tag, 'tag');
  nonEmptyString(fields.view, 'view');
  nonEmptyString(signedBy, 'signed_by');
  if (
    typeof fields.at !== 'string' ||
    !fields.at.endsWith('Z') ||
    Number.isNaN(Date.parse(fields.at))
  ) {
    throw new TypeError(
      'release.at must be an ISO-8601 UTC timestamp string (Z-suffixed)'
    );
  }
  stringSet(fields.heads, 'heads');
  stringSet(fields.commits, 'commits');
  if (
    fields.notes !== null &&
    (typeof fields.notes !== 'string' || fields.notes.length === 0)
  ) {
    throw new TypeError('release.notes must be a non-empty string or null');
  }
  if (!Array.isArray(fields.artifacts)) {
    throw new TypeError('release.artifacts must be an array');
  }
  for (const artifact of fields.artifacts) {
    assertArtifact(artifact);
  }
}

// Encode every signed field in a fixed tuple so release ids and signatures are
// stable across JSON object-key ordering and independent implementations.
export function canonicalRelease(
  fields: ReleaseFields,
  signedBy: string
): Uint8Array {
  assertCanonical(fields, signedBy);
  return new TextEncoder().encode(
    JSON.stringify([
      RELEASE_DOMAIN,
      fields.repo,
      fields.tag,
      fields.view,
      fields.at,
      fields.heads,
      fields.commits,
      fields.notes,
      fields.artifacts.map((artifact) => [
        artifact.name,
        artifact.uri,
        artifact.sha256,
        artifact.size,
        artifact.mediaType,
      ]),
      signedBy,
    ])
  );
}

export function releaseId(fields: ReleaseFields, signedBy: string): string {
  return bytesToHex(blake3(canonicalRelease(fields, signedBy)));
}

export function signRelease(fields: ReleaseFields, signer: Identity): Release {
  const bytes = canonicalRelease(fields, signer.did);
  return {
    ...fields,
    id: bytesToHex(blake3(bytes)),
    signed_by: signer.did,
    sig: signer.sign(bytes),
  };
}

// Verify both the content id and DID signature. Any malformed remote record is
// rejected as false so callers can treat release verification as fail-closed.
export function verifyRelease(release: Release): boolean {
  try {
    const bytes = canonicalRelease(release, release.signed_by);
    if (bytesToHex(blake3(bytes)) !== release.id) {
      return false;
    }
    return PublicIdentity.fromDid(release.signed_by).verify(bytes, release.sig);
  } catch {
    return false;
  }
}
