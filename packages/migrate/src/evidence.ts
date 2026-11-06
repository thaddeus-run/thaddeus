import { type SymbolOp, verifySymbolOp } from '@thaddeus.run/graph';
import {
  decodeHeadRecord,
  encodeHeadRecord,
  type HeadRecord,
  type HeadRecordWire,
  type Op,
  verifyHeadChain,
  verifyHeadSnapshot,
} from '@thaddeus.run/log';
import { type Provenance, verifyProvenance } from '@thaddeus.run/provenance';
import {
  type ReviewEvent,
  verifyReviewerCapability,
  verifyReviewRevocation,
  verifyVeto,
  verifyVetoWithdrawal,
  type Veto,
} from '@thaddeus.run/review';
import {
  address,
  type Capability,
  type EncryptedObject,
  verifyCapability,
} from '@thaddeus.run/store';

import { byCodeUnit, isRecord, recordKey } from './codec';
import type { Consent } from './consent';
import { MigrationError } from './errors';
import { type Entry, historyOf, sortEntries, type Version } from './history';

/**
 * The original signed records of a keyless repository, exactly as its server
 * served them: the owner-signed head chains, the operations they reach, the
 * ciphertext and capabilities those operations name, and the signed meaning
 * around them. A migration keeps every one of them unchanged.
 */
export interface Evidence {
  readonly heads: readonly HeadRecord[];
  readonly ops: readonly Op[];
  readonly objects: readonly EncryptedObject[];
  readonly caps: readonly Capability[];
  readonly provenance: readonly Provenance[];
  readonly vetoes: readonly Veto[];
  readonly reviews: readonly ReviewEvent[];
  readonly symbolOps: readonly SymbolOp[];
}

export const EVIDENCE_KINDS = [
  'cap',
  'head',
  'object',
  'op',
  'provenance',
  'review',
  'symop',
  'veto',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** One evidence record as stored: kind, content key and the record itself. */
export interface EvidenceRecord {
  readonly kind: EvidenceKind;
  readonly key: string;
  readonly record: unknown;
}

/** One migrated source view: its signed chain and the tree at each version. */
export interface VerifiedView {
  readonly view: string;
  readonly chain: readonly HeadRecord[];
  readonly history: readonly Version[];
}

/** What a consent's evidence proves once every record has been checked. */
export interface VerifiedEvidence {
  readonly owner: string;
  readonly repo: string;
  readonly views: readonly VerifiedView[];
  // Every (path, content) pair any migrated version holds, sorted.
  readonly files: readonly Entry[];
}

// A repository path the trusted service can bind content to: relative,
// POSIX, with no empty, `.` or `..` segment and no wildcard. These are the
// rules `@thaddeus.run/authority` applies to every path it authorizes.
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
export function isServicePath(path: string): boolean {
  if (path.length === 0 || path.length > 4096 || CONTROL.test(path)) {
    return false;
  }
  if (path.startsWith('/') || path.includes('\\')) return false;
  return path
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes('*')
    );
}

function invalid(message: string): never {
  throw new MigrationError('invalid_evidence', message);
}

/** Splits evidence into keyed records, sorted by kind and key, without duplicates. */
export function evidenceRecords(evidence: Evidence): EvidenceRecord[] {
  const out = new Map<string, EvidenceRecord>();
  const add = (kind: EvidenceKind, key: string, record: unknown) => {
    out.set(`${kind}/${key}`, { kind, key, record });
  };
  for (const head of evidence.heads) {
    add('head', head.id, encodeHeadRecord(head));
  }
  for (const op of evidence.ops) add('op', op.id, op);
  for (const object of evidence.objects) add('object', object.id, object);
  for (const cap of evidence.caps) add('cap', recordKey('cap', cap), cap);
  for (const p of evidence.provenance) {
    add('provenance', recordKey('provenance', p), p);
  }
  for (const v of evidence.vetoes) add('veto', recordKey('veto', v), v);
  for (const r of evidence.reviews) add('review', recordKey('review', r), r);
  for (const s of evidence.symbolOps) add('symop', s.id, s);
  return [...out.entries()]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([, record]) => record);
}

