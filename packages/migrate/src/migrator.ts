import type {
  Authority,
  Authorization,
  KeyCustody,
  SealedContent,
  ServiceHeadRecord,
} from '@thaddeus.run/authority';
import { type HeadRecord, verifyHead } from '@thaddeus.run/log';
import {
  address,
  type Backend,
  decodeRecord,
  encodeRecord,
} from '@thaddeus.run/store';

import { base64url, byCodeUnit, decodeUtf8, digest, utf8 } from './codec';
import { type Consent, decodeConsent } from './consent';
import { MigrationError } from './errors';
import {
  type Evidence,
  type EvidenceRecord,
  evidenceRecords,
  fromRecords,
  type VerifiedEvidence,
  verifyEvidence,
} from './evidence';
import { changedPaths, type Entry } from './history';
import { buildReport, evidenceDigest, type Report } from './report';

/** The trusted-service repository format a migration writes. */
export const TRUSTED_FORMAT = 'thaddeus.trusted-repo.v1';
export const ARCHIVE_FORMAT = 'thaddeus.migration-archive.v1';

// How far a consent's issue time may be ahead of the service clock.
const SKEW_MS = 5 * 60 * 1000;

export type MigrationPhase =
  | 'importing'
  | 'verified'
  | 'cutover'
  | 'rolled_back';

/**
 * One entry in a repository's migration state log. The log only grows, and
 * each entry names the consent it acts on and who asked for it.
 */
export interface MigrationState {
  readonly v: 1;
  readonly seq: number;
  readonly state: MigrationPhase;
  readonly consent: string;
  readonly at: number;
  readonly principal: string;
  readonly subject: string;
  readonly credential: string;
  // The report digest a verification established.
  readonly report?: string;
}

/** A file one migrated version holds. */
export interface FileRef {
  readonly path: string;
  readonly contentId: string;
}

export interface FileUpload extends FileRef {
  readonly bytes: Uint8Array;
}

export interface Progress {
  readonly consent: string;
  readonly files: number;
  readonly missing: number;
}

export interface Cutover {
  readonly views: readonly {
    readonly view: string;
    readonly head: ServiceHeadRecord;
  }[];
}

export interface MigratorOptions {
  readonly authority: Authority;
  readonly custody: KeyCustody;
  // The service's durable state, usually the backend the authority uses.
  readonly backend: Backend;
  readonly now?: () => number;
}

interface StoredContent {
  readonly v: 1;
  readonly path: string;
  readonly contentId: string;
  readonly size: number;
  readonly sealed: SealedContent;
}

interface StoredIndex {
  readonly v: 1;
  readonly consent: string;
  readonly keys: readonly string[];
  readonly digest: string;
}

// A consent with its evidence loaded and checked.
interface Loaded {
  readonly token: string;
  readonly consent: Consent;
  readonly records: readonly EvidenceRecord[];
  readonly verified: VerifiedEvidence;
  readonly needed: ReadonlySet<string>;
}

const pad = (n: number): string => String(n).padStart(12, '0');
const repoKey = (repo: string): string => digest('thaddeus.migrate.name', repo);
const fileKey = (f: FileRef): string => `${f.path}\0${f.contentId}`;

// `trusted/` holds the repository in the trusted-service format: sealed
// content and the revisions service head records name. `migrate/` holds how
// it got there: consents, the original signed evidence and the state log.
const trustedPrefix = (tenant: string, repo: string): string =>
  `trusted/${tenant}/${repoKey(repo)}/`;
const migratePrefix = (tenant: string, repo: string): string =>
  `migrate/${tenant}/${repoKey(repo)}/`;
const contentKey = (tenant: string, repo: string, f: FileRef): string =>
  `${trustedPrefix(tenant, repo)}content/${digest('thaddeus.migrate.path', f.path)}/${f.contentId}`;

function unsupported(what: string, value: unknown): never {
  throw new MigrationError(
    'unsupported_format',
    `${what} ${JSON.stringify(value)} is not a format this migrator reads`
  );
}

