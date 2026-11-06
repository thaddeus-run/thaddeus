import {
  type Backend,
  decodeRecord,
  DEFAULT_REPLAY_NONCE_CAPACITY,
  encodeRecord,
  MAX_REPLAY_NONCE_CAPACITY,
  type ReplayNonceBackend,
} from '@thaddeus.run/store';

import {
  assertDid,
  base64url,
  byCodeUnit,
  deepFreeze,
  digest,
  randomId,
} from './codec';
import { AuthorityError, type AuthorityErrorCode } from './errors';
import {
  type ActorClaim,
  headBytes,
  headId,
  type ServiceHeadRecord,
  verifyActorClaim,
  verifyHeadRecord,
} from './head';
import {
  canonicalPolicyBody,
  memberOf,
  type PolicyBody,
  type PolicyChange,
  policyChangeBody,
  type TenantPolicy,
} from './policy';
import {
  type Action,
  ACTION_DOMAIN,
  actionBody,
  canonicalAction,
  checkProofSignature,
  ISSUE_DOMAIN,
  issueBody,
  type IssueRequest,
  POLICY_DOMAIN,
  type Proof,
  REVOKE_DOMAIN,
  revokeBody,
  type RevokeRequest,
} from './proof';
import {
  assertKind,
  assertName,
  assertPath,
  assertPattern,
  assertScope,
  assertTenant,
  canonicalGrants,
  grantsCover,
  grantsSubsume,
  patternCovers,
  type PrincipalKind,
  type Scope,
} from './scope';
import {
  type CredentialClaims,
  decodeCredential,
  decodeTicket,
  encodeCredential,
  encodeTicket,
  type ServiceSigner,
} from './token';

// A proof's timestamp must be within this distance of the authority's clock,
// the same window the shipped server allows for signed requests.
export const PROOF_SKEW_MS: number = 5 * 60 * 1000;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export interface TtlRule {
  readonly defaultMs: number;
  readonly maxMs: number;
}

// Agents and workers get short-lived credentials; humans get sessions that
// last a working day at most. A host may lower these, never raise them.
export const DEFAULT_TTL: Readonly<Record<PrincipalKind, TtlRule>> = deepFreeze(
  {
    human: { defaultMs: 8 * HOUR, maxMs: 12 * HOUR },
    agent: { defaultMs: 15 * MINUTE, maxMs: HOUR },
    worker: { defaultMs: 15 * MINUTE, maxMs: HOUR },
  }
);

export interface AuthorityOptions {
  // Durable state. The nonce capability makes replay protection survive a
  // restart; MemoryBackend and FileBackend both provide it.
  readonly backend: Backend & ReplayNonceBackend;
  // The service's signing identity for credentials, tickets and head records.
  readonly signer: ServiceSigner;
  readonly now?: () => number;
  readonly ttl?: Partial<Record<PrincipalKind, TtlRule>>;
  readonly proofSkewMs?: number;
  readonly nonceCapacity?: number;
}

export type AuditEvent =
  | 'tenant.create'
  | 'policy.change'
  | 'credential.issue'
  | 'credential.revoke'
  | 'authorize'
  | 'plaintext.read'
  | 'plaintext.write'
  | 'ticket.queue'
  | 'ticket.redeem'
  | 'history.advance';

// One audit entry. The service writes these itself; they record what it did
// and for whom, and they are never signatures by the people they name.
export interface AuditRecord {
  readonly id: string;
  readonly at: number;
  readonly tenant: string;
  readonly event: AuditEvent;
  readonly outcome: 'allow' | 'deny';
  readonly actor?: string;
  readonly principal?: string;
  readonly subject?: string;
  readonly kind?: PrincipalKind;
  readonly credential?: string;
  readonly scope?: Scope;
  readonly repo?: string;
  readonly paths?: readonly string[];
  readonly code?: AuthorityErrorCode;
  readonly detail?: string;
}

export interface Issued {
  readonly token: string;
  readonly claims: CredentialClaims;
}

export interface AdvanceInput {
  readonly view: string;
  // The version the caller saw, or null to create the view's first record.
  readonly expectedVersion: number | null;
  readonly revision: string;
  // Every file path the revision changes against the view's current
  // revision, from the host's own diff. Each must be inside the
  // authorization's paths, and the record names them.
  readonly changedPaths: readonly string[];
  readonly actorClaims?: readonly ActorClaim[];
}

interface Internals {
  readonly authority: Authority;
  readonly claims: CredentialClaims;
  readonly token: string;
  // The canonical action the authority checked. Gates read scope, repository
  // and paths from here, never from the public object.
  readonly action: Action;
}

