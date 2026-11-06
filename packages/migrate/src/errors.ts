// Every refusal names a stable code so a host can map it to a status, a
// message or a retry rule without parsing text.
export type MigrationErrorCode =
  | 'malformed'
  | 'unsupported_format'
  | 'invalid_consent'
  | 'wrong_service'
  | 'wrong_target'
  | 'not_owner'
  | 'scope_denied'
  | 'expired'
  | 'invalid_evidence'
  | 'not_in_evidence'
  | 'content_mismatch'
  | 'incomplete'
  | 'mismatch'
  | 'wrong_state'
  | 'conflict'
  | 'source_moved'
  | 'diverged';

/** A refusal from a migration step. `code` is stable; `message` is for people. */
export class MigrationError extends Error {
  readonly code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}