/** Rebuilds evidence from stored records. Head records are re-verified. */
export function fromRecords(records: readonly EvidenceRecord[]): Evidence {
  const evidence = {
    heads: [] as HeadRecord[],
    ops: [] as Op[],
    objects: [] as EncryptedObject[],
    caps: [] as Capability[],
    provenance: [] as Provenance[],
    vetoes: [] as Veto[],
    reviews: [] as ReviewEvent[],
    symbolOps: [] as SymbolOp[],
  };
  for (const { kind, record } of records) {
    switch (kind) {
      case 'head':
        try {
          evidence.heads.push(decodeHeadRecord(record as HeadRecordWire));
        } catch (error) {
          invalid(
            `a stored head record does not verify: ${error instanceof Error ? error.message : 'malformed'}`
          );
        }
        break;
      case 'op':
        evidence.ops.push(record as Op);
        break;
      case 'object':
        evidence.objects.push(record as EncryptedObject);
        break;
      case 'cap':
        evidence.caps.push(record as Capability);
        break;
      case 'provenance':
        evidence.provenance.push(record as Provenance);
        break;
      case 'veto':
        evidence.vetoes.push(record as Veto);
        break;
      case 'review':
        evidence.reviews.push(record as ReviewEvent);
        break;
      case 'symop':
        evidence.symbolOps.push(record as SymbolOp);
        break;
      default:
        invalid(`unknown evidence kind ${String(kind)}`);
    }
  }
  return evidence;
}

function verifyReview(event: ReviewEvent): boolean {
  if (!isRecord(event)) return false;
  switch (event.kind) {
    case 'grant':
      return verifyReviewerCapability(event.capability);
    case 'revoke':
      return verifyReviewRevocation(event.revocation);
    case 'veto':
      return verifyVeto(event.veto);
    case 'withdraw':
      return verifyVetoWithdrawal(event.withdrawal);
    default:
      return false;
  }
}

// Walks a pinned head back to genesis through `previous`, oldest first.
function chainFor(
  pinned: string,
  heads: ReadonlyMap<string, HeadRecord>
): HeadRecord[] {
  const chain: HeadRecord[] = [];
  const seen = new Set<string>();
  let id: string | null = pinned;
  while (id !== null) {
    const record = heads.get(id);
    if (record === undefined) invalid(`head record ${id} is missing`);
    if (seen.has(id)) invalid('head records link in a cycle');
    seen.add(id);
    chain.unshift(record);
    id = record.previous;
  }
  return chain;
}

// Every op reachable from `heads`. A missing ancestor fails, because the
// owner signed a frontier whose whole closure must be present.
function closure(
  heads: readonly string[],
  ops: ReadonlyMap<string, Op>
): Set<string> {
  const seen = new Set<string>();
  const stack = [...heads];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    const op = ops.get(id);
    if (op === undefined) invalid(`operation ${id} is missing`);
    seen.add(id);
    stack.push(...op.parents);
  }
  return seen;
}

/**
 * Checks every record against the consent and against each other, then
 * reconstructs each pinned view's history. Refuses evidence that is not
 * exactly the source the owner pinned: a record that fails its signature, a
 * chain the consent's owner did not sign, a missing or extra operation,
 * ciphertext or a capability nothing references, or a history whose
 * revisions differ from the ones the owner signed in the consent.
 */
