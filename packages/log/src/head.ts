import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { Identity, PublicIdentity } from '@thaddeus.run/identity';

import { type Op, verifyOp } from './op';

export interface HeadFields {
  readonly repo: string;
  readonly view: string;
  readonly version: number;
  readonly previous: string | null;
  readonly heads: readonly string[];
}

export interface HeadRecord extends HeadFields {
  readonly id: string;
  readonly owner: string;
  readonly sig: Uint8Array;
}

export interface HeadRecordWire extends Omit<HeadRecord, 'sig'> {
  readonly sig: string;
}

export type HeadRejectionCode =
  | 'malformed_record'
  | 'bad_signature'
  | 'bad_id'
  | 'wrong_repo'
  | 'wrong_view'
  | 'wrong_owner'
  | 'rollback'
  | 'fork'
  | 'gap'
  | 'broken_previous'
  | 'dropped_heads'
  | 'invalid_operation'
  | 'duplicate_operation'
  | 'missing_operation'
  | 'extra_operation';

export type HeadVerification =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: HeadRejectionCode;
      readonly message: string;
      readonly index?: number;
      readonly id?: string;
    };

export interface HeadChainOptions {
  readonly repo?: string;
  readonly view?: string;
  readonly owner?: string;
  readonly prefix?: readonly HeadRecord[];
}

const HEAD_DOMAIN = 'thaddeus.log.head.v1';
const ID_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;

const valid = (): HeadVerification => ({ ok: true });

function invalid(
  code: HeadRejectionCode,
  message: string,
  details?: { index?: number; id?: string }
): HeadVerification {
  return { ok: false, code, message, ...details };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Head records deliberately accept only one canonical representation. This
// prevents JSON coercions, alternate orderings, and duplicate heads from signing
// the same logical statement with different bytes.
function assertCanonical(fields: HeadFields, owner: string): void {
  if (typeof fields.repo !== 'string' || fields.repo.length === 0) {
    throw new TypeError('head.repo must be a non-empty string');
  }
  if (typeof fields.view !== 'string' || fields.view.length === 0) {
    throw new TypeError('head.view must be a non-empty string');
  }
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new TypeError('head.owner must be a non-empty string');
  }
  if (!Number.isSafeInteger(fields.version) || fields.version < 0) {
    throw new TypeError('head.version must be a non-negative safe integer');
  }
  if (!Array.isArray(fields.heads)) {
    throw new TypeError('head.heads must be an array');
  }
  let prior: string | undefined;
  for (const head of fields.heads) {
    if (typeof head !== 'string' || !ID_PATTERN.test(head)) {
      throw new TypeError('head.heads must contain lowercase BLAKE3 ids');
    }
    if (prior !== undefined && prior >= head) {
      throw new TypeError('head.heads must be sorted and unique');
    }
    prior = head;
  }
  if (fields.version === 0) {
    if (fields.previous !== null) {
      throw new TypeError('head genesis must have previous: null');
    }
  } else if (
    typeof fields.previous !== 'string' ||
    !ID_PATTERN.test(fields.previous)
  ) {
    throw new TypeError(
      'non-genesis head.previous must be a lowercase BLAKE3 id'
    );
  }
}

// The fixed tuple is the complete authority statement. Its bytes are used for
// both the BLAKE3 id and the owner's Ed25519 signature.
export function canonicalHead(fields: HeadFields, owner: string): Uint8Array {
  assertCanonical(fields, owner);
  return new TextEncoder().encode(
    JSON.stringify([
      HEAD_DOMAIN,
      fields.repo,
      fields.view,
      fields.version,
      fields.previous,
      [...fields.heads],
      owner,
    ])
  );
}

export function headId(fields: HeadFields, owner: string): string {
  return bytesToHex(blake3(canonicalHead(fields, owner)));
}

