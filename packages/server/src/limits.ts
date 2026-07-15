export const DEFAULT_MAX_REQUEST_BODY_BYTES: number = 16 * 1024 * 1024;
export const DEFAULT_MAX_REPUTATION_ARCHIVE_BYTES: number = 4 * 1024 * 1024;
export const DEFAULT_MAX_REPUTATION_CONTRIBUTIONS: number = 4_096;
export const DEFAULT_MAX_FIELD_BYTES: number = 16 * 1024;
export const DEFAULT_PAGE_SIZE: number = 100;
export const DEFAULT_MAX_PAGE_SIZE: number = 1_000;
/** @deprecated Prefer DEFAULT_MAX_PAGE_SIZE for consistency with other defaults. */
export const MAX_PAGE_SIZE: number = DEFAULT_MAX_PAGE_SIZE;
export const DEFAULT_MAX_PAGE_RESPONSE_BYTES: number = 16 * 1024 * 1024;
export const DEFAULT_PAGINATION_CURSOR_CAPACITY: number = 1_000;
export const DEFAULT_PAGINATION_CURSOR_TTL_MS: number = 300_000;

export interface LimitConfig {
  readonly maxRequestBodyBytes?: number;
  readonly maxReputationArchiveBytes?: number;
  readonly maxReputationContributions?: number;
  readonly maxFieldBytes?: number;
  readonly defaultPageSize?: number;
  readonly maxPageSize?: number;
  readonly maxPageResponseBytes?: number;
  readonly paginationCursorCapacity?: number;
  readonly paginationCursorTtlMs?: number;
}

export interface ResolvedLimits {
  readonly maxRequestBodyBytes: number;
  readonly maxReputationArchiveBytes: number;
  readonly maxReputationContributions: number;
  readonly maxFieldBytes: number;
  readonly defaultPageSize: number;
  readonly maxPageSize: number;
  readonly maxPageResponseBytes: number;
  readonly paginationCursorCapacity: number;
  readonly paginationCursorTtlMs: number;
}

export type InputLimitCode =
  | 'archive_too_large'
  | 'contribution_limit_exceeded'
  | 'field_too_large';

/** A privacy-safe limit failure carrying only a stable code and configured cap. */
export class InputLimitError extends RangeError {
  readonly code: InputLimitCode;
  readonly limit: number;

  constructor(code: InputLimitCode, limit: number) {
    super(code);
    this.name = 'InputLimitError';
    this.code = code;
    this.limit = limit;
  }
}

const encoder = new TextEncoder();

