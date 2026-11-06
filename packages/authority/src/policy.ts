import { assertDid, byCodeUnit } from './codec';
import { AuthorityError } from './errors';
import { type HolderKey, POLICY_DOMAIN, type Proof, proveBody } from './proof';
import {
  assertKind,
  assertTenant,
  canonicalGrants,
  type Grant,
  type PrincipalKind,
} from './scope';

// One identity's standing authority in a tenant. Credentials are cut from it
// and never exceed it, and every use is checked against the current version.
export interface PolicyMember {
  readonly subject: string;
  readonly kind: PrincipalKind;
  readonly grants: readonly Grant[];
}

// What a tenant admin edits: who administers the tenant and who holds what.
export interface PolicyBody {
  readonly admins: readonly string[];
  readonly members: readonly PolicyMember[];
}

// One version of a tenant's policy as the authority stores it. Versions start
// at 0 and each change names the version it replaces, so two admins editing
// at once cannot both win.
export interface TenantPolicy extends PolicyBody {
  readonly tenant: string;
  readonly version: number;
  readonly changedBy: string | null;
  readonly changedAt: number;
}

// `service` is the DID of the service asked, as in an issue request.
export interface PolicyChange {
  readonly service: string;
  readonly tenant: string;
  readonly admin: string;
  readonly expectedVersion: number;
  readonly policy: PolicyBody;
}

/** Validates a policy body and returns it in canonical order. */
export function canonicalPolicyBody(body: PolicyBody): PolicyBody {
  if (body === null || typeof body !== 'object') {
    throw new AuthorityError('malformed', 'a policy must be an object');
  }
  if (!Array.isArray(body.admins) || body.admins.length === 0) {
    throw new AuthorityError('malformed', 'a policy needs at least one admin');
  }
  for (const admin of body.admins) assertDid('admin', admin);
  if (!Array.isArray(body.members)) {
    throw new AuthorityError('malformed', 'policy members must be an array');
  }
  const seen = new Set<string>();
  const members = body.members.map((member): PolicyMember => {
    if (member === null || typeof member !== 'object') {
      throw new AuthorityError('malformed', 'each member must be an object');
    }
    assertDid('member subject', member.subject);
    assertKind(member.kind);
    if (seen.has(member.subject)) {
      throw new AuthorityError(
        'malformed',
        `${member.subject} appears twice in the policy`
      );
    }
    seen.add(member.subject);
    return {
      subject: member.subject,
      kind: member.kind,
      grants: canonicalGrants(member.grants),
    };
  });
  return {
    admins: [...new Set(body.admins)].sort(byCodeUnit),
    members: members.sort((a, b) => byCodeUnit(a.subject, b.subject)),
  };
}

export function policyChangeBody(change: PolicyChange): unknown {
  assertTenant(change.tenant);
  return [
    change.service,
    change.tenant,
    change.admin,
    change.expectedVersion,
    canonicalPolicyBody(change.policy),
  ];
}

/** An admin signs a policy change against the version it read. */
export function proveChangePolicy(
  admin: HolderKey,
  change: PolicyChange,
  options?: { readonly now?: number; readonly nonce?: string }
): Proof {
  return proveBody(admin, POLICY_DOMAIN, policyChangeBody(change), options);
}

/** The member entry for `subject`, or undefined when it holds nothing. */
export function memberOf(
  policy: TenantPolicy,
  subject: string
): PolicyMember | undefined {
  return policy.members.find((member) => member.subject === subject);
}
