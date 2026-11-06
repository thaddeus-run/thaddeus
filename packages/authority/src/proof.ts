import {
  base64url,
  byCodeUnit,
  digest,
  fromBase64url,
  signedBytes,
  verifyDid,
} from './codec';
import { AuthorityError } from './errors';
import {
  assertName,
  assertPattern,
  assertScope,
  assertTenant,
  canonicalGrants,
  type Grant,
  type PrincipalKind,
  type Scope,
} from './scope';

// A holder's signature over one request, with the freshness inputs that make
// it single-use: a timestamp inside the skew window and a nonce the authority
// consumes durably.
export interface Proof {
  readonly timestamp: number;
  readonly nonce: string;
  readonly signature: string;
}

// Anything that can sign as a did:key, such as an `Identity` or a browser's
// non-extractable WebCrypto key wrapped to this shape.
export interface HolderKey {
  readonly did: string;
  sign(bytes: Uint8Array): Uint8Array;
}

// One thing a credential is used for. `paths` are the patterns the request
// touches; `digest` lets a transport bind the proof to its exact request, such
// as a hash of the HTTP method, path and body.
export interface Action {
  readonly scope: Scope;
  readonly tenant: string;
  readonly repo: string;
  readonly paths: readonly string[];
  readonly digest?: string;
}

// A member asks the service for a credential for itself or for an agent key.
// `service` is the DID of the service asked, so the signed request cannot be
// replayed at another deployment where the same key is a member.
export interface IssueRequest {
  readonly service: string;
  readonly tenant: string;
  readonly principal: string;
  readonly subject: string;
  readonly kind: PrincipalKind;
  readonly grants: readonly Grant[];
  readonly ttlMs?: number;
}

export type RevokeTarget =
  | { readonly credential: string }
  | { readonly did: string };

export interface RevokeRequest {
  readonly service: string;
  readonly tenant: string;
  readonly actor: string;
  readonly target: RevokeTarget;
}

export const ACTION_DOMAIN = 'thaddeus.authority.action.v1';
export const ISSUE_DOMAIN = 'thaddeus.authority.issue.v1';
export const REVOKE_DOMAIN = 'thaddeus.authority.revoke.v1';
export const POLICY_DOMAIN = 'thaddeus.authority.policy.v1';

/** Validates an action and returns it with its paths in canonical order. */
export function canonicalAction(action: Action): Action {
  if (action === null || typeof action !== 'object') {
    throw new AuthorityError('malformed', 'an action must be an object');
  }
  assertScope(action.scope);
  assertTenant(action.tenant);
  assertName('repo', action.repo);
  if (!Array.isArray(action.paths) || action.paths.length === 0) {
    throw new AuthorityError('malformed', 'an action names at least one path');
  }
  if (action.paths.length > 10_000) {
    throw new AuthorityError('malformed', 'an action names too many paths');
  }
  for (const pattern of action.paths) assertPattern(pattern);
  if (
    action.digest !== undefined &&
    (typeof action.digest !== 'string' || action.digest.length > 256)
  ) {
    throw new AuthorityError('malformed', 'digest must be a short string');
  }
  return {
    scope: action.scope,
    tenant: action.tenant,
    repo: action.repo,
    paths: [...new Set(action.paths)].sort(byCodeUnit),
    ...(action.digest === undefined ? {} : { digest: action.digest }),
  };
}

/** Binds an action proof to one credential token without parsing it. */
export function tokenDigest(token: string): string {
  return digest('thaddeus.authority.token.v1', token);
}

export function actionBody(token: string, action: Action): unknown {
  const a = canonicalAction(action);
  return [
    tokenDigest(token),
    a.scope,
    a.tenant,
    a.repo,
    a.paths,
    a.digest ?? '',
  ];
}

export function issueBody(request: IssueRequest): unknown {
  return [
    request.service,
    request.tenant,
    request.principal,
    request.subject,
    request.kind,
    canonicalGrants(request.grants),
    request.ttlMs ?? null,
  ];
}

export function revokeBody(request: RevokeRequest): unknown {
  const target =
    'credential' in request.target
      ? { credential: tokenDigest(request.target.credential) }
      : { did: request.target.did };
  return [request.service, request.tenant, request.actor, target];
}

function signProof(
  key: HolderKey,
  domain: string,
  body: unknown,
  options: { readonly now?: number; readonly nonce?: string } = {}
): Proof {
  const timestamp = options.now ?? Date.now();
  const nonce = options.nonce ?? crypto.randomUUID();
  const sig = key.sign(signedBytes(domain, [body, timestamp, nonce]));
  return { timestamp, nonce, signature: base64url(sig) };
}

/** A holder signs one use of its credential. */
export function proveAction(
  holder: HolderKey,
  token: string,
  action: Action,
  options?: { readonly now?: number; readonly nonce?: string }
): Proof {
  return signProof(holder, ACTION_DOMAIN, actionBody(token, action), options);
}

/** A member signs its request for a credential. */
export function proveIssue(
  principal: HolderKey,
  request: IssueRequest,
  options?: { readonly now?: number; readonly nonce?: string }
): Proof {
  return signProof(principal, ISSUE_DOMAIN, issueBody(request), options);
}

/** An admin, principal or holder signs a revocation. */
export function proveRevoke(
  actor: HolderKey,
  request: RevokeRequest,
  options?: { readonly now?: number; readonly nonce?: string }
): Proof {
  return signProof(actor, REVOKE_DOMAIN, revokeBody(request), options);
}

/** Signs any domain-tagged body; the policy change helper builds on this. */
export function proveBody(
  key: HolderKey,
  domain: string,
  body: unknown,
  options?: { readonly now?: number; readonly nonce?: string }
): Proof {
  return signProof(key, domain, body, options);
}

/** Throws `bad_proof` unless `did` signed `body` with this proof's inputs. */
export function checkProofSignature(
  did: string,
  domain: string,
  body: unknown,
  proof: Proof
): void {
  if (
    proof === null ||
    typeof proof !== 'object' ||
    !Number.isSafeInteger(proof.timestamp) ||
    typeof proof.nonce !== 'string' ||
    proof.nonce.length === 0 ||
    proof.nonce.length > 128 ||
    typeof proof.signature !== 'string'
  ) {
    throw new AuthorityError('bad_proof', 'the proof is malformed');
  }
  let signature: Uint8Array;
  try {
    signature = fromBase64url(proof.signature);
  } catch {
    throw new AuthorityError('bad_proof', 'the proof signature is malformed');
  }
  const bytes = signedBytes(domain, [body, proof.timestamp, proof.nonce]);
  if (!verifyDid(did, bytes, signature)) {
    throw new AuthorityError(
      'bad_proof',
      `the request was not signed by ${did}`
    );
  }
}
