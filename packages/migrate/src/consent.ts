import { bytesToHex } from '@noble/hashes/utils';
import { type Identity, PublicIdentity } from '@thaddeus.run/identity';

import {
  base64url,
  byCodeUnit,
  decodeUtf8,
  fromBase64url,
  isRecord,
  utf8,
} from './codec';
import { MigrationError } from './errors';

export const CONSENT_DOMAIN = 'thaddeus.migrate.consent.v1';
const PREFIX = 'thm1';
const HOUR = 60 * 60 * 1000;
export const DEFAULT_CONSENT_MS: number = 24 * HOUR;
export const MAX_CONSENT_MS: number = 7 * 24 * HOUR;

// What the owner agrees to: its own client decrypts the content with its own
// keys and sends the plaintext to the named service. No key leaves the
// owner's machine, so there is no other transfer mode to choose.
export const TRANSFER = 'owner-decrypts' as const;

/** One source view the owner pins: its signed version and every revision. */
export interface PinnedView {
  readonly view: string;
  readonly version: number;
  // The id of the owner-signed head record at `version`.
  readonly head: string;
  // The revision id at each version 0..version, as the owner's client
  // reconstructed it from its own decrypted copy.
  readonly revisions: readonly string[];
}

export interface ConsentSource {
  // The keyless server the repository is read from, as the owner named it.
  readonly server: string;
  readonly repo: string;
  // The DID that signs the repository's head chains.
  readonly owner: string;
}

/**
 * The owner's signed authorization to migrate one repository into one
 * trusted service. It names the service, the target tenant and repository,
 * the exact source history and what is transferred, and it expires.
 */
export interface Consent {
  readonly v: 1;
  readonly id: string;
  readonly service: string;
  readonly tenant: string;
  readonly repo: string;
  readonly source: ConsentSource;
  readonly views: readonly PinnedView[];
  readonly transfer: typeof TRANSFER;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface ConsentInput {
  readonly service: string;
  readonly tenant: string;
  readonly repo: string;
  readonly source: { readonly server: string; readonly repo: string };
  readonly views: readonly PinnedView[];
  readonly now?: number;
  readonly lifetimeMs?: number;
}

const ID = /^[0-9a-f]{64}$/;
const CONSENT_ID = /^[0-9a-f]{32}$/;
const TENANT = /^[a-z0-9][a-z0-9-]{0,62}$/;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function bad(message: string): never {
  throw new MigrationError('invalid_consent', message);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  const have = Object.keys(value).sort(byCodeUnit);
  const want = [...keys].sort(byCodeUnit);
  if (have.length !== want.length || have.some((k, i) => k !== want[i])) {
    bad(`expected exactly the fields ${want.join(', ')}`);
  }
}

function name(what: string, value: unknown, max = 256): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    CONTROL.test(value)
  ) {
    bad(`${what} must be 1-${max} characters with no control characters`);
  }
  return value;
}

function did(what: string, value: unknown): string {
  if (typeof value !== 'string') bad(`${what} must be a did:key`);
  try {
    PublicIdentity.fromDid(value);
  } catch {
    bad(`${what} must be a did:key`);
  }
  return value;
}

function time(what: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    bad(`${what} must be a millisecond timestamp`);
  }
  return value as number;
}