// Keep the authoritative signature private while preserving the portable
// Uint8Array API: every read receives a copy that cannot mutate the record.
function immutableHeadRecord(
  fields: HeadFields,
  id: string,
  owner: string,
  sig: Uint8Array
): HeadRecord {
  const signature = new Uint8Array(sig);
  const record = {
    ...fields,
    heads: Object.freeze([...fields.heads]),
    id,
    owner,
  } as HeadRecord;
  Object.defineProperty(record, 'sig', {
    enumerable: true,
    get: () => new Uint8Array(signature),
  });
  return Object.freeze(record);
}

export function signHead(fields: HeadFields, owner: Identity): HeadRecord {
  const bytes = canonicalHead(fields, owner.did);
  return immutableHeadRecord(
    fields,
    bytesToHex(blake3(bytes)),
    owner.did,
    owner.sign(bytes)
  );
}

// Cryptographic verification is result-based so callers can preserve stable
// protocol rejection codes without parsing exception text.
export function verifyHead(record: HeadRecord): HeadVerification {
  let bytes: Uint8Array;
  try {
    if (!isPlainRecord(record)) {
      return invalid('malformed_record', 'head record must be an object');
    }
    if (typeof record.id !== 'string' || !ID_PATTERN.test(record.id)) {
      return invalid(
        'malformed_record',
        'head.id must be lowercase hexadecimal'
      );
    }
    if (!(record.sig instanceof Uint8Array) || record.sig.length !== 64) {
      return invalid(
        'malformed_record',
        'head.sig must be a 64-byte signature'
      );
    }
    bytes = canonicalHead(record, record.owner);
  } catch (error) {
    return invalid(
      'malformed_record',
      error instanceof Error ? error.message : 'malformed head record'
    );
  }
  if (bytesToHex(blake3(bytes)) !== record.id) {
    return invalid('bad_id', 'head id does not match its canonical bytes');
  }
  try {
    if (!PublicIdentity.fromDid(record.owner).verify(bytes, record.sig)) {
      return invalid('bad_signature', 'head signature is invalid');
    }
  } catch {
    return invalid('bad_signature', 'head owner or signature is invalid');
  }
  return valid();
}

export function encodeHeadRecord(record: HeadRecord): HeadRecordWire {
  const verification = verifyHead(record);
  if (!verification.ok) {
    throw new TypeError(verification.message);
  }
  return {
    repo: record.repo,
    view: record.view,
    version: record.version,
    previous: record.previous,
    heads: [...record.heads],
    id: record.id,
    owner: record.owner,
    sig: bytesToHex(record.sig),
  };
}

// Decode is intentionally strict: the HTTP representation is a plain object
// with a lowercase hexadecimal signature, never the backend's Uint8Array codec.
export function decodeHeadRecord(wire: unknown): HeadRecord {
  if (!isPlainRecord(wire)) {
    throw new TypeError('head record must be an object');
  }
  const keys = Object.keys(wire).sort();
  const expected = [
    'heads',
    'id',
    'owner',
    'previous',
    'repo',
    'sig',
    'version',
    'view',
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, i) => key !== expected[i])
  ) {
    throw new TypeError('head record has missing or unknown fields');
  }
  if (typeof wire.sig !== 'string' || !SIGNATURE_PATTERN.test(wire.sig)) {
    throw new TypeError('head.sig must be lowercase hexadecimal');
  }
  const record = {
    repo: wire.repo,
    view: wire.view,
    version: wire.version,
    previous: wire.previous,
    heads: wire.heads,
    id: wire.id,
    owner: wire.owner,
    sig: hexToBytes(wire.sig),
  } as HeadRecord;
  const verification = verifyHead(record);
  if (!verification.ok) {
    throw new TypeError(verification.message);
  }
  return immutableHeadRecord(record, record.id, record.owner, record.sig);
}

function sameRecord(left: HeadRecord, right: HeadRecord): boolean {
  return left.id === right.id;
}

