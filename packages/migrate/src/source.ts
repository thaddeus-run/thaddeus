import type { Authorization } from '@thaddeus.run/authority';
import type { Client } from '@thaddeus.run/client';
import type { SymbolOp } from '@thaddeus.run/graph';
import type { Identity } from '@thaddeus.run/identity';
import type { HeadRecord, Op } from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import type { Repo } from '@thaddeus.run/platform';
import type { Provenance, ProvenanceLog } from '@thaddeus.run/provenance';
import type {
  ReviewEvent,
  ReviewLog,
  Veto,
  VetoLog,
} from '@thaddeus.run/review';
import type { Capability, EncryptedObject } from '@thaddeus.run/store';

import { byCodeUnit, recordKey } from './codec';
import { decodeConsent, type PinnedView, signConsent } from './consent';
import { MigrationError } from './errors';
import type { Evidence } from './evidence';
import { type Entry, historyOf, sortEntries, type Version } from './history';
import type { FileRef, Migrator } from './migrator';

export interface ReadSourceOptions {
  // The server URL the consent names as the source. The client already
  // talks to it; this is the owner's own label for it.
  readonly server: string;
  // The views to migrate. Defaults to every signed view the server lists.
  readonly views?: readonly string[];
  // An owner DID learned out of band, checked like `clone --owner`.
  readonly expectedOwner?: string;
}

export interface SourceView {
  readonly view: string;
  readonly chain: readonly HeadRecord[];
  readonly history: readonly Version[];
}

interface Meta {
  readonly provenance: ProvenanceLog;
  readonly vetoes: VetoLog;
  readonly reviews: ReviewLog;
  readonly symbols: { all(): readonly SymbolOp[] };
}

/**
 * A keyless repository as its owner's client reads it for migration. Every
 * view is cloned through the shipped client, which verifies the owner-signed
 * head chain and the exact operation closure, into memory. Content is
 * decrypted here, with the owner's keys, only when a file is transferred.
 */
export class Source {
  readonly server: string;
  readonly name: string;
  readonly owner: string;
  readonly views: readonly SourceView[];
  readonly evidence: Evidence;
  readonly #client: Client;
  readonly #repo: Repo;
  readonly #backend: MemoryBackend;
  readonly #files: ReadonlySet<string>;

  private constructor(fields: {
    server: string;
    name: string;
    owner: string;
    views: SourceView[];
    evidence: Evidence;
    client: Client;
    repo: Repo;
    backend: MemoryBackend;
  }) {
    this.server = fields.server;
    this.name = fields.name;
    this.owner = fields.owner;
    this.views = fields.views;
    this.evidence = fields.evidence;
    this.#client = fields.client;
    this.#repo = fields.repo;
    this.#backend = fields.backend;
    this.#files = new Set(
      fields.views.flatMap((v) =>
        v.history.flatMap((h) =>
          h.entries.map((e) => `${e.path}\0${e.contentId}`)
        )
      )
    );
  }

  /** Reads and verifies every signed view of `name` from `client`'s server. */
  static async read(
    client: Client,
    name: string,
    options: ReadSourceOptions
  ): Promise<Source> {
    const backend = new MemoryBackend();
    const cloned = await client.clone(
      name,
      backend,
      'main',
      options.expectedOwner === undefined
        ? undefined
        : { expectedOwner: options.expectedOwner }
    );
    const repo = cloned.repo;
    const listed = await client.listViews(name, repo);
    const wanted = [...(options.views ?? Object.keys(listed))].sort(byCodeUnit);
    if (wanted.length === 0) {
      throw new MigrationError('malformed', `${name} has no signed views`);
    }
    const metas: Meta[] = [cloned];
    for (const view of wanted) {
      if (view === 'main') continue;
      if (!(view in listed)) {
        throw new MigrationError(
          'malformed',
          `${name} has no signed view ${view}`
        );
      }
      metas.push(await client.pull(name, repo, backend, view));
    }
    const owner = repo.headRecords.owner;
    if (owner === undefined) {
      throw new MigrationError(
        'invalid_evidence',
        `${name} has no signed owner`
      );
    }
    const chains = wanted.map((view) => {
      const chain = repo.headRecords.history(view);
      if (chain.length === 0) {
        throw new MigrationError('malformed', `${view} has no signed history`);
      }
      return { view, chain };
    });
    const reachable = new Map<string, Op>();
    for (const { chain } of chains) {
      for (const op of repo.log.reachable(chain.at(-1)?.heads ?? [])) {
        reachable.set(op.id, op);
      }
    }
    const ops = [...reachable.values()];
    const evidence = collect(repo, ops, chains, metas);
    const views = chains.map(({ view, chain }) => ({
      view,
      chain,
      history: historyOf(ops, chain),
    }));
    return new Source({
      server: options.server,
      name,
      owner,
      views,
      evidence,
      client,
      repo,
      backend,
    });
  }

  /** Every file any migrated version holds, sorted. */
  files(): Entry[] {
    return sortEntries(
      [...this.#files].map((key) => {
        const [path = '', contentId = ''] = key.split('\0');
        return { path, contentId };
      })
    );
  }

  /** The pinned views, as a consent names them. */
  pinned(): PinnedView[] {
    return this.views.map((v) => {
      const tip = v.chain.at(-1) as HeadRecord;
      return {
        view: v.view,
        version: tip.version,
        head: tip.id,
        revisions: v.history.map((h) => h.revision),
      };
    });
  }

  /**
   * Signs the owner's consent to migrate exactly this history into one
   * trusted service. Refuses unless `owner` is the DID that signs the
   * source's head chains.
   */
  consent(
    owner: Identity,
    target: {
      readonly service: string;
      readonly tenant: string;
      readonly repo: string;
    },
    options: { readonly now?: number; readonly lifetimeMs?: number } = {}
  ): string {
    if (owner.did !== this.owner) {
      throw new MigrationError(
        'not_owner',
        `${this.name} is owned by ${this.owner}, not ${owner.did}`
      );
    }
    return signConsent(owner, {
      service: target.service,
      tenant: target.tenant,
      repo: target.repo,
      source: { server: this.server, repo: this.name },
      views: this.pinned(),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.lifetimeMs === undefined
        ? {}
        : { lifetimeMs: options.lifetimeMs }),
    });
  }

  /** Decrypts one migrated file with the owner's own keys, on this machine. */
  async plaintext(owner: Identity, file: FileRef): Promise<Uint8Array> {
    if (!this.#files.has(`${file.path}\0${file.contentId}`)) {
      throw new MigrationError(
        'not_in_evidence',
        `no migrated version holds ${file.contentId} at ${file.path}`
      );
    }
    return this.#repo.store.get(
      { id: '', plaintext_id: file.contentId },
      owner
    );
  }

  /**
   * Reads the source's current signed head for every pinned view again, for
   * `Migrator.cutover`. The client refuses a chain that rolled back or forked
   * against what was read before.
   */
  async latest(): Promise<HeadRecord[]> {
    const heads: HeadRecord[] = [];
    for (const { view } of this.views) {
      const pulled = await this.#client.pull(
        this.name,
        this.#repo,
        this.#backend,
        view
      );
      heads.push(pulled.head);
    }
    return heads;
  }
}

