// Every refusal names a stable code so a host can map it to a status, a
// message or a retry rule without parsing text.
export type AuthorityErrorCode =
  | 'malformed'
  | 'unknown_tenant'
  | 'tenant_exists'
  | 'not_a_member'
  | 'not_an_admin'
  | 'bad_credential'
  | 'wrong_tenant'
  | 'not_yet_valid'
  | 'expired'
  | 'revoked'
  | 'bad_proof'
  | 'stale_proof'
  | 'replayed'
  | 'replay_capacity'
  | 'scope_denied'
  | 'policy_denied'
  | 'conflict'
  | 'stale_head'
  | 'ticket_used'
  | 'bad_ticket'
  | 'invalid_claim'
  | 'decrypt_failed';

/** A refusal from the authority. `code` is stable; `message` is for people. */
export class AuthorityError extends Error {
  readonly code: AuthorityErrorCode;

  constructor(code: AuthorityErrorCode, message: string) {
    super(message);
    this.name = 'AuthorityError';
    this.code = code;
  }
}
