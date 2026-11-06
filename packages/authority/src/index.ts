export {
  Authority,
  Authorization,
  DEFAULT_TTL,
  PROOF_SKEW_MS,
} from './authority';
export type {
  AdvanceInput,
  AuditEvent,
  AuditRecord,
  AuthorityOptions,
  Issued,
  TtlRule,
} from './authority';
export { KeyCustody, LocalRootKey } from './custody';
export type {
  KeyCustodyOptions,
  RootKeyProvider,
  SealedContent,
} from './custody';
export { AuthorityError } from './errors';
export type { AuthorityErrorCode } from './errors';
export {
  describeAttribution,
  signActorClaim,
  verifyActorClaim,
  verifyHeadRecord,
} from './head';
export type {
  ActorClaim,
  Attribution,
  HeadContent,
  RequestedBy,
  ServiceHeadRecord,
} from './head';
export { canonicalPolicyBody, proveChangePolicy } from './policy';
export type {
  PolicyBody,
  PolicyChange,
  PolicyMember,
  TenantPolicy,
} from './policy';
export { proveAction, proveIssue, proveRevoke } from './proof';
export type {
  Action,
  HolderKey,
  IssueRequest,
  Proof,
  RevokeRequest,
  RevokeTarget,
} from './proof';
export { PRINCIPAL_KINDS, patternCovers, SCOPES } from './scope';
export type { Grant, PrincipalKind, Scope } from './scope';
export { decodeCredential } from './token';
export type { CredentialClaims, ServiceSigner } from './token';