// Gathers the original records for `ops`: the chains, the ciphertext and
// capabilities the operations name, and the signed meaning around them.
function collect(
  repo: Repo,
  ops: readonly Op[],
  chains: readonly { chain: readonly HeadRecord[] }[],
  metas: readonly Meta[]
): Evidence {
  const opIds = new Set(ops.map((op) => op.id));
  const provenance = new Map<string, Provenance>();
  const vetoes = new Map<string, Veto>();
  const reviews = new Map<string, ReviewEvent>();
  const symbolOps = new Map<string, SymbolOp>();
  for (const meta of metas) {
    for (const op of ops) {
      for (const p of meta.provenance.forOp(op.id)) {
        provenance.set(recordKey('provenance', p), p);
      }
      for (const v of meta.vetoes.forOp(op.id))
        vetoes.set(recordKey('veto', v), v);
    }
    for (const event of meta.reviews.events()) {
      reviews.set(recordKey('review', event), event);
    }
    for (const s of meta.symbols.all()) symbolOps.set(s.id, s);
  }
  const contents = new Set<string>();
  for (const op of ops)
    if (op.payload !== null) contents.add(op.payload.plaintext_id);
  for (const p of provenance.values()) {
    if (p.prompt !== null && opIds.has(p.op))
      contents.add(p.prompt.plaintext_id);
  }
  const objects: EncryptedObject[] = [];
  const caps: Capability[] = [];
  for (const pid of [...contents].sort(byCodeUnit)) {
    const object = repo.store.current(pid);
    if (object === undefined) continue;
    objects.push(object);
    caps.push(...repo.store.caps(pid));
  }
  return {
    heads: chains.flatMap(({ chain }) => [...chain]),
    ops,
    objects,
    caps,
    provenance: [...provenance.values()],
    vetoes: [...vetoes.values()],
    reviews: [...reviews.values()],
    symbolOps: [...symbolOps.values()],
  };
}

/**
 * Sends every file the migrator still lacks, decrypting each one with the
 * owner's keys just before it goes. Refuses unless `token` is a consent the
 * owner signed for this migrator's service, so plaintext never leaves for a
 * service the owner did not name. `limit` stops after that many files, which
 * the restart tests use to interrupt an import.
 */
export async function transfer(
  source: Source,
  owner: Identity,
  migrator: Migrator,
  authorization: Authorization,
  token: string,
  options: { readonly limit?: number } = {}
): Promise<{ stored: number; present: number; remaining: number }> {
  const consent = decodeConsent(token);
  if (consent.source.owner !== owner.did || owner.did !== source.owner) {
    throw new MigrationError(
      'not_owner',
      `the consent and source must both belong to ${owner.did}`
    );
  }
  if (consent.service !== migrator.service) {
    throw new MigrationError(
      'wrong_service',
      `the consent names ${consent.service}, not the service being sent to`
    );
  }
  const missing = await migrator.missing(authorization);
  let stored = 0;
  let present = 0;
  const limit = options.limit ?? missing.length;
  for (const file of missing.slice(0, limit)) {
    const bytes = await source.plaintext(owner, file);
    const outcome = await migrator.put(authorization, { ...file, bytes });
    if (outcome === 'stored') stored += 1;
    else present += 1;
  }
  return { stored, present, remaining: Math.max(0, missing.length - limit) };
}
