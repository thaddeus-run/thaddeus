import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { Identity, PublicIdentity } from '@thaddeus.run/identity';

export interface ReviewLimits {
  maxVetoesPerHour: number;
  maxActiveVetoes: number;
}
export const DEFAULT_REVIEW_LIMITS: Readonly<ReviewLimits> = Object.freeze({
  maxVetoesPerHour: 60,
  maxActiveVetoes: 256,
});
export class ReviewError extends Error {
  constructor(
    readonly code: string,
    message: string = code
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}
export interface ReviewerCapability extends ReviewLimits {
  readonly repo: string;
  readonly reviewer: string;
  readonly issuer: string;
  readonly paths: readonly string[];
  readonly at: string;
  readonly nonce: string;
  readonly sig: Uint8Array;
}
export interface ReviewRevocation {
  readonly repo: string;
  readonly grant: string;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
  readonly sig: Uint8Array;
}
export interface VetoWithdrawal {
  readonly repo: string;
  readonly veto: string;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
  readonly sig: Uint8Array;
}

/** Rejects ambiguous paths before scope matching can grant authority. */
export function safeReviewPath(path: string): boolean {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path
      .split('/')
      .every((p) => p !== '' && p !== '.' && p !== '..' && !p.includes('*'))
  );
}
export function reviewScopeMatches(pattern: string, path: string): boolean {
  return (
    safeReviewPath(path) &&
    (pattern === '**' ||
      (pattern.endsWith('/**')
        ? path.startsWith(pattern.slice(0, -2))
        : pattern === path))
  );
}
function strings(...values: unknown[]): void {
  if (values.some((v) => typeof v !== 'string' || v.length === 0))
    throw new TypeError('review fields must be nonempty strings');
}
export function assertReviewLimits(v: ReviewLimits): void {
  if (
    !Number.isSafeInteger(v.maxVetoesPerHour) ||
    v.maxVetoesPerHour < 1 ||
    !Number.isSafeInteger(v.maxActiveVetoes) ||
    v.maxActiveVetoes < 1
  )
    throw new TypeError('review limits must be positive safe integers');
}
function capabilityBytes(c: Omit<ReviewerCapability, 'sig'>): Uint8Array {
  strings(c.repo, c.reviewer, c.issuer, c.at, c.nonce);
  assertReviewLimits(c);
  PublicIdentity.fromDid(c.reviewer);
  PublicIdentity.fromDid(c.issuer);
  if (
    !Array.isArray(c.paths) ||
    c.paths.length === 0 ||
    !c.paths.every(
      (p) =>
        typeof p === 'string' &&
        (p === '**' || safeReviewPath(p.endsWith('/**') ? p.slice(0, -3) : p))
    )
  )
    throw new TypeError('invalid review scopes');
  return bytes([
    'thaddeus.review.capability.v1',
    c.repo,
    c.reviewer,
    c.issuer,
    c.paths,
    c.at,
    c.nonce,
    c.maxVetoesPerHour,
    c.maxActiveVetoes,
  ]);
}
function bytes(v: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(v));
}
function actionBytes(c: ReviewRevocation | VetoWithdrawal): Uint8Array {
  const target = 'grant' in c ? c.grant : c.veto;
  strings(c.repo, target, c.actor, c.reason, c.at);
  return bytes([
    'grant' in c
      ? 'thaddeus.review.revocation.v1'
      : 'thaddeus.review.withdrawal.v1',
    c.repo,
    target,
    c.actor,
    c.reason,
    c.at,
  ]);
}
export function signReviewerCapability(
  fields: Omit<ReviewerCapability, 'issuer' | 'sig'>,
  owner: Identity
): ReviewerCapability {
  const c = { ...fields, paths: [...fields.paths], issuer: owner.did };
  return { ...c, sig: owner.sign(capabilityBytes(c)) };
}
export function verifyReviewerCapability(c: ReviewerCapability): boolean {
  try {
    return PublicIdentity.fromDid(c.issuer).verify(capabilityBytes(c), c.sig);
  } catch {
    return false;
  }
}
export function reviewerCapabilityId(c: ReviewerCapability): string {
  return bytesToHex(
    blake3(bytes([Array.from(capabilityBytes(c)), bytesToHex(c.sig)]))
  );
}
export function signReviewRevocation(
  fields: Omit<ReviewRevocation, 'actor' | 'sig'>,
  signer: Identity
): ReviewRevocation {
  const c = { ...fields, actor: signer.did, sig: new Uint8Array() };
  return { ...c, sig: signer.sign(actionBytes(c)) };
}
export function verifyReviewRevocation(c: ReviewRevocation): boolean {
  try {
    return (
      !('veto' in c) &&
      PublicIdentity.fromDid(c.actor).verify(actionBytes(c), c.sig)
    );
  } catch {
    return false;
  }
}
export function signVetoWithdrawal(
  fields: Omit<VetoWithdrawal, 'actor' | 'sig'>,
  signer: Identity
): VetoWithdrawal {
  const c = { ...fields, actor: signer.did, sig: new Uint8Array() };
  return { ...c, sig: signer.sign(actionBytes(c)) };
}
export function verifyVetoWithdrawal(c: VetoWithdrawal): boolean {
  try {
    return (
      !('grant' in c) &&
      PublicIdentity.fromDid(c.actor).verify(actionBytes(c), c.sig)
    );
  } catch {
    return false;
  }
}