/**
 * Moves keyless repositories into trusted-service storage. Every step names
 * an authorization from the service's `Authority`, and only the repository
 * owner the consent names may run them:
 *
 * 1. `begin` (edit) accepts the owner's consent and the original signed
 *    records, checks them all and keeps them unchanged.
 * 2. `put` (edit) takes one file the owner decrypted on its own machine,
 *    checks it hashes to the content id the owner signed and seals it under
 *    the repository's data key. `missing` says what is left, so an
 *    interrupted import resumes where it stopped.
 * 3. `verify` (read) opens every sealed file again and compares the
 *    reconstructed history with the revisions the owner signed.
 * 4. `cutover` (integrate) refuses if the source moved, then replays every
 *    source version as a service head record.
 * 5. `rollback` (integrate) withdraws the trusted copy while nothing has
 *    been built on it; the keyless source was never changed.
 * 6. `export` (read) writes a deterministic archive of the evidence and the
 *    files that `verifyArchive` checks offline.
 */
export class Migrator {
  readonly #authority: Authority;
  readonly #custody: KeyCustody;
  readonly #backend: Backend;
  readonly #now: () => number;
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #loaded = new Map<string, Promise<Loaded>>();

  constructor(options: MigratorOptions) {
    if (typeof options.backend.putIfAbsent !== 'function') {
      throw new TypeError('a migrator needs a backend with atomic create');
    }
    this.#authority = options.authority;
    this.#custody = options.custody;
    this.#backend = options.backend;
    this.#now = options.now ?? Date.now;
  }

  /** The DID of the service this migrator writes for. */
  get service(): string {
    return this.#authority.did;
  }

