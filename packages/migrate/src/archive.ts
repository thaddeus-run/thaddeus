import { SymbolOpLog } from '@thaddeus.run/graph';
import { Platform, type Repo } from '@thaddeus.run/platform';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import { ReviewLog, VetoLog } from '@thaddeus.run/review';
import {
  address,
  type Backend,
  decodeRecord,
  scoped,
} from '@thaddeus.run/store';

import { byCodeUnit, fromBase64url, isRecord } from './codec';
import { type Consent, decodeConsent } from './consent';
import { MigrationError } from './errors';
import {
  type Evidence,
  EVIDENCE_KINDS,
  type EvidenceKind,
  type EvidenceRecord,
  evidenceRecords,
  fromRecords,
  type VerifiedEvidence,
  verifyEvidence,
} from './evidence';
import { ARCHIVE_FORMAT } from './migrator';
import { buildReport, evidenceDigest, type Report } from './report';

/** An archive that passed `verifyArchive`, decoded. */
export interface VerifiedArchive {
  readonly consent: Consent;
  readonly evidence: Evidence;
  readonly verified: VerifiedEvidence;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly report: Report;
}

function malformed(message: string): never {
  throw new MigrationError('malformed', message);
}

/**
 * Checks an exported archive with nothing but its own contents: the owner's
 * consent signature, every original signed record, every file against the
 * content id the owner signed, and the report against one rebuilt from
 * scratch. `service`, when given, must be the service the consent names.
 */
export function verifyArchive(
  text: string,
  options: { readonly service?: string } = {}
): VerifiedArchive {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    malformed('the archive is not JSON');
  }
  if (!isRecord(parsed)) malformed('the archive is an object');
  if (parsed.format !== ARCHIVE_FORMAT) {
    throw new MigrationError(
      'unsupported_format',
      `archive format ${JSON.stringify(parsed.format)} is not ${ARCHIVE_FORMAT}`
    );
  }
  const consent = decodeConsent(parsed.consent as string);
  if (options.service !== undefined && consent.service !== options.service) {
    throw new MigrationError(
      'wrong_service',
      `the archive was migrated to ${consent.service}`
    );
  }
  if (!Array.isArray(parsed.evidence) || !Array.isArray(parsed.files)) {
    malformed('the archive lists evidence and files');
  }
  const records: EvidenceRecord[] = (parsed.evidence as unknown[]).map(
    (item) => {
      if (
        !isRecord(item) ||
        !EVIDENCE_KINDS.includes(item.kind as EvidenceKind) ||
        typeof item.key !== 'string' ||
        typeof item.record !== 'string'
      ) {
        malformed('an evidence entry is malformed');
      }
      let record: unknown;
      try {
        record = decodeRecord(fromBase64url(item.record));
      } catch {
        malformed(`evidence ${item.key} does not decode`);
      }
      return { kind: item.kind as EvidenceKind, key: item.key, record };
    }
  );
  const evidence = fromRecords(records);
  // The listed keys must be the ones the records themselves produce, so an
  // archive cannot relabel a record.
  const recomputed = evidenceRecords(evidence);
  const listed = records.map((r) => `${r.kind}/${r.key}`);
  if (
    recomputed.length !== listed.length ||
    recomputed.some((r, i) => `${r.kind}/${r.key}` !== listed[i])
  ) {
    throw new MigrationError(
      'invalid_evidence',
      'the archive evidence keys do not match its records'
    );
  }
  const verified = verifyEvidence(evidence, consent);
  const files = new Map<string, Uint8Array>();
  const sizes = new Map<string, number>();
  for (const item of parsed.files as unknown[]) {
    if (
      !isRecord(item) ||
      typeof item.path !== 'string' ||
      typeof item.contentId !== 'string' ||
      typeof item.data !== 'string'
    ) {
      malformed('a file entry is malformed');
    }
    const bytes = fromBase64url(item.data);
    if (address(bytes) !== item.contentId) {
      throw new MigrationError(
        'content_mismatch',
        `${item.path} does not hash to ${item.contentId}`
      );
    }
    const key = `${item.path}\0${item.contentId}`;
    files.set(key, bytes);
    sizes.set(key, bytes.length);
  }
  const wanted = verified.files.map((f) => `${f.path}\0${f.contentId}`);
  const given = [...files.keys()].sort(byCodeUnit);
  if (
    wanted.length !== given.length ||
    [...wanted].sort(byCodeUnit).some((k, i) => k !== given[i])
  ) {
    throw new MigrationError(
      'incomplete',
      'the archive files are not exactly the migrated files'
    );
  }
  const report = buildReport(
    consent,
    verified,
    sizes,
    evidenceDigest(recomputed)
  );
  if (JSON.stringify(report) !== JSON.stringify(parsed.report)) {
    throw new MigrationError(
      'mismatch',
      'the archive report differs from the one its contents produce'
    );
  }
  return { consent, evidence, verified, files, report };
}

/**
 * Writes an archive's original signed records back into a keyless
 * repository store under `backend`, the layout `Platform.openDurable` and
 * the CLI working copy read. Every record keeps its original signature and
 * the ciphertext keeps its original capabilities, so the owner reads the
 * files with its own keys exactly as before the migration.
 */
export async function restoreArchive(
  text: string,
  backend: Backend
): Promise<Repo> {
  const { consent, evidence, verified } = verifyArchive(text);
  const name = consent.source.repo;
  const repo = await new Platform().createDurable(name, backend);
  for (const object of evidence.objects) {
    await repo.store.ingest(
      object,
      evidence.caps.filter((c) => c.object === object.plaintext_id)
    );
  }
  for (const op of [...evidence.ops].sort((a, b) =>
    a.lamport !== b.lamport ? a.lamport - b.lamport : byCodeUnit(a.id, b.id)
  )) {
    await repo.log.ingest(op);
  }
  for (const view of verified.views) {
    await repo.headRecords.import(view.chain, consent.source.owner);
    const tip = view.chain.at(-1);
    if (tip !== undefined) await repo.log.repoint(view.view, tip.heads);
  }
  const meta = scoped(backend, `repo/${name}/`);
  const provenance = new ProvenanceLog(repo.store, meta);
  for (const p of evidence.provenance) await provenance.ingest(p);
  const reviews = await ReviewLog.load(meta, name, consent.source.owner);
  for (const event of evidence.reviews) await reviews.import(event);
  const vetoes = await VetoLog.load(meta);
  for (const veto of evidence.vetoes) await vetoes.ingest(veto);
  const symbols = new SymbolOpLog(meta);
  for (const symop of evidence.symbolOps) await symbols.ingest(symop);
  return repo;
}