// Authorizations are only real if this module made them. Gates look an
// authorization up here, so a hand-built object with the same fields is
// refused.
const genuine = new WeakMap<Authorization, Internals>();

/** @internal True when one of `patterns` covers the exact file `path`. */
export function reaches(patterns: readonly string[], path: string): boolean {
  try {
    assertPattern(path);
  } catch {
    return false;
  }
  return patterns.some((pattern) => patternCovers(pattern, path));
}

type AuditBase = Omit<AuditRecord, 'id' | 'at' | 'outcome'>;
type AuditWriter = (record: Omit<AuditRecord, 'id' | 'at'>) => Promise<void>;
const auditors = new WeakMap<Authority, AuditWriter>();

/** @internal Writes one audit record through `authority`, for package gates. */
export function writeAudit(
  authority: Authority,
  record: Omit<AuditRecord, 'id' | 'at'>
): Promise<void> {
  const write = auditors.get(authority);
  if (write === undefined) throw new TypeError('not an authority');
  return write(record);
}

/**
 * Proof that one request passed the authority: a holder used a live
 * credential for `scope` over `paths` in `repo`. Gates such as key custody
 * and head advancement re-check it at the moment they act.
 */
export class Authorization {
  readonly tenant: string;
  readonly repo: string;
  readonly scope: Scope;
  readonly paths: readonly string[];
  readonly principal: string;
  readonly subject: string;
  readonly kind: PrincipalKind;
  readonly credential: string;
  readonly expiresAt: number;
  readonly policyVersion: number;
  // Set when the authorization came from redeeming a queued ticket.
  readonly ticket: string | null;

  /** @internal Only `Authority` constructs these. */
  constructor(
    claims: CredentialClaims,
    action: Action,
    policyVersion: number,
    ticket: string | null
  ) {
    this.tenant = claims.tenant;
    this.repo = action.repo;
    this.scope = action.scope;
    this.paths = Object.freeze([...action.paths]);
    this.principal = claims.principal;
    this.subject = claims.subject;
    this.kind = claims.kind;
    this.credential = claims.id;
    this.expiresAt = claims.expiresAt;
    this.policyVersion = policyVersion;
    this.ticket = ticket;
    // Gates read these fields, so they must not change after the check that
    // produced them, not even through a cast.
    Object.freeze(this);
  }

  /**
   * True when this authorization reaches `path`. Hosts filter listings,
   * search hits, logs and subscription events through this.
   */
  allows(path: string): boolean {
    return reaches(this.paths, path);
  }
}

/** @internal The state behind a genuine authorization, for package gates. */
export function internalsOf(authorization: unknown): Internals {
  const internals =
    authorization instanceof Authorization
      ? genuine.get(authorization)
      : undefined;
  if (internals === undefined) {
    throw new AuthorityError(
      'bad_credential',
      'not an authorization this authority issued'
    );
  }
  return internals;
}

// Backend layout. Tenants are slugs; repositories, views and DIDs are hashed
// so any name fits in a key.
const POLICY_PREFIX = 'authority/policy/';
const REVOCATION_PREFIX = 'authority/revocation/';
const pad = (n: number, width: number): string =>
  String(n).padStart(width, '0');
const policyKey = (tenant: string, version: number): string =>
  `${POLICY_PREFIX}${tenant}/${pad(version, 12)}`;
const nameKey = (name: string): string =>
  digest('thaddeus.authority.name', name);
const headPrefix = (tenant: string, repo: string, view: string): string =>
  `authority/head/${tenant}/${nameKey(repo)}/${nameKey(view)}/`;

/**
 * The trusted service's authority over one backend. It keeps every tenant's
 * policy, issues holder-bound credentials, checks each use against the policy
 * of that moment, and serializes every change to a tenant's authority so a
 * revocation or policy change and an advancement never interleave.
 *
 * Revocations and policy are loaded at `open` and written through. Like the
 * shipped server, one process owns the backend: a second process sees another
 * one's revocations only after it reopens (THA-83 owns cross-node revocation).
 */
export class Authority {
  readonly did: string;
  readonly #backend: Backend & ReplayNonceBackend;
  readonly #signer: ServiceSigner;
  readonly #now: () => number;
  readonly #ttl: Readonly<Record<PrincipalKind, TtlRule>>;
  readonly #skew: number;
  readonly #capacity: number;
  readonly #instance = randomId().slice(0, 8);
  readonly #policies = new Map<string, TenantPolicy>();
  readonly #revokedCredentials = new Set<string>();
  // `${tenant}\n${did}` to the latest revocation time for that DID.
  readonly #revokedDids = new Map<string, number>();
  readonly #heads = new Map<string, ServiceHeadRecord | null>();
  readonly #locks = new Map<string, Promise<unknown>>();
  #auditSeq = 0;