  /** The newest migration state for a repository, or null before any. */
  async status(tenant: string, repo: string): Promise<MigrationState | null> {
    const keys = await this.#backend.list(
      `${migratePrefix(tenant, repo)}state/`
    );
    const newest = [...keys].sort(byCodeUnit).at(-1);
    if (newest === undefined) return null;
    const state = await this.#read<MigrationState>(newest);
    if (state === undefined) return null;
    if (state.v !== 1) unsupported('migration state version', state.v);
    return state;
  }

  /**
   * Accepts the owner's consent and the original signed records. Running it
   * again with the same consent resumes; a newer consent from the same owner
   * for a source that moved replaces the pending one and keeps the files
   * already sealed. Another source cannot take over a pending migration.
   */
  async begin(
    authorization: Authorization,
    token: string,
    evidence: Evidence
  ): Promise<Progress> {
    const { tenant, repo } = this.#target(authorization, 'edit', true);
    return this.#lock(tenant, repo, async () => {
      const consent = decodeConsent(token);
      this.#accept(consent, tenant, repo, authorization);
      verifyEvidence(evidence, consent);
      const state = await this.status(tenant, repo);
      if (state?.state === 'cutover') {
        throw new MigrationError(
          'wrong_state',
          `${repo} is already cut over; roll it back before migrating again`
        );
      }
      const pending =
        state !== null &&
        (state.state === 'importing' || state.state === 'verified');
      if (pending && state.consent !== consent.id) {
        const current = (await this.#load(tenant, repo, state.consent, false))
          .consent.source;
        if (
          current.owner !== consent.source.owner ||
          current.repo !== consent.source.repo
        ) {
          throw new MigrationError(
            'wrong_state',
            `${repo} is being migrated from ${current.repo} by ${current.owner}; that owner must roll it back first`
          );
        }
      }
      const records = evidenceRecords(evidence);
      if (!(pending && state.consent === consent.id)) {
        await this.#writeFormat(tenant, repo);
        const base = migratePrefix(tenant, repo);
        await this.#create(`${base}consent/${consent.id}`, utf8(token));
        for (const record of records) {
          await this.#create(
            `${base}evidence/${record.kind}/${record.key}`,
            encodeRecord({ v: 1, ...record })
          );
        }
        const index: StoredIndex = {
          v: 1,
          consent: consent.id,
          keys: records.map((r) => `${r.kind}/${r.key}`),
          digest: evidenceDigest(records),
        };
        await this.#create(`${base}index/${consent.id}`, encodeRecord(index));
        await this.#transition(
          tenant,
          repo,
          state,
          'importing',
          consent.id,
          authorization
        );
      }
      // Every later step works from what is stored, so read it back.
      const loaded = await this.#load(tenant, repo, consent.id, true);
      return {
        consent: consent.id,
        files: loaded.verified.files.length,
        missing: (await this.#missing(tenant, repo, loaded)).length,
      };
    });
  }

  /** Files the current consent needs that are not sealed yet, sorted. */
  async missing(authorization: Authorization): Promise<FileRef[]> {
    const { tenant, repo } = this.#target(authorization, 'edit', true);
    const loaded = await this.#current(tenant, repo, authorization, [
      'importing',
      'verified',
    ]);
    return this.#missing(tenant, repo, loaded);
  }

  /**
   * Seals one file the owner decrypted. The bytes must hash to the content
   * id the owner's signed operations name, at a path some migrated version
   * holds. A file that is already sealed is left as it is.
   */
  async put(
    authorization: Authorization,
    file: FileUpload
  ): Promise<'stored' | 'present'> {
    const { tenant, repo } = this.#target(authorization, 'edit', true);
    return this.#lock(tenant, repo, async () => {
      const loaded = await this.#current(tenant, repo, authorization, [
        'importing',
        'verified',
      ]);
      this.#live(loaded.consent);
      if (!loaded.needed.has(fileKey(file))) {
        throw new MigrationError(
          'not_in_evidence',
          `no migrated version holds ${file.contentId} at ${file.path}`
        );
      }
      if (
        !(file.bytes instanceof Uint8Array) ||
        address(file.bytes) !== file.contentId
      ) {
        throw new MigrationError(
          'content_mismatch',
          `the bytes for ${file.path} do not hash to ${file.contentId}`
        );
      }
      const key = contentKey(tenant, repo, file);
      if ((await this.#backend.get(key)) !== undefined) return 'present';
      const sealed = await this.#custody.seal(
        authorization,
        file.path,
        file.bytes
      );
      const record: StoredContent = {
        v: 1,
        path: file.path,
        contentId: file.contentId,
        size: file.bytes.length,
        sealed,
      };
      await this.#create(key, encodeRecord(record));
      return 'stored';
    });
  }

  /**
   * Compares the trusted copy with the source before cutover. Reloads the
   * evidence from storage and checks it again, opens every sealed file
   * through key custody and checks its hash, and rebuilds every version's
   * revision. Refuses with `incomplete` while files are missing.
   */
  async verify(authorization: Authorization): Promise<Report> {
    const { tenant, repo } = this.#target(authorization, 'read', true);
    return this.#lock(tenant, repo, async () => {
      const state = await this.#require(tenant, repo, authorization, [
        'importing',
        'verified',
      ]);
      const loaded = await this.#load(tenant, repo, state.consent, true);
      const sizes = new Map<string, number>();
      const absent: FileRef[] = [];
      for (const file of loaded.verified.files) {
        const bytes = await this.#open(tenant, repo, authorization, file);
        if (bytes === undefined) absent.push(file);
        else sizes.set(fileKey(file), bytes.length);
      }
      if (absent.length > 0) {
        throw new MigrationError(
          'incomplete',
          `${absent.length} of ${loaded.verified.files.length} files are not sealed yet`
        );
      }
      const report = buildReport(
        loaded.consent,
        loaded.verified,
        sizes,
        evidenceDigest(loaded.records)
      );
      const reportDigest = digest(
        'thaddeus.migrate.report.v1',
        JSON.stringify(report)
      );
      if (state.state !== 'verified' || state.report !== reportDigest) {
        await this.#transition(
          tenant,
          repo,
          state,
          'verified',
          state.consent,
          authorization,
          reportDigest
        );
      }
      return report;
    });
  }

  /**
   * Makes the verified copy the repository's history in the trusted service.
   * `latest` are the source's current signed head records, which the host
   * reads from the keyless server just before; if any pinned view has moved
   * the cutover is refused. Each source version becomes one service head
   * record at the same version, so an interrupted cutover resumes from the
   * last record it wrote.
   */
  async cutover(
    authorization: Authorization,
    latest: readonly HeadRecord[]
  ): Promise<Cutover> {
    const { tenant, repo } = this.#target(authorization, 'integrate', true);
    return this.#lock(tenant, repo, async () => {
      const state = await this.#require(tenant, repo, authorization, [
        'verified',
        'cutover',
      ]);
      const loaded = await this.#load(tenant, repo, state.consent, false);
      const { consent, verified } = loaded;
      if (state.state === 'verified') {
        for (const pinned of consent.views) {
          const record = latest.find((r) => r.view === pinned.view);
          if (record === undefined) {
            throw new MigrationError(
              'malformed',
              `the current source head for ${pinned.view} is missing`
            );
          }
          const checked = verifyHead(record);
          if (
            !checked.ok ||
            record.owner !== consent.source.owner ||
            record.repo !== consent.source.repo
          ) {
            throw new MigrationError(
              'invalid_evidence',
              `the current source head for ${pinned.view} is not the owner's`
            );
          }
          if (record.id !== pinned.head) {
            throw new MigrationError(
              'source_moved',
              `${pinned.view} is at version ${record.version}, not the migrated version ${pinned.version}; migrate again with a new consent`
            );
          }
        }
        for (const view of verified.views) {
          for (const version of view.history) {
            await this.#create(
              `${trustedPrefix(tenant, repo)}revision/${version.revision}`,
              encodeRecord({
                v: 1,
                id: version.revision,
                entries: version.entries.map((e) => [e.path, e.contentId]),
              })
            );
          }
        }
      }
      const views: { view: string; head: ServiceHeadRecord }[] = [];
      for (const view of verified.views) {
        const history = view.history;
        let tip = await this.#tip(tenant, repo, view.view, history);
        for (
          let i = tip === null ? 0 : tip.version + 1;
          i < history.length;
          i++
        ) {
          const current = history[i];
          if (current === undefined) break;
          tip = await this.#authority.advance(authorization, {
            view: view.view,
            expectedVersion: i === 0 ? null : i - 1,
            revision: current.revision,
            changedPaths: changedPaths(
              history[i - 1]?.entries ?? [],
              current.entries
            ),
          });
        }
        if (tip === null) {
          throw new MigrationError(
            'wrong_state',
            `${view.view} has no versions`
          );
        }
        views.push({ view: view.view, head: tip });
      }
      if (state.state === 'verified') {
        await this.#transition(
          tenant,
          repo,
          state,
          'cutover',
          state.consent,
          authorization
        );
      }
      return { views };
    });
  }

  /**
   * Withdraws the trusted copy and hands authority back to the keyless
   * source, which the migration never changed. Allowed while no service
   * history goes beyond what was migrated, so nothing is lost. The sealed
   * content and revisions are deleted; the consent, evidence and state log
   * stay as the record of what happened.
   */
  async rollback(authorization: Authorization): Promise<MigrationState> {
    const { tenant, repo } = this.#target(authorization, 'integrate', true);
    return this.#lock(tenant, repo, async () => {
      const state = await this.#require(tenant, repo, authorization, [
        'importing',
        'verified',
        'cutover',
      ]);
      const loaded = await this.#load(tenant, repo, state.consent, false);
      for (const view of loaded.verified.views) {
        await this.#tip(tenant, repo, view.view, view.history);
      }
      for (const key of await this.#backend.list(trustedPrefix(tenant, repo))) {
        await this.#backend.delete(key);
      }
      return this.#transition(
        tenant,
        repo,
        state,
        'rolled_back',
        state.consent,
        authorization
      );
    });
  }

  /**
   * A deterministic archive of the verified migration: the consent, every
   * original signed record and every migrated file. The same migration
   * always exports the same text, and `verifyArchive` checks it with no
   * service at hand.
   */
  async export(authorization: Authorization): Promise<string> {
    const { tenant, repo } = this.#target(authorization, 'read', true);
    return this.#lock(tenant, repo, async () => {
      const state = await this.#require(tenant, repo, authorization, [
        'verified',
        'cutover',
      ]);
      const loaded = await this.#load(tenant, repo, state.consent, true);
      const sizes = new Map<string, number>();
      const files: { path: string; contentId: string; data: string }[] = [];
      for (const file of loaded.verified.files) {
        const bytes = await this.#open(tenant, repo, authorization, file);
        if (bytes === undefined) {
          throw new MigrationError('incomplete', `${file.path} is not sealed`);
        }
        sizes.set(fileKey(file), bytes.length);
        files.push({
          path: file.path,
          contentId: file.contentId,
          data: base64url(bytes),
        });
      }
      const report = buildReport(
        loaded.consent,
        loaded.verified,
        sizes,
        evidenceDigest(loaded.records)
      );
      return JSON.stringify({
        format: ARCHIVE_FORMAT,
        consent: loaded.token,
        evidence: loaded.records.map((r) => ({
          kind: r.kind,
          key: r.key,
          record: base64url(encodeRecord(r.record)),
        })),
        files,
        report,
      });
    });
  }

  /**
   * The files at a cut-over view's current head that `authorization` may
   * read, from the trusted-service format alone.
   */
  async tree(authorization: Authorization, view: string): Promise<Entry[]> {
    const { tenant, repo } = this.#target(authorization, 'read', false);
    await this.#require(tenant, repo, authorization, ['cutover'], false);
    const head = await this.#authority.head(tenant, repo, view);
    if (head === null) {
      throw new MigrationError('wrong_state', `${view} has no trusted history`);
    }
    const revision = await this.#read<{
      v: number;
      id: string;
      entries: [string, string][];
    }>(`${trustedPrefix(tenant, repo)}revision/${head.revision}`);
    if (revision === undefined) {
      throw new MigrationError(
        'incomplete',
        `revision ${head.revision} is missing`
      );
    }
    if (revision.v !== 1) unsupported('revision version', revision.v);
    return revision.entries
      .map(([path, contentId]) => ({ path, contentId }))
      .filter((e) => authorization.allows(e.path));
  }

  /** One file at a cut-over view's current head, opened through key custody. */
  async read(
    authorization: Authorization,
    view: string,
    path: string
  ): Promise<Uint8Array> {
    const { tenant, repo } = this.#target(authorization, 'read', false);
    const entry = (await this.tree(authorization, view)).find(
      (e) => e.path === path
    );
    if (entry === undefined) {
      throw new MigrationError(
        'not_in_evidence',
        `${view} has no readable ${path}`
      );
    }
    const bytes = await this.#open(tenant, repo, authorization, entry);
    if (bytes === undefined) {
      throw new MigrationError('incomplete', `${path} is not sealed`);
    }
    return bytes;
  }

  // Checks the authorization is genuine and live for this step's scope. Steps
  // that act on the whole repository need it to cover every path.
  #target(
    authorization: Authorization,
    scope: 'edit' | 'read' | 'integrate',
    whole: boolean
  ): { tenant: string; repo: string } {
    this.#authority.check(authorization);
    if (authorization.scope !== scope) {
      throw new MigrationError(
        'scope_denied',
        `this step needs a ${scope} authorization, not ${authorization.scope}`
      );
    }
    if (whole && !authorization.paths.includes('**')) {
      throw new MigrationError(
        'scope_denied',
        'a migration step needs an authorization over the whole repository (**)'
      );
    }
    return { tenant: authorization.tenant, repo: authorization.repo };
  }

  // The consent must be for this service and target, signed by the owner
  // that is asking, and current.
  #accept(
    consent: Consent,
    tenant: string,
    repo: string,
    authorization: Authorization
  ): void {
    if (consent.service !== this.#authority.did) {
      throw new MigrationError(
        'wrong_service',
        `the consent is for ${consent.service}, not this service`
      );
    }
    if (consent.tenant !== tenant || consent.repo !== repo) {
      throw new MigrationError(
        'wrong_target',
        `the consent is for ${consent.tenant}/${consent.repo}, not ${tenant}/${repo}`
      );
    }
    this.#owner(consent, authorization);
    this.#live(consent);
  }

  #owner(consent: Consent, authorization: Authorization): void {
    if (authorization.principal !== consent.source.owner) {
      throw new MigrationError(
        'not_owner',
        `only the source owner ${consent.source.owner} may migrate ${consent.source.repo}`
      );
    }
  }

  // Plaintext moves only while the owner's consent is current.
  #live(consent: Consent): void {
    const now = this.#now();
    if (consent.issuedAt > now + SKEW_MS) {
      throw new MigrationError(
        'invalid_consent',
        'the consent is from the future'
      );
    }
    if (now >= consent.expiresAt) {
      throw new MigrationError('expired', 'the consent has expired');
    }
  }

  // The newest state, which must be one of `allowed` and, unless `owned` is
  // false, belong to a consent signed by the principal that is asking.
  async #require(
    tenant: string,
    repo: string,
    authorization: Authorization,
    allowed: readonly MigrationPhase[],
    owned = true
  ): Promise<MigrationState> {
    const state = await this.status(tenant, repo);
    if (state === null || !allowed.includes(state.state)) {
      throw new MigrationError(
        'wrong_state',
        `${repo} is ${state?.state ?? 'not being migrated'}; this step needs ${allowed.join(' or ')}`
      );
    }
    if (owned) {
      const loaded = await this.#load(tenant, repo, state.consent, false);
      this.#owner(loaded.consent, authorization);
    }
    return state;
  }

  async #current(
    tenant: string,
    repo: string,
    authorization: Authorization,
    allowed: readonly MigrationPhase[]
  ): Promise<Loaded> {
    const state = await this.#require(tenant, repo, authorization, allowed);
    return this.#load(tenant, repo, state.consent, false);
  }

  async #missing(
    tenant: string,
    repo: string,
    loaded: Loaded
  ): Promise<FileRef[]> {
    const present = new Set(
      await this.#backend.list(`${trustedPrefix(tenant, repo)}content/`)
    );
    return loaded.verified.files
      .filter((f) => !present.has(contentKey(tenant, repo, f)))
      .map((f) => ({ path: f.path, contentId: f.contentId }));
  }

  // Opens one sealed file and checks it is the content the owner signed.
  // Undefined when the file was never sealed.
  async #open(
    tenant: string,
    repo: string,
    authorization: Authorization,
    file: FileRef
  ): Promise<Uint8Array | undefined> {
    const record = await this.#read<StoredContent>(
      contentKey(tenant, repo, file)
    );
    if (record === undefined) return undefined;
    if (record.v !== 1) unsupported('content version', record.v);
    if (record.path !== file.path || record.contentId !== file.contentId) {
      throw new MigrationError(
        'content_mismatch',
        `the record stored for ${file.path} names other content`
      );
    }
    const bytes = await this.#custody.open(
      authorization,
      file.path,
      record.sealed
    );
    if (address(bytes) !== file.contentId || bytes.length !== record.size) {
      throw new MigrationError(
        'content_mismatch',
        `${file.path} does not decrypt to ${file.contentId}`
      );
    }
    return bytes;
  }

  // The service head of a view, checked against the migrated history: it is
  // either absent or exactly the record for one migrated version. Anything
  // else means history was built on the trusted copy.
  async #tip(
    tenant: string,
    repo: string,
    view: string,
    history: VerifiedEvidence['views'][number]['history']
  ): Promise<ServiceHeadRecord | null> {
    const tip = await this.#authority.head(tenant, repo, view);
    if (tip === null) return null;
    const planned = history[tip.version];
    if (planned === undefined || planned.revision !== tip.revision) {
      throw new MigrationError(
        'diverged',
        `${view} has trusted history beyond what was migrated (version ${tip.version})`
      );
    }
    return tip;
  }

  #index(
    token: string,
    consent: Consent,
    records: readonly EvidenceRecord[],
    verified: VerifiedEvidence
  ): Loaded {
    return {
      token,
      consent,
      records,
      verified,
      needed: new Set(verified.files.map(fileKey)),
    };
  }

  // Loads a consent and its evidence from storage and checks them again.
  // `fresh` skips the cache, so verification and export read what is stored.
  #load(
    tenant: string,
    repo: string,
    consentId: string,
    fresh: boolean
  ): Promise<Loaded> {
    const cacheKey = `${tenant}\n${repo}\n${consentId}`;
    const cached = this.#loaded.get(cacheKey);
    if (cached !== undefined && !fresh) return cached;
    const pending = (async () => {
      const base = migratePrefix(tenant, repo);
      const tokenBytes = await this.#backend.get(`${base}consent/${consentId}`);
      const index = await this.#read<StoredIndex>(`${base}index/${consentId}`);
      if (tokenBytes === undefined || index === undefined) {
        throw new MigrationError(
          'incomplete',
          `the consent or evidence index for ${consentId} is missing`
        );
      }
      if (index.v !== 1) unsupported('evidence index version', index.v);
      const token = decodeUtf8(tokenBytes);
      const consent = decodeConsent(token);
      const records: EvidenceRecord[] = [];
      for (const name of index.keys) {
        const stored = await this.#read<EvidenceRecord & { v: number }>(
          `${base}evidence/${name}`
        );
        if (stored === undefined) {
          throw new MigrationError(
            'invalid_evidence',
            `evidence ${name} is missing`
          );
        }
        if (stored.v !== 1) unsupported('evidence version', stored.v);
        records.push({
          kind: stored.kind,
          key: stored.key,
          record: stored.record,
        });
      }
      const evidence = fromRecords(records);
      const recomputed = evidenceRecords(evidence);
      if (evidenceDigest(recomputed) !== index.digest) {
        throw new MigrationError(
          'invalid_evidence',
          'the stored evidence no longer matches its index'
        );
      }
      return this.#index(
        token,
        consent,
        recomputed,
        verifyEvidence(evidence, consent)
      );
    })();
    this.#loaded.set(cacheKey, pending);
    pending.catch(() => {
      if (this.#loaded.get(cacheKey) === pending) this.#loaded.delete(cacheKey);
    });
    return pending;
  }

  async #writeFormat(tenant: string, repo: string): Promise<void> {
    const key = `${trustedPrefix(tenant, repo)}format`;
    const existing = await this.#read<{ format: string }>(key);
    if (existing !== undefined) {
      if (existing.format !== TRUSTED_FORMAT) {
        unsupported('repository format', existing.format);
      }
      return;
    }
    await this.#create(
      key,
      encodeRecord({ format: TRUSTED_FORMAT, tenant, repo })
    );
  }

  // Appends the next state. Two migrators racing on one repository cannot
  // both append the same sequence number.
  async #transition(
    tenant: string,
    repo: string,
    prior: MigrationState | null,
    next: MigrationPhase,
    consent: string,
    authorization: Authorization,
    report?: string
  ): Promise<MigrationState> {
    const seq = prior === null ? 0 : prior.seq + 1;
    const state: MigrationState = {
      v: 1,
      seq,
      state: next,
      consent,
      at: this.#now(),
      principal: authorization.principal,
      subject: authorization.subject,
      credential: authorization.credential,
      ...(report === undefined ? {} : { report }),
    };
    const created = await this.#backend.putIfAbsent?.(
      `${migratePrefix(tenant, repo)}state/${pad(seq)}`,
      encodeRecord(state)
    );
    if (created !== true) {
      throw new MigrationError(
        'conflict',
        `another migrator changed ${repo}'s migration state`
      );
    }
    return state;
  }

  async #read<T>(key: string): Promise<T | undefined> {
    const bytes = await this.#backend.get(key);
    if (bytes === undefined) return undefined;
    try {
      return decodeRecord(bytes) as T;
    } catch {
      throw new MigrationError(
        'malformed',
        `the record at ${key} does not decode`
      );
    }
  }

  // Content-addressed records are written once; a second write of the same
  // key is the same record and is skipped.
  async #create(key: string, bytes: Uint8Array): Promise<void> {
    await this.#backend.putIfAbsent?.(key, bytes);
  }

  // Runs `work` after every earlier step for the same repository.
  #lock<T>(tenant: string, repo: string, work: () => Promise<T>): Promise<T> {
    const key = `${tenant}\n${repo}`;
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.#locks.set(key, settled);
    void settled.then(() => {
      if (this.#locks.get(key) === settled) this.#locks.delete(key);
    });
    return result;
  }
}
