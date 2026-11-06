import { base64url, decodeUtf8, fromBase64url, utf8, verifyDid } from './codec';
import { AuthorityError } from './errors';
import {
  assertKind,
  assertTenant,
  canonicalGrants,
  type Grant,
  type PrincipalKind,
} from './scope';

/**
 * Signs for the trusted service. An `Identity` satisfies it; a hosted
 * deployment can pass a KMS-backed signer that never exposes key bytes.
 */
export interface ServiceSigner {
  readonly did: string;
  sign(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

// What a credential says. The service signs it; `subject` must sign every use.
export interface CredentialClaims {
  readonly v: 1;
  readonly id: string;
  readonly issuer: string;
  readonly tenant: string;
  // The policy member whose authority this credential is cut from. It equals
  // `subject` unless a member issued a session to an agent key it runs.
  readonly principal: string;
  // The holder key. Every request with this credential is signed by it.
  readonly subject: string;
  readonly kind: PrincipalKind;
  readonly grants: readonly Grant[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  // The policy version issuance checked against. Use is checked against the
  // policy current at that moment, not this one.
  readonly policyVersion: number;
}

const CREDENTIAL_PREFIX = 'thc1';
const CREDENTIAL_DOMAIN = 'thaddeus.authority.credential.v1';
const TICKET_PREFIX = 'tht1';
const TICKET_DOMAIN = 'thaddeus.authority.ticket.v1';

/**
 * Encodes `payload` as `<prefix>.<base64url JSON>.<base64url signature>`. The
 * signature covers the exact payload text, so verifying never depends on
 * re-serializing JSON the same way.
 */
async function sealToken(
  prefix: string,
  domain: string,
  payload: unknown,
  signer: ServiceSigner
): Promise<string> {
  const body = base64url(utf8(JSON.stringify(payload)));
  const sig = await signer.sign(utf8(`${domain}\n${body}`));
  return `${prefix}.${body}.${base64url(sig)}`;
}

/** Checks a token's form and the service signature, then returns its JSON. */
function openToken(
  prefix: string,
  domain: string,
  token: unknown,
  issuer: string
): Record<string, unknown> {
  if (typeof token !== 'string' || token.length > 64 * 1024) {
    throw new AuthorityError('malformed', 'a token must be a string');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== prefix) {
    throw new AuthorityError('malformed', `expected a ${prefix} token`);
  }
  const [, body = '', sig = ''] = parts;
  if (!verifyDid(issuer, utf8(`${domain}\n${body}`), fromBase64url(sig))) {
    throw new AuthorityError(
      'bad_credential',
      'the token was not signed by this service'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(fromBase64url(body)));
  } catch {
    throw new AuthorityError('malformed', 'the token payload is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AuthorityError('malformed', 'the token payload is not an object');
  }
  return parsed as Record<string, unknown>;
}

function assertTime(what: string, value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AuthorityError('malformed', `${what} must be a time in ms`);
  }
}

/** Signs credential claims into a token. */
export function encodeCredential(
  claims: CredentialClaims,
  signer: ServiceSigner
): Promise<string> {
  return sealToken(CREDENTIAL_PREFIX, CREDENTIAL_DOMAIN, claims, signer);
}

/**
 * Verifies a credential token's signature by `issuer` and the shape of its
 * claims. Expiry, revocation and policy are the authority's checks, not this.
 */
export function decodeCredential(
  token: unknown,
  issuer: string
): CredentialClaims {
  const raw = openToken(CREDENTIAL_PREFIX, CREDENTIAL_DOMAIN, token, issuer);
  const {
    v,
    id,
    issuer: claimedIssuer,
    tenant,
    principal,
    subject,
    kind,
    grants,
    issuedAt,
    expiresAt,
    policyVersion,
  } = raw;
  if (v !== 1 || claimedIssuer !== issuer) {
    throw new AuthorityError('bad_credential', 'unsupported credential');
  }
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) {
    throw new AuthorityError('malformed', 'credential id is malformed');
  }
  assertTenant(tenant);
  assertKind(kind);
  if (typeof principal !== 'string' || typeof subject !== 'string') {
    throw new AuthorityError('malformed', 'credential names no holder');
  }
  assertTime('issuedAt', issuedAt);
  assertTime('expiresAt', expiresAt);
  assertTime('policyVersion', policyVersion);
  return {
    v,
    id,
    issuer,
    tenant,
    principal,
    subject,
    kind,
    grants: canonicalGrants(grants),
    issuedAt,
    expiresAt,
    policyVersion,
  };
}

// A queued unit of work: the authorization a request had when it was queued.
// Redeeming it re-checks the credential and the policy as they are then.
export interface TicketClaims {
  readonly v: 1;
  readonly id: string;
  readonly credential: string;
  readonly scope: string;
  readonly repo: string;
  readonly paths: readonly string[];
  readonly queuedAt: number;
}

export function encodeTicket(
  claims: TicketClaims,
  signer: ServiceSigner
): Promise<string> {
  return sealToken(TICKET_PREFIX, TICKET_DOMAIN, claims, signer);
}

/** Verifies a ticket's service signature and returns its raw claims. */
export function decodeTicket(token: unknown, issuer: string): TicketClaims {
  let raw: Record<string, unknown>;
  try {
    raw = openToken(TICKET_PREFIX, TICKET_DOMAIN, token, issuer);
  } catch (error) {
    if (error instanceof AuthorityError) {
      throw new AuthorityError('bad_ticket', error.message);
    }
    throw error;
  }
  const { v, id, credential, scope, repo, paths, queuedAt } = raw;
  if (
    v !== 1 ||
    typeof id !== 'string' ||
    !/^[0-9a-f]{32}$/.test(id) ||
    typeof credential !== 'string' ||
    typeof scope !== 'string' ||
    typeof repo !== 'string' ||
    !Array.isArray(paths) ||
    paths.some((path) => typeof path !== 'string') ||
    !Number.isSafeInteger(queuedAt)
  ) {
    throw new AuthorityError('bad_ticket', 'the ticket is malformed');
  }
  return {
    v,
    id,
    credential,
    scope,
    repo,
    paths: paths as string[],
    queuedAt: queuedAt as number,
  };
}