// Checks every field and refuses unknown ones, so a consent means exactly
// one thing to every reader.
function checkConsent(value: unknown): Consent {
  if (!isRecord(value)) bad('a consent is an object');
  exactKeys(value, [
    'v',
    'id',
    'service',
    'tenant',
    'repo',
    'source',
    'views',
    'transfer',
    'issuedAt',
    'expiresAt',
  ]);
  if (value.v !== 1) {
    throw new MigrationError(
      'unsupported_format',
      `consent version ${String(value.v)} is not supported`
    );
  }
  if (typeof value.id !== 'string' || !CONSENT_ID.test(value.id)) {
    bad('id must be 32 lowercase hex characters');
  }
  did('service', value.service);
  if (typeof value.tenant !== 'string' || !TENANT.test(value.tenant)) {
    bad('tenant must be a lowercase slug');
  }
  name('repo', value.repo);
  const source = value.source;
  if (!isRecord(source)) bad('source is an object');
  exactKeys(source, ['server', 'repo', 'owner']);
  name('source.server', source.server, 2048);
  name('source.repo', source.repo);
  did('source.owner', source.owner);
  if (!Array.isArray(value.views) || value.views.length === 0) {
    bad('views must name at least one source view');
  }
  let prior: string | undefined;
  for (const view of value.views as unknown[]) {
    if (!isRecord(view)) bad('each view is an object');
    exactKeys(view, ['view', 'version', 'head', 'revisions']);
    const label = name('view', view.view);
    if (prior !== undefined && byCodeUnit(prior, label) >= 0) {
      bad('views must be sorted and unique');
    }
    prior = label;
    if (!Number.isSafeInteger(view.version) || (view.version as number) < 0) {
      bad('a view version is a non-negative integer');
    }
    if (typeof view.head !== 'string' || !ID.test(view.head)) {
      bad('a view head is a lowercase BLAKE3 id');
    }
    if (
      !Array.isArray(view.revisions) ||
      view.revisions.length !== (view.version as number) + 1 ||
      view.revisions.some((r) => typeof r !== 'string' || !ID.test(r))
    ) {
      bad('a view lists one revision id for each version 0..version');
    }
  }
  if (value.transfer !== TRANSFER) {
    bad(`transfer must be ${TRANSFER}`);
  }
  const issuedAt = time('issuedAt', value.issuedAt);
  const expiresAt = time('expiresAt', value.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_CONSENT_MS) {
    bad(`a consent lasts more than 0 and at most ${MAX_CONSENT_MS} ms`);
  }
  return value as unknown as Consent;
}

/**
 * Signs a consent as the repository owner. The owner signs the domain tag and
 * the exact payload text, so verifying never depends on re-serializing JSON.
 */
export function signConsent(owner: Identity, input: ConsentInput): string {
  const issuedAt = input.now ?? Date.now();
  const body: Consent = {
    v: 1,
    id: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
    service: input.service,
    tenant: input.tenant,
    repo: input.repo,
    source: {
      server: input.source.server,
      repo: input.source.repo,
      owner: owner.did,
    },
    views: [...input.views]
      .map((v) => ({
        view: v.view,
        version: v.version,
        head: v.head,
        revisions: [...v.revisions],
      }))
      .sort((a, b) => byCodeUnit(a.view, b.view)),
    transfer: TRANSFER,
    issuedAt,
    expiresAt: issuedAt + (input.lifetimeMs ?? DEFAULT_CONSENT_MS),
  };
  checkConsent(body);
  const payload = JSON.stringify(body);
  const signature = owner.sign(utf8(`${CONSENT_DOMAIN}\n${payload}`));
  return `${PREFIX}.${base64url(utf8(payload))}.${base64url(signature)}`;
}

/**
 * Decodes a consent token and verifies that the source owner it names signed
 * it. Whether that DID really owns the source is checked against the signed
 * head chains, by the migrator.
 */
export function decodeConsent(token: string): Consent {
  if (typeof token !== 'string') bad('a consent token is a string');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    bad(`a consent token is ${PREFIX}.<payload>.<signature>`);
  }
  const payload = decodeUtf8(fromBase64url(parts[1] ?? ''));
  const signature = fromBase64url(parts[2] ?? '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    bad('the consent payload is not JSON');
  }
  const consent = checkConsent(parsed);
  let valid = false;
  try {
    valid = PublicIdentity.fromDid(consent.source.owner).verify(
      utf8(`${CONSENT_DOMAIN}\n${payload}`),
      signature
    );
  } catch {
    valid = false;
  }
  if (!valid) bad('the consent is not signed by the owner it names');
  return Object.freeze(consent);
}