/** Resolves every flat server limit and validates cross-limit relationships. */
export function resolveLimits(config: LimitConfig): ResolvedLimits {
  const limits: ResolvedLimits = {
    maxRequestBodyBytes: positiveInteger(
      'maxRequestBodyBytes',
      configuredOrDefault(
        config.maxRequestBodyBytes,
        DEFAULT_MAX_REQUEST_BODY_BYTES
      ),
      // Bun needs one sentinel byte above the application cap.
      Number.MAX_SAFE_INTEGER - 1
    ),
    maxReputationArchiveBytes: positiveInteger(
      'maxReputationArchiveBytes',
      configuredOrDefault(
        config.maxReputationArchiveBytes,
        DEFAULT_MAX_REPUTATION_ARCHIVE_BYTES
      )
    ),
    maxReputationContributions: positiveInteger(
      'maxReputationContributions',
      configuredOrDefault(
        config.maxReputationContributions,
        DEFAULT_MAX_REPUTATION_CONTRIBUTIONS
      )
    ),
    maxFieldBytes: positiveInteger(
      'maxFieldBytes',
      configuredOrDefault(config.maxFieldBytes, DEFAULT_MAX_FIELD_BYTES)
    ),
    defaultPageSize: positiveInteger(
      'defaultPageSize',
      configuredOrDefault(config.defaultPageSize, DEFAULT_PAGE_SIZE)
    ),
    maxPageSize: positiveInteger(
      'maxPageSize',
      configuredOrDefault(config.maxPageSize, MAX_PAGE_SIZE)
    ),
    maxPageResponseBytes: positiveInteger(
      'maxPageResponseBytes',
      configuredOrDefault(
        config.maxPageResponseBytes,
        DEFAULT_MAX_PAGE_RESPONSE_BYTES
      )
    ),
    paginationCursorCapacity: positiveInteger(
      'paginationCursorCapacity',
      configuredOrDefault(
        config.paginationCursorCapacity,
        DEFAULT_PAGINATION_CURSOR_CAPACITY
      )
    ),
    paginationCursorTtlMs: positiveInteger(
      'paginationCursorTtlMs',
      configuredOrDefault(
        config.paginationCursorTtlMs,
        DEFAULT_PAGINATION_CURSOR_TTL_MS
      )
    ),
  };
  relationship(
    limits.maxReputationArchiveBytes <= limits.maxRequestBodyBytes,
    'maxReputationArchiveBytes must not exceed maxRequestBodyBytes'
  );
  relationship(
    limits.maxFieldBytes <= limits.maxReputationArchiveBytes,
    'maxFieldBytes must not exceed maxReputationArchiveBytes'
  );
  relationship(
    limits.maxReputationArchiveBytes <= limits.maxPageResponseBytes,
    'maxReputationArchiveBytes must not exceed maxPageResponseBytes'
  );
  relationship(
    limits.defaultPageSize <= limits.maxPageSize,
    'defaultPageSize must not exceed maxPageSize'
  );
  return limits;
}

/** Defaults only omitted options so runtime null values still fail closed. */
function configuredOrDefault(
  value: number | undefined,
  defaultValue: number
): unknown {
  if (value === undefined) return defaultValue;
  return value;
}

function positiveInteger(
  name: string,
  value: unknown,
  maximum?: number
): number {
  if (typeof value !== 'number') {
    throw new TypeError(`${name} must be a number`);
  }
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function relationship(valid: boolean, message: string): void {
  if (!valid) throw new RangeError(message);
}

// Wire-only or binary/authentication values are governed by other limits.
const EXCLUDED_TEXT_KEYS = new Set([
  'archive',
  'caps',
  'capability',
  'claim',
  'cursor',
  'delegation',
  'host_sig',
  'nonce',
  'objects',
  'ops',
  'pending',
  'prov',
  'release',
  'signature',
  'sig',
  'subj_sig',
  'symop',
  'veto',
  'wrapped_key',
]);

/** Validates decoded domain strings recursively using UTF-8 byte length. */
export function validateLogicalText(
  value: unknown,
  maxBytes: number,
  key?: string
): void {
  if (typeof value === 'string') {
    if (
      !EXCLUDED_TEXT_KEYS.has(key ?? '') &&
      encoder.encode(value).length > maxBytes
    ) {
      throw new InputLimitError('field_too_large', maxBytes);
    }
    return;
  }
  if (value instanceof Uint8Array || value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) validateLogicalText(entry, maxBytes, key);
    return;
  }
  if (typeof value === 'object') {
    for (const [childKey, entry] of Object.entries(value)) {
      validateLogicalText(entry, maxBytes, childKey);
    }
  }
}

/** Maps an input-limit failure to its stable, privacy-safe response body. */
export function inputLimitBody(error: InputLimitError): {
  error: string;
  code: InputLimitCode;
  maxBytes?: number;
  maxContributions?: number;
} {
  if (error.code === 'contribution_limit_exceeded') {
    return {
      error: 'reputation contribution limit exceeded',
      code: error.code,
      maxContributions: error.limit,
    };
  }
  return {
    error:
      error.code === 'archive_too_large'
        ? 'reputation archive too large'
        : 'logical text field too large',
    code: error.code,
    maxBytes: error.limit,
  };
}