  private constructor(options: AuthorityOptions) {
    assertDid('signer', options.signer.did);
    if (
      typeof options.backend.consumeNonce !== 'function' ||
      typeof options.backend.putIfAbsent !== 'function'
    ) {
      throw new TypeError(
        'the authority needs a backend with durable replay nonces and atomic create'
      );
    }
    const ttl: Record<PrincipalKind, TtlRule> = { ...DEFAULT_TTL };
    for (const [kind, rule] of Object.entries(options.ttl ?? {})) {
      assertKind(kind);
      const ceiling = DEFAULT_TTL[kind];
      if (
        rule === undefined ||
        !Number.isSafeInteger(rule.maxMs) ||
        !Number.isSafeInteger(rule.defaultMs) ||
        rule.defaultMs < 1 ||
        rule.defaultMs > rule.maxMs ||
        rule.maxMs > ceiling.maxMs
      ) {
        throw new RangeError(
          `${kind} ttl must satisfy 1 <= default <= max <= ${ceiling.maxMs}`
        );
      }
      ttl[kind] = Object.freeze({
        defaultMs: rule.defaultMs,
        maxMs: rule.maxMs,
      });
    }
    const skew = options.proofSkewMs ?? PROOF_SKEW_MS;
    if (!Number.isSafeInteger(skew) || skew < 1 || skew > PROOF_SKEW_MS) {
      throw new RangeError(`proofSkewMs must be 1..${PROOF_SKEW_MS}`);
    }
    const capacity = options.nonceCapacity ?? DEFAULT_REPLAY_NONCE_CAPACITY;
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      capacity > MAX_REPLAY_NONCE_CAPACITY
    ) {
      throw new RangeError(
        `nonceCapacity must be 1..${MAX_REPLAY_NONCE_CAPACITY}`
      );
    }
    this.did = options.signer.did;
    this.#backend = options.backend;
    this.#signer = options.signer;
    this.#now = options.now ?? Date.now;
    this.#ttl = ttl;
    this.#skew = skew;
    this.#capacity = capacity;
    auditors.set(this, (record) => this.#audit(record));
  }

  /** Opens the authority, loading every tenant's policy and revocations. */
  static async open(options: AuthorityOptions): Promise<Authority> {
    const authority = new Authority(options);
    await authority.#load();
    return authority;
  }

