import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';

import {
  base64url,
  byCodeUnit,
  fromBase64url,
  signedBytes,
  verifyDid,
} from './codec';
import { AuthorityError } from './errors';
import type { HolderKey } from './proof';
import type { PrincipalKind } from './scope';

// What an advancement changes: the view's next version, the record it
// replaces, the revision it now points at and the paths that changed.
export interface HeadContent {
  readonly tenant: string;
  readonly repo: string;
  readonly view: string;
  readonly version: number;
  readonly previous: string | null;
  readonly revision: string;
  readonly paths: readonly string[];
}

// An actor's own signature over a head's content. Only these are ever shown
// as "signed by" an agent or a human.
export interface ActorClaim {
  readonly did: string;
  readonly signature: string;
}

// Who asked for the advancement, as the service recorded it from the
// credential that authorized it. This is an attribution, not a signature.
export interface RequestedBy {
  readonly principal: string;
  readonly subject: string;
  readonly kind: PrincipalKind;
  readonly credential: string;
}

// A shared-history advancement the trusted service authorized and signed.
export interface ServiceHeadRecord extends HeadContent {
  readonly v: 1;
  readonly id: string;
  readonly service: string;
  readonly at: number;
  readonly policyVersion: number;
  readonly requestedBy: RequestedBy;
  readonly actorClaims: readonly ActorClaim[];
  readonly signature: string;
}

// How a reader should present a record: who recorded it, who the service says
// asked for it, and which actors signed its content themselves.
export interface Attribution {
  readonly recordedBy: string;
  readonly requestedBy: RequestedBy;
  readonly signedBy: readonly string[];
}

const ACTOR_CLAIM_DOMAIN = 'thaddeus.authority.actor-claim.v1';
const HEAD_DOMAIN = 'thaddeus.authority.head.v1';

function contentTuple(content: HeadContent): unknown[] {
  return [
    content.tenant,
    content.repo,
    content.view,
    content.version,
    content.previous,
    content.revision,
    [...content.paths].sort(byCodeUnit),
  ];
}

export function actorClaimBytes(content: HeadContent): Uint8Array {
  return signedBytes(ACTOR_CLAIM_DOMAIN, contentTuple(content));
}

/** An actor signs the exact head content it vouches for. */
export function signActorClaim(
  actor: HolderKey,
  content: HeadContent
): ActorClaim {
  return {
    did: actor.did,
    signature: base64url(actor.sign(actorClaimBytes(content))),
  };
}

/** True when `claim` is `claim.did`'s signature over this content. */
export function verifyActorClaim(
  content: HeadContent,
  claim: ActorClaim
): boolean {
  if (
    claim === null ||
    typeof claim !== 'object' ||
    typeof claim.did !== 'string' ||
    typeof claim.signature !== 'string'
  ) {
    return false;
  }
  try {
    return verifyDid(
      claim.did,
      actorClaimBytes(content),
      fromBase64url(claim.signature)
    );
  } catch {
    return false;
  }
}

type UnsignedHead = Omit<ServiceHeadRecord, 'id' | 'signature'>;

export function headBytes(record: UnsignedHead): Uint8Array {
  return signedBytes(HEAD_DOMAIN, [
    record.v,
    record.service,
    record.at,
    record.policyVersion,
    contentTuple(record),
    [
      record.requestedBy.principal,
      record.requestedBy.subject,
      record.requestedBy.kind,
      record.requestedBy.credential,
    ],
    record.actorClaims.map((claim) => [claim.did, claim.signature]),
  ]);
}

/** The record id: hex BLAKE3 of the bytes the service signs. */
export function headId(record: UnsignedHead): string {
  return bytesToHex(blake3(headBytes(record)));
}

/**
 * Throws unless `record` carries a valid signature by `service`, its id
 * matches its content, and every actor claim in it verifies.
 */
export function verifyHeadRecord(
  record: ServiceHeadRecord,
  service: string
): void {
  if (record.v !== 1 || record.service !== service) {
    throw new AuthorityError(
      'invalid_claim',
      'the head record is not from this service'
    );
  }
  const { id, signature, ...unsigned } = record;
  if (id !== headId(unsigned)) {
    throw new AuthorityError('invalid_claim', 'the head record id is wrong');
  }
  let sig: Uint8Array;
  try {
    sig = fromBase64url(signature);
  } catch {
    throw new AuthorityError(
      'invalid_claim',
      'the head signature is malformed'
    );
  }
  if (!verifyDid(service, headBytes(unsigned), sig)) {
    throw new AuthorityError(
      'invalid_claim',
      'the head record signature is invalid'
    );
  }
  for (const claim of record.actorClaims) {
    if (!verifyActorClaim(record, claim)) {
      throw new AuthorityError(
        'invalid_claim',
        `the actor claim by ${claim.did} does not verify`
      );
    }
  }
}

/**
 * Says how to present a verified record. `requestedBy` comes from the
 * service's own record of the credential; `signedBy` lists only actors whose
 * signatures verify, so a service-recorded request is never shown as one.
 */
export function describeAttribution(record: ServiceHeadRecord): Attribution {
  return {
    recordedBy: record.service,
    requestedBy: record.requestedBy,
    signedBy: record.actorClaims
      .filter((claim) => verifyActorClaim(record, claim))
      .map((claim) => claim.did),
  };
}
