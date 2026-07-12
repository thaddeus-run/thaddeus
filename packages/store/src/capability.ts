import { bytesToHex } from '@noble/hashes/utils';
import { Identity, PublicIdentity } from '@thaddeus.run/identity';

export interface Capability {
  readonly object: string;
  readonly grantee: string;
  readonly wrapped_key: Uint8Array;
  readonly granted_by: string;
  readonly not_before: string;
  readonly sig: Uint8Array;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

// Domain-separate capability signatures from other signed protocol payloads.
// v2 adds `wrapped_key`; a v1 signature (without it) no longer verifies.
const CAP_DOMAIN = 'thaddeus.store.cap.v2';

// Reject values that JSON.stringify would silently coerce or serialize into an
// ambiguous capability before signing or verification.
function assertCanonicalCap(
  object: string,
  grantee: string,
  notBefore: string
): void {
  if (typeof object !== 'string' || object.length === 0) {
    throw new TypeError('capability.object must be a non-empty string');
  }
  if (typeof grantee !== 'string' || grantee.length === 0) {
    throw new TypeError('capability.grantee must be a non-empty string');
  }
  if (typeof notBefore !== 'string' || notBefore.length === 0) {
    throw new TypeError('capability.not_before must be a non-empty string');
  }
}

// Bytes signed by the granter bind every security-sensitive grant field.
function canonical(
  object: string,
  grantee: string,
  notBefore: string,
  wrappedKey: Uint8Array
): Uint8Array {
  assertCanonicalCap(object, grantee, notBefore);
  return new TextEncoder().encode(
    JSON.stringify([
      CAP_DOMAIN,
      object,
      grantee,
      notBefore,
      bytesToHex(wrappedKey),
    ])
  );
}

export interface IssueParams {
  readonly object: string;
  readonly contentKey: Uint8Array;
  readonly grantee: PublicIdentity;
  readonly grantedBy: Identity;
  readonly notBefore?: string;
}

export function issueCapability(params: IssueParams): Capability {
  const notBefore = params.notBefore ?? EPOCH;
  const wrappedKey = params.grantee.seal(params.contentKey);
  return {
    object: params.object,
    grantee: params.grantee.did,
    wrapped_key: wrappedKey,
    granted_by: params.grantedBy.did,
    not_before: notBefore,
    sig: params.grantedBy.sign(
      canonical(params.object, params.grantee.did, notBefore, wrappedKey)
    ),
  };
}

export function verifyCapability(cap: Capability): boolean {
  try {
    return PublicIdentity.fromDid(cap.granted_by).verify(
      canonical(cap.object, cap.grantee, cap.not_before, cap.wrapped_key),
      cap.sig
    );
  } catch {
    return false;
  }
}

// Assumes the capability has ALREADY BEEN VERIFIED. The store always calls
// verifyCapability before unwrapping; any direct caller must do the same.
export function unwrapKey(cap: Capability, reader: Identity): Uint8Array {
  return reader.unseal(cap.wrapped_key);
}