  async #load(): Promise<void> {
    const latest = new Map<string, string>();
    for (const key of await this.#backend.list(POLICY_PREFIX)) {
      const tenant = key.slice(POLICY_PREFIX.length).split('/')[0] ?? '';
      const current = latest.get(tenant);
      if (current === undefined || key > current) latest.set(tenant, key);
    }
    for (const key of latest.values()) {
      const policy = await this.#read<TenantPolicy>(key);
      if (policy !== undefined) {
        this.#policies.set(policy.tenant, deepFreeze(policy));
      }
    }
    for (const key of await this.#backend.list(REVOCATION_PREFIX)) {
      const record = await this.#read<{
        tenant: string;
        credential?: string;
        did?: string;
        at: number;
      }>(key);
      if (record === undefined) continue;
      if (record.credential !== undefined) {
        this.#revokedCredentials.add(record.credential);
      } else if (record.did !== undefined) {
        this.#noteDidRevocation(record.tenant, record.did, record.at);
      }
    }
  }

  async #read<T>(key: string): Promise<T | undefined> {
    const bytes = await this.#backend.get(key);
    return bytes === undefined ? undefined : (decodeRecord(bytes) as T);
  }

  // Runs `work` after every earlier change to the same tenant has finished.
  #lock<T>(tenant: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(tenant) ?? Promise.resolve();
    const result = previous.then(work, work);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.#locks.set(tenant, settled);
    void settled.then(() => {
      if (this.#locks.get(tenant) === settled) this.#locks.delete(tenant);
    });
    return result;
  }

  /** The tenant's current policy. It is frozen; change it with changePolicy. */
  policy(tenant: string): TenantPolicy {
    const policy = this.#policies.get(tenant);
    if (policy === undefined) {
      throw new AuthorityError('unknown_tenant', `no tenant named ${tenant}`);
    }
    return policy;
  }

  /**
   * Creates a tenant with its first policy. Who may create tenants is the
   * host's decision (sign-up, provisioning), so this takes no proof.
   */
  createTenant(tenant: string, body: PolicyBody): Promise<TenantPolicy> {
    assertTenant(tenant);
    const canonical = canonicalPolicyBody(body);
    return this.#lock(tenant, async () => {
      const policy: TenantPolicy = deepFreeze({
        tenant,
        version: 0,
        ...canonical,
        changedBy: null,
        changedAt: this.#now(),
      });
      if (
        this.#policies.has(tenant) ||
        !(await this.#create(policyKey(tenant, 0), policy))
      ) {
        throw new AuthorityError('tenant_exists', `${tenant} already exists`);
      }
      this.#policies.set(tenant, policy);
      await this.#audit({
        tenant,
        event: 'tenant.create',
        outcome: 'allow',
        detail: `admins ${canonical.admins.join(', ')}`,
      });
      return policy;
    });
  }

  /**
   * Replaces a tenant's policy. The change names the version it was written
   * against; if another change landed first, this one fails with `conflict`
   * and the admin re-reads and decides again. Every outstanding credential is
   * held to the new policy from the moment this resolves.
   */
  changePolicy(change: PolicyChange, proof: Proof): Promise<TenantPolicy> {
    this.#assertService(change.service);
    const body = policyChangeBody(change);
    assertDid('admin', change.admin);
    checkProofSignature(change.admin, POLICY_DOMAIN, body, proof);
    return this.#lock(change.tenant, async () => {
      const current = this.policy(change.tenant);
      this.#assertKnown(current, change.admin);
      return this.#audited(
        {
          tenant: change.tenant,
          event: 'policy.change',
          actor: change.admin,
        },
        async () => {
          await this.#consumeProof(change.admin, proof);
          if (!current.admins.includes(change.admin)) {
            throw new AuthorityError(
              'not_an_admin',
              `${change.admin} does not administer ${change.tenant}`
            );
          }
          if (change.expectedVersion !== current.version) {
            throw new AuthorityError(
              'conflict',
              `policy is at version ${current.version}, not ${change.expectedVersion}`
            );
          }
          const next: TenantPolicy = deepFreeze({
            tenant: change.tenant,
            version: current.version + 1,
            ...canonicalPolicyBody(change.policy),
            changedBy: change.admin,
            changedAt: this.#now(),
          });
          if (
            !(await this.#create(policyKey(change.tenant, next.version), next))
          ) {
            throw new AuthorityError(
              'conflict',
              `another change already wrote policy version ${next.version}`
            );
          }
          this.#policies.set(change.tenant, next);
          return next;
        },
        (next) => `version ${next.version}`
      );
    });
  }

  /**
   * Issues a credential. The principal must be a policy member and sign the
   * request. It may ask for itself, with its own kind, or for an agent key it
   * runs. Either way the grants must fit inside the principal's policy grants,
   * and the lifetime inside the subject kind's ceiling.
   */
  async issue(request: IssueRequest, proof: Proof): Promise<Issued> {
    this.#assertService(request.service);
    assertTenant(request.tenant);
    assertDid('principal', request.principal);
    assertDid('subject', request.subject);
    assertKind(request.kind);
    const grants = canonicalGrants(request.grants);
    checkProofSignature(
      request.principal,
      ISSUE_DOMAIN,
      issueBody(request),
      proof
    );
    this.#assertKnown(this.policy(request.tenant), request.principal);
    return this.#audited(
      {
        tenant: request.tenant,
        event: 'credential.issue',
        actor: request.principal,
        principal: request.principal,
        subject: request.subject,
        kind: request.kind,
      },
      async () => {
        await this.#consumeProof(request.principal, proof);
        const policy = this.policy(request.tenant);
        const member = memberOf(policy, request.principal);
        if (member === undefined) {
          throw new AuthorityError(
            'not_a_member',
            `${request.principal} holds nothing in ${request.tenant}`
          );
        }
        if (request.subject === request.principal) {
          if (request.kind !== member.kind) {
            throw new AuthorityError(
              'policy_denied',
              `${request.principal} is a ${member.kind}, not a ${request.kind}`
            );
          }
        } else if (request.kind !== 'agent') {
          throw new AuthorityError(
            'policy_denied',
            'a member can issue credentials for other keys only as agent sessions'
          );
        }
        if (grants.length === 0 || !grantsSubsume(member.grants, grants)) {
          throw new AuthorityError(
            'policy_denied',
            'the requested grants exceed what the policy gives the principal'
          );
        }
        const rule = this.#ttl[request.kind];
        const ttl = request.ttlMs ?? rule.defaultMs;
        if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > rule.maxMs) {
          throw new AuthorityError(
            'malformed',
            `a ${request.kind} credential lives at most ${rule.maxMs} ms`
          );
        }
        const now = this.#now();
        const claims: CredentialClaims = {
          v: 1,
          id: randomId(),
          issuer: this.did,
          tenant: request.tenant,
          principal: request.principal,
          subject: request.subject,
          kind: request.kind,
          grants,
          issuedAt: now,
          expiresAt: now + ttl,
          policyVersion: policy.version,
        };
        return { token: await encodeCredential(claims, this.#signer), claims };
      },
      (issued) => `credential ${issued.claims.id}`,
      (issued) => ({ credential: issued.claims.id })
    );
  }

  /**
   * Revokes one credential, or every credential issued so far to or through a
   * DID. Admins may revoke anything in the tenant. A credential's principal or
   * holder may revoke that credential, and a member may revoke its own DID.
   * To stop new credentials too, remove the member from the policy.
   */
  revoke(request: RevokeRequest, proof: Proof): Promise<void> {
    this.#assertService(request.service);
    assertTenant(request.tenant);
    assertDid('actor', request.actor);
    checkProofSignature(
      request.actor,
      REVOKE_DOMAIN,
      revokeBody(request),
      proof
    );
    const claims =
      'credential' in request.target
        ? decodeCredential(request.target.credential, this.did)
        : undefined;
    const holds =
      claims !== undefined &&
      (request.actor === claims.principal || request.actor === claims.subject);
    return this.#lock(request.tenant, async () => {
      const policy = this.policy(request.tenant);
      const isAdmin = policy.admins.includes(request.actor);
      if (!holds) this.#assertKnown(policy, request.actor);
      await this.#audited(
        {
          tenant: request.tenant,
          event: 'credential.revoke',
          actor: request.actor,
        },
        async () => {
          await this.#consumeProof(request.actor, proof);
          const at = this.#now();
          if (claims !== undefined) {
            if (claims.tenant !== request.tenant) {
              throw new AuthorityError(
                'wrong_tenant',
                'the credential belongs to another tenant'
              );
            }
            if (!isAdmin && !holds) {
              throw new AuthorityError(
                'not_an_admin',
                `${request.actor} may not revoke this credential`
              );
            }
            this.#revokedCredentials.add(claims.id);
            await this.#backend.put(
              `${REVOCATION_PREFIX}${request.tenant}/credential/${claims.id}`,
              encodeRecord({
                tenant: request.tenant,
                credential: claims.id,
                at,
                by: request.actor,
              })
            );
            return `credential ${claims.id}`;
          }
          const { did } = request.target as { readonly did: string };
          assertDid('revoked did', did);
          if (!isAdmin && request.actor !== did) {
            throw new AuthorityError(
              'not_an_admin',
              `${request.actor} may not revoke ${did}`
            );
          }
          this.#noteDidRevocation(request.tenant, did, at);
          await this.#backend.put(
            `${REVOCATION_PREFIX}${request.tenant}/did/${nameKey(did)}/${pad(at, 15)}-${randomId()}`,
            encodeRecord({ tenant: request.tenant, did, at, by: request.actor })
          );
          return `every credential to or through ${did}`;
        },
        (detail) => detail
      );
    });
  }

  // Throws unless the request is for this service. Signed requests name the
  // service, so one made for another deployment cannot be replayed here.
  #assertService(service: string): void {
    if (service !== this.did) {
      throw new AuthorityError(
        'wrong_service',
        `the request is for ${String(service)}, not ${this.did}`
      );
    }
  }

  // Throws unless `did` is an admin or member of the tenant. A key the tenant
  // does not know is refused here, before it spends a nonce or writes to the
  // tenant's audit, so strangers cannot fill either. The host's request log
  // and rate limits cover them.
  #assertKnown(policy: TenantPolicy, did: string): void {
    if (!policy.admins.includes(did) && memberOf(policy, did) === undefined) {
      throw new AuthorityError(
        'not_a_member',
        `${did} holds nothing in ${policy.tenant}`
      );
    }
  }

  #noteDidRevocation(tenant: string, did: string, at: number): void {
    const key = `${tenant}\n${did}`;
    this.#revokedDids.set(key, Math.max(at, this.#revokedDids.get(key) ?? 0));
  }

  /**
   * Authorizes one use of a credential. The token must be this service's, the
   * proof must be the holder's signature over this exact action with a fresh
   * timestamp and an unused nonce, and the action must fit both the
   * credential's grants and the principal's grants in the current policy.
   *
   * Once the token proves to be this service's, every refusal is audited in
   * its tenant, including a bad proof or a malformed action. A token that is
   * not this service's names no tenant worth trusting, so it is refused
   * without an audit record.
   */
  async authorize(
    token: string,
    action: Action,
    proof: Proof
  ): Promise<Authorization> {
    const claims = decodeCredential(token, this.did);
    let canonical: Action | undefined;
    return this.#audited(
      () => ({
        tenant: claims.tenant,
        event: 'authorize',
        ...this.#who(claims),
        ...(canonical === undefined
          ? {}
          : {
              scope: canonical.scope,
              repo: canonical.repo,
              paths: canonical.paths,
            }),
      }),
      async () => {
        const checked = canonicalAction(action);
        canonical = checked;
        if (checked.tenant !== claims.tenant) {
          throw new AuthorityError(
            'wrong_tenant',
            `the credential is for ${claims.tenant}, not ${checked.tenant}`
          );
        }
        checkProofSignature(
          claims.subject,
          ACTION_DOMAIN,
          actionBody(token, checked),
          proof
        );
        this.#validate(claims, checked);
        await this.#consumeProof(claims.subject, proof);
        // The policy may have changed while the nonce was consumed.
        const policyVersion = this.#validate(claims, checked);
        const authorization = new Authorization(
          claims,
          checked,
          policyVersion,
          null
        );
        genuine.set(authorization, {
          authority: this,
          claims,
          token,
          action: checked,
        });
        return authorization;
      },
      undefined,
      undefined,
      'deny-only'
    );
  }

  /**
   * Throws unless `authorization` still holds right now: the credential is
   * live and unrevoked and the current policy still grants the action. Gates
   * call this when they act; hosts call it before each subscription event.
   */
  check(authorization: Authorization): void {
    const internals = internalsOf(authorization);
    if (internals.authority !== this) {
      throw new AuthorityError(
        'bad_credential',
        'the authorization came from another authority'
      );
    }
    this.#validate(internals.claims, internals.action);
  }

  // Throws unless the credential is live, unrevoked and covers the action in
  // both its own grants and the current policy. Returns the policy version.
  #validate(claims: CredentialClaims, action: Action): number {
    const policy = this.policy(claims.tenant);
    const now = this.#now();
    if (claims.issuedAt > now + this.#skew) {
      throw new AuthorityError(
        'not_yet_valid',
        'the credential is from the future'
      );
    }
    if (now >= claims.expiresAt) {
      throw new AuthorityError('expired', 'the credential has expired');
    }
    if (this.#isRevoked(claims)) {
      throw new AuthorityError('revoked', 'the credential has been revoked');
    }
    for (const pattern of action.paths) {
      if (!grantsCover(claims.grants, action.repo, action.scope, pattern)) {
        throw new AuthorityError(
          'scope_denied',
          `the credential does not grant ${action.scope} on ${action.repo}:${pattern}`
        );
      }
    }
    const member = memberOf(policy, claims.principal);
    for (const pattern of action.paths) {
      if (
        member === undefined ||
        !grantsCover(member.grants, action.repo, action.scope, pattern)
      ) {
        throw new AuthorityError(
          'policy_denied',
          `policy version ${policy.version} does not grant ${action.scope} on ${action.repo}:${pattern} to ${claims.principal}`
        );
      }
    }
    return policy.version;
  }

  #isRevoked(claims: CredentialClaims): boolean {
    if (this.#revokedCredentials.has(claims.id)) return true;
    for (const did of [claims.subject, claims.principal]) {
      const at = this.#revokedDids.get(`${claims.tenant}\n${did}`);
      if (at !== undefined && at >= claims.issuedAt) return true;
    }
    return false;
  }

  // Throws unless the proof's timestamp is inside the skew window and its
  // nonce has never been used by `did`, consuming it durably.
  async #consumeProof(did: string, proof: Proof): Promise<void> {
    const now = this.#now();
    if (Math.abs(now - proof.timestamp) > this.#skew) {
      throw new AuthorityError(
        'stale_proof',
        'the proof timestamp is outside the allowed window'
      );
    }
    const result = await this.#backend.consumeNonce({
      key: digest(
        'thaddeus.authority.nonce.v1',
        JSON.stringify([did, proof.nonce])
      ),
      expiresAt: proof.timestamp + this.#skew,
      now,
      capacity: this.#capacity,
    });
    if (result.status === 'replayed') {
      throw new AuthorityError('replayed', 'this proof was already used');
    }
    if (result.status === 'capacity') {
      throw new AuthorityError(
        'replay_capacity',
        'too many recent requests; retry later'
      );
    }
  }

  /**
   * Turns an authorization into a ticket a queue can hold. The ticket carries
   * the credential, so redeeming it later re-checks expiry, revocation and the
   * policy of that later moment, and it can be redeemed once.
   */
  async queue(authorization: Authorization): Promise<string> {
    const { claims, token, action } = internalsOf(authorization);
    this.check(authorization);
    const id = randomId();
    const ticket = await encodeTicket(
      {
        v: 1,
        id,
        credential: token,
        scope: action.scope,
        repo: action.repo,
        paths: action.paths,
        queuedAt: this.#now(),
      },
      this.#signer
    );
    await this.#audit({
      tenant: claims.tenant,
      event: 'ticket.queue',
      outcome: 'allow',
      ...this.#who(claims),
      scope: action.scope,
      repo: action.repo,
      paths: action.paths,
      detail: `ticket ${id}`,
    });
    return ticket;
  }

  /**
   * Redeems a queued ticket when its work starts. Refused if the credential
   * expired or was revoked while the work waited, if the policy no longer
   * grants it, or if the ticket was already redeemed, including before a
   * restart.
   */
  async redeem(ticket: string): Promise<Authorization> {
    const claims = decodeTicket(ticket, this.did);
    const credential = decodeCredential(claims.credential, this.did);
    assertScope(claims.scope);
    const action = canonicalAction({
      scope: claims.scope,
      tenant: credential.tenant,
      repo: claims.repo,
      paths: claims.paths,
    });
    return this.#lock(credential.tenant, () =>
      this.#audited(
        {
          tenant: credential.tenant,
          event: 'ticket.redeem',
          ...this.#who(credential),
          scope: action.scope,
          repo: action.repo,
          paths: action.paths,
        },
        async () => {
          const policyVersion = this.#validate(credential, action);
          const fresh = await this.#create(
            `authority/ticket/${credential.tenant}/${claims.id}`,
            { tenant: credential.tenant, ticket: claims.id, at: this.#now() }
          );
          if (!fresh) {
            throw new AuthorityError(
              'ticket_used',
              `ticket ${claims.id} was already redeemed`
            );
          }
          const authorization = new Authorization(
            credential,
            action,
            policyVersion,
            claims.id
          );
          genuine.set(authorization, {
            authority: this,
            claims: credential,
            token: claims.credential,
            action,
          });
          return authorization;
        },
        () => `ticket ${claims.id}`
      )
    );
  }

  /**
   * The newest service head record for a view, or null before the first.
   * The record is frozen.
   */
  async head(
    tenant: string,
    repo: string,
    view: string
  ): Promise<ServiceHeadRecord | null> {
    assertTenant(tenant);
    assertName('repo', repo);
    assertName('view', view);
    const prefix = headPrefix(tenant, repo, view);
    const cached = this.#heads.get(prefix);
    if (cached !== undefined) return cached;
    const keys = await this.#backend.list(prefix);
    const newest = [...keys].sort(byCodeUnit).at(-1);
    const record =
      newest === undefined
        ? null
        : ((await this.#read<ServiceHeadRecord>(newest)) ?? null);
    if (record !== null) {
      verifyHeadRecord(record, this.did);
      // The signature covers the content, not where it is stored, so a
      // genuine record copied under another view's key must not pass as
      // that view's head.
      if (
        record.tenant !== tenant ||
        record.repo !== repo ||
        record.view !== view ||
        `${prefix}${pad(record.version, 12)}` !== newest
      ) {
        throw new AuthorityError(
          'invalid_claim',
          'the head record is stored under another view or version'
        );
      }
      deepFreeze(record);
    }
    // An advancement may have cached a newer record while this one loaded.
    if (!this.#heads.has(prefix)) this.#heads.set(prefix, record);
    return this.#heads.get(prefix) ?? null;
  }

  /**
   * Advances a view's shared history under an `integrate` authorization. The
   * policy check and the version check happen inside the tenant's lock, so a
   * policy change or revocation either lands first and refuses this, or lands
   * after a record that names the policy version it was authorized under.
   * Every changed path must be inside the authorization, and the record names
   * them. The record says who requested it; only `actorClaims` are signatures.
   */
  advance(
    authorization: Authorization,
    input: AdvanceInput
  ): Promise<ServiceHeadRecord> {
    const { claims, action } = internalsOf(authorization);
    if (action.scope !== 'integrate') {
      throw new AuthorityError(
        'scope_denied',
        'advancing shared history needs an integrate authorization'
      );
    }
    assertName('view', input.view);
    assertName('revision', input.revision);
    if (
      input.expectedVersion !== null &&
      (!Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 0)
    ) {
      throw new AuthorityError(
        'malformed',
        'expectedVersion must be null or a version number'
      );
    }
    if (!Array.isArray(input.changedPaths)) {
      throw new AuthorityError(
        'malformed',
        'changedPaths must list the paths the revision changes'
      );
    }
    for (const path of input.changedPaths) assertPath(path);
    const changed = [...new Set(input.changedPaths)].sort(byCodeUnit);
    const { tenant } = claims;
    const { repo } = action;
    return this.#lock(tenant, () =>
      this.#audited(
        {
          tenant,
          event: 'history.advance',
          ...this.#who(claims),
          scope: 'integrate',
          repo,
          paths: changed,
        },
        async () => {
          for (const path of changed) {
            if (!reaches(action.paths, path)) {
              throw new AuthorityError(
                'scope_denied',
                `${path} changed but is outside the authorized paths`
              );
            }
          }
          this.check(authorization);
          const tip = await this.head(tenant, repo, input.view);
          const current = tip?.version ?? null;
          if (input.expectedVersion !== current) {
            throw new AuthorityError(
              'stale_head',
              `${input.view} is at version ${current ?? 'none'}, not ${input.expectedVersion ?? 'none'}`
            );
          }
          const content = {
            tenant,
            repo,
            view: input.view,
            version: current === null ? 0 : current + 1,
            previous: tip?.id ?? null,
            revision: input.revision,
            paths: changed,
          };
          const given = [...(input.actorClaims ?? [])];
          for (const claim of given) {
            if (!verifyActorClaim(content, claim)) {
              throw new AuthorityError(
                'invalid_claim',
                'an actor claim does not sign this exact advancement'
              );
            }
          }
          // Copied, so freezing the record leaves the caller's objects alone.
          const actorClaims = given.map(({ did, signature }) => ({
            did,
            signature,
          }));
          const unsigned = {
            v: 1 as const,
            ...content,
            service: this.did,
            at: this.#now(),
            policyVersion: this.policy(tenant).version,
            requestedBy: {
              principal: claims.principal,
              subject: claims.subject,
              kind: claims.kind,
              credential: claims.id,
            },
            actorClaims,
          };
          const signature = await this.#signer.sign(headBytes(unsigned));
          const record: ServiceHeadRecord = deepFreeze({
            ...unsigned,
            id: headId(unsigned),
            signature: base64url(signature),
          });
          const prefix = headPrefix(tenant, repo, input.view);
          if (
            !(await this.#create(`${prefix}${pad(record.version, 12)}`, record))
          ) {
            this.#heads.delete(prefix);
            throw new AuthorityError(
              'stale_head',
              `another advancement already wrote version ${record.version}`
            );
          }
          this.#heads.set(prefix, record);
          return record;
        },
        (record) =>
          `${record.view} version ${record.version} at ${record.revision}`
      )
    );
  }

  /** Every audit record for a tenant, oldest first. */
  async audit(tenant: string): Promise<AuditRecord[]> {
    assertTenant(tenant);
    const keys = [
      ...(await this.#backend.list(`authority/audit/${tenant}/`)),
    ].sort(byCodeUnit);
    const records: AuditRecord[] = [];
    for (const key of keys) {
      const record = await this.#read<AuditRecord>(key);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  async #audit(record: Omit<AuditRecord, 'id' | 'at'>): Promise<void> {
    const at = this.#now();
    const seq = this.#auditSeq++;
    const id = `${pad(at, 15)}-${this.#instance}-${pad(seq, 12)}`;
    const full: AuditRecord = { id, at, ...record };
    await this.#backend.put(
      `authority/audit/${record.tenant}/${id}`,
      encodeRecord(full)
    );
  }

  // Runs `work` and audits its outcome. Refusals are always recorded; a
  // success is recorded unless `mode` is 'deny-only'. `base` may be a
  // function when `work` learns some of the record's fields as it runs.
  async #audited<T>(
    base: AuditBase | (() => AuditBase),
    work: () => Promise<T>,
    detail?: (value: T) => string,
    extra?: (value: T) => Partial<AuditRecord>,
    mode: 'all' | 'deny-only' = 'all'
  ): Promise<T> {
    const describe = typeof base === 'function' ? base : () => base;
    let value: T;
    try {
      value = await work();
    } catch (error) {
      if (error instanceof AuthorityError) {
        await this.#audit({
          ...describe(),
          outcome: 'deny',
          code: error.code,
          detail: error.message,
        });
      }
      throw error;
    }
    if (mode === 'all') {
      await this.#audit({
        ...describe(),
        ...extra?.(value),
        outcome: 'allow',
        ...(detail === undefined ? {} : { detail: detail(value) }),
      });
    }
    return value;
  }

  #who(claims: CredentialClaims): Partial<AuditRecord> {
    return {
      actor: claims.subject,
      principal: claims.principal,
      subject: claims.subject,
      kind: claims.kind,
      credential: claims.id,
    };
  }

  // Creates `key` only if it is absent, so concurrent writers of a versioned
  // record cannot both succeed. The constructor checked putIfAbsent exists.
  #create(key: string, value: unknown): Promise<boolean> {
    return (
      this.#backend.putIfAbsent?.(key, encodeRecord(value)) ??
      Promise.resolve(false)
    );
  }
}