export function verifyEvidence(
  evidence: Evidence,
  consent: Consent
): VerifiedEvidence {
  const owner = consent.source.owner;
  const repo = consent.source.repo;
  const heads = new Map<string, HeadRecord>();
  for (const head of evidence.heads) heads.set(head.id, head);
  const ops = new Map<string, Op>();
  for (const op of evidence.ops) {
    if (!isRecord(op) || typeof op.id !== 'string') {
      invalid('an operation is malformed');
    }
    ops.set(op.id, op);
  }

  const usedHeads = new Set<string>();
  const usedOps = new Set<string>();
  const views: { view: string; chain: HeadRecord[] }[] = [];
  for (const pinned of consent.views) {
    const chain = chainFor(pinned.head, heads);
    const checked = verifyHeadChain(chain, {
      repo,
      view: pinned.view,
      owner,
    });
    if (!checked.ok) {
      if (checked.code === 'wrong_owner') {
        throw new MigrationError(
          'not_owner',
          `${pinned.view} is not signed by ${owner}, the owner the consent names`
        );
      }
      invalid(`${pinned.view}: ${checked.code}: ${checked.message}`);
    }
    const tip = chain.at(-1);
    if (tip === undefined || tip.version !== pinned.version) {
      invalid(`${pinned.view} is not at the pinned version ${pinned.version}`);
    }
    const reach = closure(tip.heads, ops);
    const snapshot = verifyHeadSnapshot(
      tip,
      [...reach].map((id) => ops.get(id) as Op)
    );
    if (!snapshot.ok) {
      invalid(`${pinned.view}: ${snapshot.code}: ${snapshot.message}`);
    }
    for (const record of chain) usedHeads.add(record.id);
    for (const id of reach) usedOps.add(id);
    views.push({ view: pinned.view, chain });
  }
  for (const id of heads.keys()) {
    if (!usedHeads.has(id))
      invalid(`head record ${id} is not on a pinned chain`);
  }
  for (const id of ops.keys()) {
    if (!usedOps.has(id)) {
      invalid(`operation ${id} is not reachable from a pinned head`);
    }
  }

  // Content each operation names must arrive with its ciphertext, so the
  // evidence still verifies every signature that mentions it.
  const payloads = new Set<string>();
  for (const op of ops.values()) {
    if (op.payload !== null) payloads.add(op.payload.plaintext_id);
  }
  const prompts = new Set<string>();
  for (const p of evidence.provenance) {
    if (!verifyProvenance(p)) invalid('a provenance claim does not verify');
    if (!ops.has(p.op)) {
      invalid(
        `a provenance claim names operation ${p.op}, which is not migrated`
      );
    }
    if (p.prompt !== null) prompts.add(p.prompt.plaintext_id);
  }
  const ciphertext = new Set<string>();
  for (const object of evidence.objects) {
    if (
      !isRecord(object) ||
      !(object.ciphertext instanceof Uint8Array) ||
      address(object.ciphertext) !== object.id
    ) {
      invalid('an encrypted object is not addressed by its ciphertext');
    }
    if (
      !payloads.has(object.plaintext_id) &&
      !prompts.has(object.plaintext_id)
    ) {
      invalid(`encrypted object ${object.id} is not referenced`);
    }
    if (ciphertext.has(object.plaintext_id)) {
      invalid(`two encrypted objects hold ${object.plaintext_id}`);
    }
    ciphertext.add(object.plaintext_id);
  }
  for (const pid of payloads) {
    if (!ciphertext.has(pid)) invalid(`the ciphertext for ${pid} is missing`);
  }
  for (const cap of evidence.caps) {
    if (!verifyCapability(cap)) invalid('a capability does not verify');
    if (!ciphertext.has(cap.object)) {
      invalid(`a capability names ${cap.object}, which is not migrated`);
    }
  }
  for (const veto of evidence.vetoes) {
    if (!verifyVeto(veto)) invalid('a veto does not verify');
  }
  for (const event of evidence.reviews) {
    if (!verifyReview(event)) invalid('a review event does not verify');
  }
  for (const symop of evidence.symbolOps) {
    if (!verifySymbolOp(symop)) invalid('a symbol operation does not verify');
  }

  const allOps = [...ops.values()];
  const files = new Map<string, Entry>();
  const verified: VerifiedView[] = views.map(({ view, chain }) => {
    const history = historyOf(allOps, chain);
    const pinned = consent.views.find((v) => v.view === view);
    const revisions = history.map((v) => v.revision);
    if (
      pinned === undefined ||
      pinned.revisions.length !== revisions.length ||
      pinned.revisions.some((r, i) => r !== revisions[i])
    ) {
      throw new MigrationError(
        'mismatch',
        `${view}: the reconstructed history differs from the revisions the owner signed`
      );
    }
    for (const version of history) {
      for (const entry of version.entries) {
        if (!isServicePath(entry.path)) {
          invalid(
            `${JSON.stringify(entry.path)} cannot be stored by the trusted service`
          );
        }
        files.set(`${entry.path}\0${entry.contentId}`, entry);
      }
    }
    return { view, chain, history };
  });
  return {
    owner,
    repo,
    views: verified,
    files: sortEntries([...files.values()]),
  };
}
