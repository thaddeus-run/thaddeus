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

// Bytes signed by the granter: binds object, grantee, and start time so none
// can be swapped without breaking the signature.
function canonical(
  object: string,
  grantee: string,
  notBefore: string
): Uint8Array {
  return new TextEncoder().encode(`${object}\n${grantee}\n${notBefore}`);
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
  return {
    object: params.object,
    grantee: params.grantee.did,
    wrapped_key: params.grantee.seal(params.contentKey),
    granted_by: params.grantedBy.did,
    not_before: notBefore,
    sig: params.grantedBy.sign(
      canonical(params.object, params.grantee.did, notBefore)
    ),
  };
}

export function verifyCapability(cap: Capability): boolean {
  return PublicIdentity.fromDid(cap.granted_by).verify(
    canonical(cap.object, cap.grantee, cap.not_before),
    cap.sig
  );
}

export function unwrapKey(cap: Capability, reader: Identity): Uint8Array {
  return reader.unseal(cap.wrapped_key);
}
