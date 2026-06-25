import { type Identity, PublicIdentity } from '@thaddeus.run/identity';

// The signable grant: who is authorized, scoped to which paths, with what caps.
export interface DelegationFields {
  readonly agent: string; // did:key of the agent being authorized
  readonly paths: readonly string[]; // globs the agent may touch, e.g. ['src/**']
  readonly maxChanges: number; // cap on # of ops the agent may land (total)
  readonly maxSpend: number; // cap on caller-reported spend (abstract units)
}

// A signed delegation: the operator authorizes the agent to act for them. The
// operator did is derived from the signer, so it cannot be claimed unsigned.
export interface Delegation extends DelegationFields {
  readonly operator: string; // = operator.did
  readonly sig: Uint8Array; // operator's signature over the canonical core
}

// Domain tag prefixed into the signed tuple so a delegation signature can never
// be confused with an op / provenance / contribution signature.
const DELEGATION_DOMAIN = 'thaddeus.delegation.v1';

type DelegationCore = DelegationFields & { readonly operator: string };

// Reject non-canonical field values before they are signed. Mirrors op.ts /
// provenance.ts: bad input throws, so signDelegation fails fast and
// verifyDelegation (try/catch) renders such records false.
function assertCanonical(core: DelegationCore): void {
  for (const [name, value] of [
    ['operator', core.operator],
    ['agent', core.agent],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`delegation.${name} must be a non-empty string`);
    }
  }
  if (
    !Array.isArray(core.paths) ||
    core.paths.length === 0 ||
    core.paths.some((p) => typeof p !== 'string' || p.length === 0)
  ) {
    throw new TypeError(
      'delegation.paths must be a non-empty array of non-empty strings'
    );
  }
  if (
    typeof core.maxChanges !== 'number' ||
    !Number.isInteger(core.maxChanges) ||
    core.maxChanges < 0
  ) {
    throw new TypeError('delegation.maxChanges must be a non-negative integer');
  }
  if (
    typeof core.maxSpend !== 'number' ||
    !Number.isFinite(core.maxSpend) ||
    core.maxSpend < 0
  ) {
    throw new TypeError('delegation.maxSpend must be a finite number >= 0');
  }
}

// Deterministic bytes the operator's signature covers: the domain tag followed
// by the core fields in a fixed order. Throws on non-canonical input.
export function canonicalDelegation(core: DelegationCore): Uint8Array {
  assertCanonical(core);
  return new TextEncoder().encode(
    JSON.stringify([
      DELEGATION_DOMAIN,
      core.operator,
      core.agent,
      [...core.paths],
      core.maxChanges,
      core.maxSpend,
    ])
  );
}

// Build a signed delegation; the operator did is derived from the signer.
export function signDelegation(
  fields: DelegationFields,
  operator: Identity
): Delegation {
  const core: DelegationCore = { ...fields, operator: operator.did };
  return {
    ...fields,
    operator: operator.did,
    sig: operator.sign(canonicalDelegation(core)),
  };
}

// Verify the operator's signature over the canonical core. Fail-soft: a
// malformed did, wrong-length sig, or non-canonical field yields false.
export function verifyDelegation(d: Delegation): boolean {
  try {
    return PublicIdentity.fromDid(d.operator).verify(
      canonicalDelegation(d),
      d.sig
    );
  } catch {
    return false;
  }
}