export function verifyHeadChain(
  chain: readonly HeadRecord[],
  options: HeadChainOptions = {}
): HeadVerification {
  if (!Array.isArray(chain) || chain.length === 0) {
    return invalid(
      'malformed_record',
      'head chain must contain a genesis record'
    );
  }
  const first = chain[0];
  if (first === undefined) {
    return invalid(
      'malformed_record',
      'head chain must contain a genesis record'
    );
  }
  const expectedRepo = options.repo ?? first.repo;
  const expectedView = options.view ?? first.view;
  const expectedOwner = options.owner ?? first.owner;
  let previous: HeadRecord | undefined;
  for (const [index, record] of chain.entries()) {
    const verified = verifyHead(record);
    if (!verified.ok) {
      return { ...verified, index };
    }
    if (record.repo !== expectedRepo) {
      return invalid(
        'wrong_repo',
        'head chain is bound to another repository',
        {
          index,
        }
      );
    }
    if (record.view !== expectedView) {
      return invalid('wrong_view', 'head chain is bound to another view', {
        index,
      });
    }
    if (record.owner !== expectedOwner) {
      return invalid('wrong_owner', 'head chain owner changed', { index });
    }
    if (record.version !== index) {
      return invalid('gap', 'head chain versions are not contiguous', {
        index,
      });
    }
    if (previous !== undefined) {
      if (record.previous !== previous.id) {
        return invalid('broken_previous', 'head previous link is broken', {
          index,
        });
      }
      const currentHeads = new Set(record.heads);
      const dropped = previous.heads.find((head) => !currentHeads.has(head));
      if (dropped !== undefined) {
        return invalid('dropped_heads', 'head update dropped a signed head', {
          index,
          id: dropped,
        });
      }
    }
    previous = record;
  }

  const prefix = options.prefix;
  if (prefix !== undefined) {
    if (chain.length < prefix.length) {
      return invalid(
        'rollback',
        'remote head chain is older than the local pin'
      );
    }
    for (const [index, pinned] of prefix.entries()) {
      const pinnedVerification = verifyHead(pinned);
      if (!pinnedVerification.ok) {
        return { ...pinnedVerification, index };
      }
      const remote = chain[index];
      if (remote === undefined) {
        return invalid(
          'rollback',
          'remote head chain is older than the local pin'
        );
      }
      if (!sameRecord(remote, pinned)) {
        return invalid(
          'fork',
          'remote head chain conflicts with the local pin',
          {
            index,
          }
        );
      }
    }
  }
  return valid();
}

// A pull bundle is accepted only when its operations are exactly the current
// signed frontier's ancestor closure: no omission, forgery, duplicate, or
// unrelated injection survives this check.
export function verifyHeadSnapshot(
  head: HeadRecord,
  operations: readonly Op[]
): HeadVerification {
  const verifiedHead = verifyHead(head);
  if (!verifiedHead.ok) {
    return verifiedHead;
  }
  if (!Array.isArray(operations)) {
    return invalid('invalid_operation', 'snapshot operations must be an array');
  }
  const byId = new Map<string, Op>();
  for (const [index, op] of operations.entries()) {
    if (
      op === null ||
      typeof op !== 'object' ||
      typeof op.id !== 'string' ||
      !verifyOp(op)
    ) {
      return invalid(
        'invalid_operation',
        'snapshot contains an invalid operation',
        {
          index,
          id:
            op !== null && typeof op === 'object' && typeof op.id === 'string'
              ? op.id
              : undefined,
        }
      );
    }
    if (byId.has(op.id)) {
      return invalid(
        'duplicate_operation',
        'snapshot contains a duplicate operation',
        {
          index,
          id: op.id,
        }
      );
    }
    byId.set(op.id, op);
  }

  const reachable = new Set<string>();
  const stack = [...head.heads];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || reachable.has(id)) {
      continue;
    }
    const op = byId.get(id);
    if (op === undefined) {
      return invalid(
        'missing_operation',
        'snapshot omits a signed head or ancestor',
        {
          id,
        }
      );
    }
    reachable.add(id);
    stack.push(...op.parents);
  }
  const extra = operations.find((op) => !reachable.has(op.id));
  if (extra !== undefined) {
    return invalid(
      'extra_operation',
      'snapshot injects an unrelated operation',
      {
        id: extra.id,
      }
    );
  }
  return valid();
}
