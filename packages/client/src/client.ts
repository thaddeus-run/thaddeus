import { type Delegation, verifyDelegation } from '@thaddeus.run/agent';
import { type SymbolOp, SymbolOpLog } from '@thaddeus.run/graph';
import { type Identity, PublicIdentity } from '@thaddeus.run/identity';
import {
  type Conflict,
  decodeHeadRecord,
  encodeHeadRecord,
  type HeadRecord,
  type HeadRecordWire,
  signHead,
  verifyHead,
  verifyHeadChain,
  verifyHeadSnapshot,
} from '@thaddeus.run/log';
import {
  Platform,
  type Release,
  type Repo,
  verifyRelease,
} from '@thaddeus.run/platform';
import { type Provenance, ProvenanceLog } from '@thaddeus.run/provenance';
import {
  type ContributionClaim,
  decodeReputationArchive,
  encodeReputationArchive,
  type ReputationArchive,
} from '@thaddeus.run/reputation';
import { type Veto, VetoLog } from '@thaddeus.run/review';
import {
  decodeBundle,
  decodeCapability,
  decodeDelegation,
  decodeRelease,
  DEFAULT_MAX_REPUTATION_ARCHIVE_BYTES,
  DEFAULT_MAX_REPUTATION_CONTRIBUTIONS,
  encodeBundle,
  encodeCapability,
  encodeClaim,
  encodeDelegation,
  encodeRelease,
  type RepoPolicyRecord,
  signRequest,
} from '@thaddeus.run/server';
import {
  type Backend,
  type Capability,
  type EncryptedObject,
  type Ref,
  scoped,
  type Store,
} from '@thaddeus.run/store';

import { bundleFor } from './bundle';
import { reachablePids } from './share';

export interface PushResult {
  accepted: {
    objects: number;
    ops: number;
    caps: number;
    prov: number;
    veto: number;
    symop: number;
    pending: number;
  };
  rejected: { kind: string; id: string; reason: string }[];
}

export interface RevokeOutcome {
  agent: string;
  revoked: boolean;
  recalled?: PushResult;
}

export interface RevealOutcome {
  object: string;
  released: boolean;
  public: boolean;
}

export interface ScheduleRevealOutcome extends RevealOutcome {
  at: string;
  scheduled: boolean;
}

export type AttestationSkipReason =
  | 'not_attesting'
  | 'ineligible'
  | 'duplicate'
  | 'rate_limited'
  | 'limiter_unavailable'
  | 'signer_unavailable';

export interface AttestationSummary {
  readonly received: number;
  readonly issued: number;
  readonly skipped: Readonly<Record<AttestationSkipReason, number>>;
}

export interface LandOutcome {
  landed: boolean;
  into: string;
  head?: HeadRecord;
  heads: string[];
  conflicts: Conflict[];
  reason?: string;
  attestations?: AttestationSummary;
}

export interface ReleaseCreationOutcome {
  readonly release: Release;
  readonly attestations?: AttestationSummary;
}

export interface PageOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ReposPage {
  readonly repos: readonly string[];
  readonly owners: Readonly<Record<string, string>>;
  readonly nextCursor: string | null;
}

export interface ViewsPage {
  readonly views: Readonly<Record<string, HeadRecord>>;
  readonly nextCursor: string | null;
}

export interface ReleasesPage {
  readonly releases: readonly Release[];
  readonly nextCursor: string | null;
}

export interface GrantsPage {
  readonly grants: readonly Delegation[];
  readonly nextCursor: string | null;
}

export interface ReputationExportPage {
  readonly archive: ReputationArchive;
  readonly nextCursor: string | null;
}

/** Preserves stable server error metadata for client retry decisions. */
export class ClientResponseError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    status: number,
    details: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = 'ClientResponseError';
    this.status = status;
    this.details = details;
    if (typeof details.code === 'string') this.code = details.code;
  }
}

/** Signals that independently paged view phases observed different heads. */
class ViewSnapshotChangedError extends Error {
  constructor() {
    super('pagination_snapshot_changed: view list changed during read');
    this.name = 'ViewSnapshotChangedError';
  }
}

// A subject's server-wide profile: all trusted proofs remain visible in
// `attested`, while `counted` and byKind deduplicate semantic events.
export interface ReputationProfile {
  subject: string;
  attested: number;
  counted: number;
  untrusted: number;
  claimed: number;
  byKind: Record<string, number>;
}

export interface ReputationImportOutcome {
  subject: string;
  imported: number;
  duplicates: number;
  total: number;
}

// FetchLike matches the server's fetch(req: Request) shape. The client always
// constructs a Request before calling fetchImpl, so the narrower signature is
// compatible with both the injected server handler and the global fetch.
type FetchLike = (req: Request) => Promise<Response>;

interface HeadResponse {
  readonly view: string;
  readonly head: HeadRecordWire;
  readonly chain: readonly HeadRecordWire[];
}

function verificationError(
  verification: Exclude<ReturnType<typeof verifyHeadChain>, { ok: true }>
): Error {
  return new Error(`${verification.code}: ${verification.message}`);
}

function decodeVerifiedChain(
  body: HeadResponse,
  repo: string,
  view: string,
  options?: {
    owner?: string;
    prefix?: readonly HeadRecord[];
  }
): { head: HeadRecord; chain: HeadRecord[] } {
  if (body.view !== view || !Array.isArray(body.chain)) {
    throw new Error('wrong_view: remote returned a different view');
  }
  let head: HeadRecord;
  let chain: HeadRecord[];
  try {
    head = decodeHeadRecord(body.head);
    chain = body.chain.map(decodeHeadRecord);
  } catch (error) {
    throw new Error(
      `malformed_record: ${error instanceof Error ? error.message : 'invalid head response'}`
    );
  }
  const verification = verifyHeadChain(chain, {
    repo,
    view,
    owner: options?.owner,
    prefix: options?.prefix,
  });
  if (!verification.ok) throw verificationError(verification);
  if (chain.at(-1)?.id !== head.id) {
    throw new Error('fork: current head does not match the returned chain');
  }
  return { head, chain };
}

function verifiedRelease(
  wire: string,
  expectedRepo: string,
  expectedTag?: string
): Release {
  const release = decodeRelease(wire);
  if (
    !verifyRelease(release) ||
    release.repo !== expectedRepo ||
    (expectedTag !== undefined && release.tag !== expectedTag)
  ) {
    throw new Error('invalid release record');
  }
  return release;
}

/**
 * A small client over the Thaddeus HTTP remote. It signs every write and keeps
 * cryptographic verification client-side; fetch is injectable for local tests.
 */
export class Client {
  readonly #server: string;
  readonly #identity: Identity;
  readonly #fetch: FetchLike;

  constructor(
    server: string,
    identity: Identity,
    // Global fetch accepts Request too; cast so the default matches FetchLike.
    fetchImpl: FetchLike = (req: Request) => fetch(req)
  ) {
    this.#server = server.replace(/\/+$/, '');
    this.#identity = identity;
    this.#fetch = fetchImpl;
  }

  async createRepo(name: string): Promise<{ name: string; owner: string }> {
    const head = signHead(
      {
        repo: name,
        view: 'main',
        version: 0,
        previous: null,
        heads: [],
      },
      this.#identity
    );
    const res = await this.#signed('POST', '/repos', {
      name,
      head: encodeHeadRecord(head),
    });
    const body = (await this.#ok(res)) as { name: string; owner: string };
    return { name: body.name, owner: body.owner };
  }

  // Pull a view's reachable bundle by draining revision-bound pages from one
  // atomic snapshot. The response includes view+heads with ops/objects/caps, so
  // no separate /views call can introduce a clone TOCTOU.
  async clone(
    name: string,
    backend: Backend,
    view = 'main',
    options?: { expectedOwner?: string }
  ): Promise<{
    repo: Repo;
    head: HeadRecord;
    heads: readonly string[];
    provenance: ProvenanceLog;
    vetoes: VetoLog;
    symbols: SymbolOpLog;
  }> {
    const body = await this.#pullResponse(name, view);
    const repo = await new Platform().openDurable(name, backend);
    if (
      options?.expectedOwner !== undefined &&
      repo.headRecords.owner !== undefined &&
      options.expectedOwner !== repo.headRecords.owner
    ) {
      throw new Error(
        'wrong_owner: expected owner conflicts with the local pin'
      );
    }
    const verified = decodeVerifiedChain(body, name, view, {
      owner: options?.expectedOwner ?? repo.headRecords.owner,
      prefix: repo.headRecords.history(view),
    });
    const bundle = decodeBundle(body);
    bundle.ops.sort((left, right) =>
      left.lamport !== right.lamport
        ? left.lamport - right.lamport
        : left.id.localeCompare(right.id)
    );
    const snapshot = verifyHeadSnapshot(verified.head, bundle.ops);
    if (!snapshot.ok) throw verificationError(snapshot);
    await repo.headRecords.import(
      verified.chain,
      options?.expectedOwner ?? repo.headRecords.owner
    );
    for (const object of bundle.objects) {
      await repo.store.ingest(
        object,
        bundle.caps.filter((c) => c.object === object.plaintext_id)
      );
    }
    for (const op of bundle.ops) {
      await repo.log.ingest(op);
    }
    // Persist the pulled "why" (P04) and standing "no" (P10) into the working
    // copy's own scope, so `thaddeus log`/`why`/`vetoes` can read them offline —
    // same `repo/<name>/` namespace openDurable uses for the code, keeping the
    // whole substrate in one place.
    const metaScope = scoped(backend, `repo/${name}/`);
    const provenance = new ProvenanceLog(repo.store, metaScope);
    for (const p of bundle.prov) {
      await provenance.ingest(p);
    }
    const vetoes = new VetoLog(metaScope);
    for (const v of bundle.veto) {
      await vetoes.ingest(v);
    }
    const symbols = new SymbolOpLog(metaScope);
    for (const s of bundle.symop) {
      await symbols.ingest(s);
    }
    await repo.log.repoint(view, verified.head.heads);
    return {
      repo,
      head: verified.head,
      heads: verified.head.heads,
      provenance,
      vetoes,
      symbols,
    };
  }

  // Fetch a view's current bundle into an EXISTING working copy: ingest the
  // objects (+ their capabilities) and ops, re-point the view, and refresh the
  // meta logs. The incremental twin of `clone` — the caller owns the already
  // opened `repo` and its `backend`, so the working copy keeps its identity.
  async pull(
    name: string,
    repo: Repo,
    backend: Backend,
    remoteView = 'main',
    localView?: string
  ): Promise<{
    head: HeadRecord;
    heads: readonly string[];
    provenance: ProvenanceLog;
    vetoes: VetoLog;
    symbols: SymbolOpLog;
  }> {
    const targetView = localView ?? remoteView;
    const body = await this.#pullResponse(name, remoteView);
    const verified = decodeVerifiedChain(body, name, remoteView, {
      owner: repo.headRecords.owner,
      prefix: repo.headRecords.history(remoteView),
    });
    const bundle = decodeBundle(body);
    bundle.ops.sort((left, right) =>
      left.lamport !== right.lamport
        ? left.lamport - right.lamport
        : left.id.localeCompare(right.id)
    );
    const snapshot = verifyHeadSnapshot(verified.head, bundle.ops);
    if (!snapshot.ok) throw verificationError(snapshot);
    await repo.headRecords.import(verified.chain, repo.headRecords.owner);
    for (const object of bundle.objects) {
      await repo.store.ingest(
        object,
        bundle.caps.filter((c) => c.object === object.plaintext_id)
      );
    }
    for (const op of bundle.ops) {
      await repo.log.ingest(op);
    }
    const metaScope = scoped(backend, `repo/${name}/`);
    const provenance = new ProvenanceLog(repo.store, metaScope);
    for (const p of bundle.prov) {
      await provenance.ingest(p);
    }
    const vetoes = new VetoLog(metaScope);
    for (const v of bundle.veto) {
      await vetoes.ingest(v);
    }
    const symbols = new SymbolOpLog(metaScope);
    for (const s of bundle.symop) {
      await symbols.ingest(s);
    }
    await repo.log.repoint(targetView, verified.head.heads);
    return {
      head: verified.head,
      heads: verified.head.heads,
      provenance,
      vetoes,
      symbols,
    };
  }

  /**
   * Returns recipients authenticated by the locally pinned owner and its
   * verified active delegations; remote collection fields are never authority.
   */
  async members(name: string, repo: Repo): Promise<string[]> {
    const owner = repo.headRecords.owner;
    if (owner === undefined) {
      throw new Error('wrong_owner: repository owner is not locally pinned');
    }
    const delegates: string[] = [];
    for (const delegation of await this.listGrants(name)) {
      if (delegation.operator !== owner || !verifyDelegation(delegation)) {
        continue;
      }
      try {
        PublicIdentity.fromDid(delegation.agent);
      } catch {
        continue;
      }
      delegates.push(delegation.agent);
    }
    return [...new Set([owner, ...delegates])].sort();
  }

  // The repo's branches and their heads. Listing does not ingest content or
  // mutate trust, but newer records fetch their complete chain for validation.
  async listViews(name: string, repo: Repo): Promise<Record<string, string[]>> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#listViewsSnapshot(name, repo);
      } catch (error) {
        if (!(error instanceof ViewSnapshotChangedError) || attempt >= 2) {
          throw error;
        }
      }
    }
  }

  /** Reads the view list and detail chains once, without retaining partials. */
  async #listViewsSnapshot(
    name: string,
    repo: Repo
  ): Promise<Record<string, string[]>> {
    const pages = await this.#collectPages((cursor) =>
      this.listViewsPage(name, cursor === undefined ? {} : { cursor })
    );
    const body = {
      views: Object.fromEntries(
        pages
          .flatMap((page) => Object.entries(page.views))
          .sort(([left], [right]) => left.localeCompare(right))
      ),
    };
    if (
      body.views === null ||
      typeof body.views !== 'object' ||
      Array.isArray(body.views)
    ) {
      throw new Error('malformed_record: views must be an object');
    }
    const expectedOwner = repo.headRecords.owner;
    let listedOwner = expectedOwner;
    const views: Record<string, string[]> = {};
    for (const [view, head] of Object.entries(body.views)) {
      const verification = verifyHead(head);
      if (!verification.ok) throw verificationError(verification);
      if (head.repo !== name)
        throw new Error('wrong_repo: view is for another repo');
      if (head.view !== view)
        throw new Error('wrong_view: view name does not match');
      listedOwner ??= head.owner;
      if (head.owner !== listedOwner) {
        throw new Error('wrong_owner: listed views have inconsistent owners');
      }
      const pinned = repo.headRecords.current(view);
      if (pinned !== undefined && head.version < pinned.version) {
        throw new Error('rollback: listed view is older than the local pin');
      }
      if (
        pinned !== undefined &&
        head.version === pinned.version &&
        head.id !== pinned.id
      ) {
        throw new Error('fork: listed view conflicts with the local pin');
      }
      if (pinned?.id !== head.id) {
        const detailPages = await this.#collectPages(async (cursor) => {
          const detailResponse = await this.#fetch(
            new Request(
              this.#pageUrl(
                `/repos/${encodeURIComponent(name)}/views/${encodeURIComponent(view)}`,
                cursor === undefined ? {} : { cursor }
              )
            )
          );
          const detail = (await this.#ok(detailResponse)) as HeadResponse & {
            nextCursor?: unknown;
          };
          return {
            ...detail,
            nextCursor: this.#nextCursor(detail.nextCursor),
          };
        });
        const firstDetail = detailPages[0];
        if (firstDetail === undefined) {
          throw new Error('malformed_record: missing view detail');
        }
        const detail: HeadResponse = {
          view: firstDetail.view,
          head: firstDetail.head,
          chain: detailPages.flatMap((page) => [...page.chain]),
        };
        const verified = decodeVerifiedChain(detail, name, view, {
          owner: listedOwner,
          prefix: repo.headRecords.history(view),
        });
        if (verified.head.id !== head.id) {
          throw new ViewSnapshotChangedError();
        }
      }
      views[view] = [...head.heads];
    }
    return views;
  }

  /** Returns one independently consumable page of decoded signed view heads. */
  async listViewsPage(
    name: string,
    options: PageOptions = {}
  ): Promise<ViewsPage> {
    const res = await this.#fetch(
      new Request(
        this.#pageUrl(`/repos/${encodeURIComponent(name)}/views`, options)
      )
    );
    const body = (await this.#ok(res)) as {
      views?: unknown;
      nextCursor?: unknown;
    };
    if (
      body.views === null ||
      typeof body.views !== 'object' ||
      Array.isArray(body.views)
    ) {
      throw new Error('malformed_record: views must be an object');
    }
    const views: Record<string, HeadRecord> = {};
    for (const [view, wire] of Object.entries(body.views)) {
      try {
        views[view] = decodeHeadRecord(wire as HeadRecordWire);
      } catch (error) {
        throw new Error(
          `malformed_record: ${error instanceof Error ? error.message : 'invalid head record'}`
        );
      }
    }
    return {
      views,
      nextCursor: this.#nextCursor(body.nextCursor),
    };
  }

  async getPolicy(name: string): Promise<RepoPolicyRecord> {
    const res = await this.#fetch(
      new Request(`${this.#server}/repos/${encodeURIComponent(name)}/policy`)
    );
    const body = (await this.#ok(res)) as { policy: RepoPolicyRecord };
    return body.policy;
  }

  async setPolicy(
    name: string,
    policy: RepoPolicyRecord
  ): Promise<RepoPolicyRecord> {
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/policy`,
      { policy }
    );
    const body = (await this.#ok(res)) as { policy: RepoPolicyRecord };
    return body.policy;
  }

  async createRelease(
    name: string,
    release: Release,
    claim?: ContributionClaim
  ): Promise<Release> {
    return (await this.createReleaseWithOutcome(name, release, claim)).release;
  }

  async createReleaseWithOutcome(
    name: string,
    release: Release,
    claim?: ContributionClaim
  ): Promise<ReleaseCreationOutcome> {
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/releases`,
      {
        release: encodeRelease(release),
        ...(claim === undefined ? {} : { claim: encodeClaim(claim) }),
      }
    );
    const body = (await this.#ok(res)) as {
      release: string;
      attestations?: AttestationSummary;
    };
    const created = verifiedRelease(body.release, name, release.tag);
    if (created.id !== release.id) {
      throw new Error('server returned a different release record');
    }
    return {
      release: created,
      ...(body.attestations === undefined
        ? {}
        : { attestations: body.attestations }),
    };
  }

  async listReleases(name: string): Promise<Release[]> {
    const pages = await this.#collectPages((cursor) =>
      this.listReleasesPage(name, cursor === undefined ? {} : { cursor })
    );
    const releases: Release[] = [];
    for (const page of pages) releases.push(...page.releases);
    return releases.sort((left, right) => {
      const newestFirst = right.at.localeCompare(left.at);
      return newestFirst !== 0
        ? newestFirst
        : left.tag.localeCompare(right.tag);
    });
  }

  /** Returns one independently consumable page of repository releases. */
  async listReleasesPage(
    name: string,
    options: PageOptions = {}
  ): Promise<ReleasesPage> {
    const res = await this.#fetch(
      new Request(
        this.#pageUrl(`/repos/${encodeURIComponent(name)}/releases`, options)
      )
    );
    const body = (await this.#ok(res)) as {
      releases?: unknown;
      nextCursor?: unknown;
    };
    const releases: Release[] = [];
    if (Array.isArray(body.releases)) {
      for (const wire of body.releases) {
        if (typeof wire !== 'string') continue;
        try {
          releases.push(verifiedRelease(wire, name));
        } catch {
          // A malicious/torn record is never returned as a trusted release.
        }
      }
    }
    return {
      releases,
      nextCursor: this.#nextCursor(body.nextCursor),
    };
  }

  async getRelease(name: string, tag: string): Promise<Release> {
    const res = await this.#fetch(
      new Request(
        `${this.#server}/repos/${encodeURIComponent(name)}/releases/${encodeURIComponent(tag)}`
      )
    );
    const body = (await this.#ok(res)) as { release: string };
    return verifiedRelease(body.release, name, tag);
  }

  // Create a branch at an already-ingested head-set. Creating a branch adds no
  // ops, so no land policy applies; merging it back still goes through `land`.
  async createView(
    name: string,
    repo: Repo,
    view: string,
    heads: readonly string[]
  ): Promise<{ view: string; head: HeadRecord; heads: string[] }> {
    if (
      repo.headRecords.owner !== undefined &&
      repo.headRecords.owner !== this.#identity.did
    ) {
      throw new Error('owner signature required to create a shared view');
    }
    const sortedHeads = [...new Set(heads)].sort();
    const head = signHead(
      {
        repo: name,
        view,
        version: 0,
        previous: null,
        heads: sortedHeads,
      },
      this.#identity
    );
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/views`,
      { head: encodeHeadRecord(head) }
    );
    const body = (await this.#ok(res)) as {
      view: string;
      head: HeadRecordWire;
    };
    const returned = decodeHeadRecord(body.head);
    if (body.view !== view || returned.id !== head.id) {
      throw new Error('server returned a different signed view head');
    }
    await repo.headRecords.bootstrap(returned);
    await repo.log.repoint(view, returned.heads);
    return { view, head: returned, heads: [...returned.heads] };
  }

  async listRepos(): Promise<readonly string[]> {
    const pages = await this.#collectPages((cursor) =>
      this.listReposPage(cursor === undefined ? {} : { cursor })
    );
    return [...new Set(pages.flatMap((page) => [...page.repos]))].sort();
  }

  /** Returns one independently consumable page of repository metadata. */
  async listReposPage(options: PageOptions = {}): Promise<ReposPage> {
    const res = await this.#fetch(
      new Request(this.#pageUrl('/repos', options))
    );
    const body = (await this.#ok(res)) as {
      repos?: unknown;
      owners?: unknown;
      nextCursor?: unknown;
    };
    const repos = Array.isArray(body.repos)
      ? body.repos.filter((name): name is string => typeof name === 'string')
      : [];
    const owners: Record<string, string> = {};
    if (
      body.owners !== null &&
      typeof body.owners === 'object' &&
      !Array.isArray(body.owners)
    ) {
      for (const [name, owner] of Object.entries(body.owners)) {
        if (typeof owner === 'string') owners[name] = owner;
      }
    }
    return {
      repos,
      owners,
      nextCursor: this.#nextCursor(body.nextCursor),
    };
  }

  // Repos with their owner DID (the mirror's GET /repos carries owners). Lets a
  // caller list "repos I own" by filtering on its identity's did.
  async listReposWithOwners(): Promise<
    readonly { name: string; owner: string | null }[]
  > {
    const pages = await this.#collectPages((cursor) =>
      this.listReposPage(cursor === undefined ? {} : { cursor })
    );
    return pages
      .flatMap((page) =>
        page.repos.map((name) => ({
          name,
          owner: page.owners[name] ?? null,
        }))
      )
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  // Delete a repo (owner-only, enforced server-side). Irreversible.
  async deleteRepo(name: string): Promise<void> {
    const path = `/repos/${encodeURIComponent(name)}`;
    const h = signRequest(
      'DELETE',
      path,
      new Uint8Array(),
      this.#identity,
      new Date().toISOString()
    );
    const res = await this.#fetch(
      new Request(`${this.#server}${path}`, {
        method: 'DELETE',
        headers: {
          'x-thaddeus-did': h.did,
          'x-thaddeus-timestamp': h.timestamp,
          'x-thaddeus-nonce': h.nonce,
          'x-thaddeus-signature': h.signature,
        },
      })
    );
    await this.#ok(res);
  }

  // Upload the ops/objects/caps reachable from `heads`. Idempotent — the server
  // re-ingest of existing content is a no-op.
  async push(
    name: string,
    repo: Repo,
    heads: readonly string[],
    provenance: readonly Provenance[] = [],
    symops: readonly SymbolOp[] = []
  ): Promise<PushResult> {
    const { ops, objects, caps } = bundleFor(repo, heads);
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/push`,
      encodeBundle(ops, objects, caps, provenance, [], symops)
    );
    return (await this.#ok(res)) as PushResult;
  }

  // Schedule a committed object's content key for public release. The key is
  // wrapped locally to the well-known public identity; the server receives only
  // the signed capability and validates the current ciphertext id.
  async scheduleReveal(
    name: string,
    store: Store,
    ref: Ref,
    at: string
  ): Promise<ScheduleRevealOutcome> {
    const current = store.current(ref.plaintext_id);
    if (current === undefined) {
      throw new Error(`no object for ${ref.plaintext_id}`);
    }
    const capability = await store.scheduleReveal(ref, at, this.#identity);
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/reveals`,
      { capability: encodeCapability(capability), object: current.id }
    );
    return (await this.#ok(res)) as ScheduleRevealOutcome;
  }

  // Fetch reveal schedules over the owner-authenticated route so a clone other
  // than the one that scheduled them can preserve their start times while
  // rotating keys. The route also returns a schedule concurrently promoted
  // after this clone's pull, closing the pull/sync recall race.
  async syncPendingReveals(
    name: string,
    store: Store,
    plaintextIds: readonly string[]
  ): Promise<number> {
    const requested = new Set(plaintextIds);
    const pages = await this.#collectPages(async (cursor) => {
      const res = await this.#signed(
        'POST',
        `/repos/${encodeURIComponent(name)}/reveals/pending`,
        cursor === undefined ? { objects: [...requested] } : { cursor }
      );
      // Pre-P7 servers do not expose this owner-only route and cannot hold
      // pending reveals, so absence is equivalent to an empty schedule set.
      if (res.status === 404) {
        return { capabilities: [] as string[], nextCursor: null };
      }
      const body = (await this.#ok(res)) as {
        capabilities?: unknown;
        nextCursor?: unknown;
      };
      return {
        capabilities: Array.isArray(body.capabilities)
          ? body.capabilities.filter(
              (wire): wire is string => typeof wire === 'string'
            )
          : [],
        nextCursor: this.#nextCursor(body.nextCursor),
      };
    });
    let ingested = 0;
    const wires = [...new Set(pages.flatMap((page) => page.capabilities))];
    for (const wire of wires) {
      if (typeof wire !== 'string') {
        continue;
      }
      let capability: Capability;
      try {
        capability = decodeCapability(wire);
      } catch {
        continue;
      }
      if (
        !requested.has(capability.object) ||
        capability.granted_by !== this.#identity.did
      ) {
        continue;
      }
      try {
        if (await store.ingestReveal(capability)) {
          ingested += 1;
        }
      } catch {
        // Treat the remote as untrusted: malformed, forged, non-public, or
        // unknown-object capabilities are ignored rather than persisted.
      }
    }
    return ingested;
  }

  // Ask the server to promote a due reveal now. The server uses its own clock,
  // so this cannot release a future-dated capability early.
  async reveal(name: string, store: Store, ref: Ref): Promise<RevealOutcome> {
    const current = store.current(ref.plaintext_id);
    if (current === undefined) {
      throw new Error(`no object for ${ref.plaintext_id}`);
    }
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/reveals/${encodeURIComponent(ref.plaintext_id)}`,
      { object: current.id }
    );
    return (await this.#ok(res)) as RevealOutcome;
  }

  // Push standing vetoes (P10) with no code — a veto-only bundle. The pusher must
  // be an authorized writer (owner or delegate), the same gate as any push: a
  // VERIFIED veto blocks a land, so only writers may lodge one (an unauthenticated
  // veto endpoint would let anyone deny service). Idempotent — re-pushing an
  // identical veto is a server-side no-op.
  async pushVetoes(name: string, vetoes: readonly Veto[]): Promise<PushResult> {
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/push`,
      encodeBundle([], [], [], [], vetoes)
    );
    return (await this.#ok(res)) as PushResult;
  }

  // Land uploaded heads into a target view under the server's policy. A blocked
  // land returns { landed: false, reason } — it is NOT thrown. `contrib` carries
  // subject-signed reputation claims (P07) that an attesting host co-signs for
  // the landed ops.
  async land(
    name: string,
    repo: Repo,
    fromHeads: readonly string[],
    into = 'main',
    contrib: readonly ContributionClaim[] = []
  ): Promise<LandOutcome> {
    const currentResponse = await this.#fetch(
      new Request(
        `${this.#server}/repos/${encodeURIComponent(name)}/views/${encodeURIComponent(into)}`
      )
    );
    const currentBody = (await this.#ok(currentResponse)) as HeadResponse;
    const current = decodeVerifiedChain(currentBody, name, into, {
      owner: repo.headRecords.owner,
      prefix: repo.headRecords.history(into),
    });
    await repo.headRecords.import(current.chain, repo.headRecords.owner);
    if (current.head.owner !== this.#identity.did) {
      throw new Error(
        `owner signature required to land shared heads; uploaded heads: ${fromHeads.join(', ')}`
      );
    }
    const heads = [...new Set([...current.head.heads, ...fromHeads])].sort();
    const signed = signHead(
      {
        repo: name,
        view: into,
        version: current.head.version + 1,
        previous: current.head.id,
        heads,
      },
      this.#identity
    );
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/land`,
      {
        fromHeads: [...fromHeads],
        into,
        contrib: contrib.map(encodeClaim),
        head: encodeHeadRecord(signed),
      }
    );
    const body = (await this.#ok(res)) as Omit<
      LandOutcome,
      'head' | 'heads'
    > & {
      head?: HeadRecordWire;
    };
    if (!body.landed) {
      return {
        landed: false,
        into: body.into,
        heads: [...current.head.heads],
        conflicts: body.conflicts,
        ...(body.reason === undefined ? {} : { reason: body.reason }),
      };
    }
    if (body.head === undefined) {
      throw new Error('land response omitted the signed head record');
    }
    const returned = decodeHeadRecord(body.head);
    if (returned.id !== signed.id) {
      throw new Error('server returned a different head than the owner signed');
    }
    await repo.headRecords.advance(returned);
    return { ...body, head: returned, heads: [...returned.heads] };
  }

  async bootstrapHead(
    name: string,
    repo: Repo,
    view: string,
    heads: readonly string[]
  ): Promise<HeadRecord> {
    if (repo.headRecords.current(view) !== undefined) {
      throw new Error(`signed head history already exists for ${view}`);
    }
    if (
      repo.headRecords.owner !== undefined &&
      repo.headRecords.owner !== this.#identity.did
    ) {
      throw new Error('owner signature required to bootstrap a shared head');
    }
    const signed = signHead(
      {
        repo: name,
        view,
        version: 0,
        previous: null,
        heads: [...new Set(heads)].sort(),
      },
      this.#identity
    );
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/heads/bootstrap`,
      { head: encodeHeadRecord(signed) }
    );
    const body = (await this.#ok(res)) as { head: HeadRecordWire };
    const returned = decodeHeadRecord(body.head);
    if (returned.id !== signed.id) {
      throw new Error('server returned a different bootstrap head');
    }
    await repo.headRecords.bootstrap(returned);
    return returned;
  }

  // A subject's server-wide reputation profile (P07). Public read — no signature.
  async reputation(did: string): Promise<ReputationProfile> {
    const res = await this.#fetch(
      new Request(`${this.#server}/reputation/${encodeURIComponent(did)}`)
    );
    return (await this.#ok(res)) as ReputationProfile;
  }

  // Public export of a subject's complete dual-signed contribution set.
  async exportReputation(did: string): Promise<ReputationArchive> {
    const pages = await this.#collectPages((cursor) =>
      this.exportReputationPage(did, cursor === undefined ? {} : { cursor })
    );
    return decodeReputationArchive(
      encodeReputationArchive({
        format: pages[0]?.archive.format ?? 'thaddeus.reputation.v1',
        subject: did,
        contributions: pages.flatMap((page) => [...page.archive.contributions]),
      })
    );
  }

  /** Returns one independently consumable reputation archive page. */
  async exportReputationPage(
    did: string,
    options: PageOptions = {}
  ): Promise<ReputationExportPage> {
    const res = await this.#fetch(
      new Request(
        this.#pageUrl(`/reputation/${encodeURIComponent(did)}/export`, options)
      )
    );
    const body = (await this.#ok(res)) as {
      archive?: unknown;
      nextCursor?: unknown;
    };
    if (typeof body.archive !== 'string') {
      throw new Error('malformed reputation archive page');
    }
    return {
      archive: decodeReputationArchive(body.archive),
      nextCursor: this.#nextCursor(body.nextCursor),
    };
  }

  // Signed, subject-authorized import. The destination independently verifies
  // the archive before making its one-write durable merge.
  async importReputation(
    archive: ReputationArchive
  ): Promise<ReputationImportOutcome> {
    const normalized = decodeReputationArchive(
      encodeReputationArchive(archive)
    );
    let maxBytes = DEFAULT_MAX_REPUTATION_ARCHIVE_BYTES;
    let maxContributions = DEFAULT_MAX_REPUTATION_CONTRIBUTIONS;
    let offset = 0;
    let imported = 0;
    let duplicates = 0;
    let total = 0;
    let sentEmpty = false;
    while (offset < normalized.contributions.length || !sentEmpty) {
      const remaining = normalized.contributions.slice(offset);
      const chunk = this.#reputationImportChunk(
        normalized.subject,
        remaining,
        maxBytes,
        maxContributions
      );
      try {
        const res = await this.#signed('POST', '/reputation/import', {
          archive: encodeReputationArchive(chunk),
        });
        const outcome = (await this.#ok(res)) as ReputationImportOutcome;
        imported += outcome.imported;
        duplicates += outcome.duplicates;
        total = outcome.total;
        offset += chunk.contributions.length;
        sentEmpty = true;
      } catch (error) {
        if (!(error instanceof ClientResponseError)) throw error;
        if (error.code === 'field_too_large') throw error;
        const key =
          error.code === 'archive_too_large'
            ? 'maxBytes'
            : error.code === 'contribution_limit_exceeded'
              ? 'maxContributions'
              : undefined;
        if (key === undefined) throw error;
        const proposed = error.details[key];
        if (
          typeof proposed !== 'number' ||
          !Number.isSafeInteger(proposed) ||
          proposed <= 0 ||
          (key === 'maxBytes'
            ? proposed >= maxBytes
            : proposed >= maxContributions)
        ) {
          throw error;
        }
        if (key === 'maxBytes') maxBytes = proposed;
        else maxContributions = proposed;
      }
      if (normalized.contributions.length === 0) break;
    }
    return {
      subject: normalized.subject,
      imported,
      duplicates,
      total,
    };
  }

  // Owner: register an owner-signed delegation granting `delegation.agent` push.
  async grant(
    name: string,
    delegation: Delegation
  ): Promise<{
    agent: string;
    paths: string[];
    maxChanges: number;
    maxSpend: number;
  }> {
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/grants`,
      {
        delegation: encodeDelegation(delegation),
      }
    );
    return (await this.#ok(res)) as {
      agent: string;
      paths: string[];
      maxChanges: number;
      maxSpend: number;
    };
  }

  // Owner: revoke a delegate (terminal).
  async revoke(
    name: string,
    agent: string,
    recall?: { repo: Repo; heads: readonly string[] }
  ): Promise<RevokeOutcome> {
    const body: { agent: string; recall?: ReturnType<typeof encodeBundle> } = {
      agent,
    };
    if (recall !== undefined) {
      const pids = reachablePids(recall.repo, recall.heads);
      const objects: EncryptedObject[] = [];
      const caps: Capability[] = [];
      const pending: Capability[] = [];
      for (const pid of pids) {
        const current = recall.repo.store.current(pid);
        if (current === undefined) {
          continue;
        }
        objects.push(current);
        caps.push(...recall.repo.store.caps(pid));
        pending.push(...recall.repo.store.pendingReveals(pid));
      }
      body.recall = encodeBundle([], objects, caps, [], [], [], pending);
    }
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/revoke`,
      body
    );
    return (await this.#ok(res)) as RevokeOutcome;
  }

  // The repo's active (non-revoked) delegations — a public, verifiable list.
  async listGrants(name: string): Promise<Delegation[]> {
    const pages = await this.#collectPages((cursor) =>
      this.listGrantsPage(name, cursor === undefined ? {} : { cursor })
    );
    return pages
      .flatMap((page) => [...page.grants])
      .sort((left, right) => left.agent.localeCompare(right.agent));
  }

  /** Returns one independently consumable page of active delegations. */
  async listGrantsPage(
    name: string,
    options: PageOptions = {}
  ): Promise<GrantsPage> {
    const res = await this.#fetch(
      new Request(
        this.#pageUrl(`/repos/${encodeURIComponent(name)}/grants`, options)
      )
    );
    const body = (await this.#ok(res)) as {
      grants?: unknown;
      nextCursor?: unknown;
    };
    // Decode each entry defensively: a single malformed grant must not crash the
    // caller, so failures are skipped rather than thrown.
    const out: Delegation[] = [];
    for (const g of Array.isArray(body.grants) ? body.grants : []) {
      if (typeof g !== 'string') continue;
      try {
        out.push(decodeDelegation(g));
      } catch {
        // skip a malformed wire delegation
      }
    }
    return {
      grants: out,
      nextCursor: this.#nextCursor(body.nextCursor),
    };
  }

  /** Collects and deduplicates an untrusted pull before any local mutation. */
  async #pullResponse(
    name: string,
    view: string
  ): Promise<HeadResponse & Parameters<typeof decodeBundle>[0]> {
    type PullPage = HeadResponse &
      Parameters<typeof decodeBundle>[0] & { nextCursor: string | null };
    const pages = await this.#collectPages<PullPage>(async (cursor) => {
      const path = `/repos/${encodeURIComponent(name)}/pull`;
      const url = new URL(`${this.#server}${path}`);
      url.searchParams.set('view', view);
      if (cursor !== undefined) url.searchParams.set('cursor', cursor);
      const response = await this.#fetch(new Request(url.toString()));
      const body = (await this.#ok(response)) as HeadResponse &
        Parameters<typeof decodeBundle>[0] & { nextCursor?: unknown };
      return { ...body, nextCursor: this.#nextCursor(body.nextCursor) };
    });
    const first = pages[0];
    if (first === undefined)
      throw new Error('malformed_record: missing pull page');
    const unique = (
      field: keyof Parameters<typeof decodeBundle>[0]
    ): string[] => [...new Set(pages.flatMap((page) => page[field] ?? []))];
    return {
      view: first.view,
      head: first.head,
      chain: [
        ...new Map(
          pages
            .flatMap((page) => [...page.chain])
            .map((record) => [record.id, record] as const)
        ).values(),
      ],
      ops: unique('ops'),
      objects: unique('objects'),
      caps: unique('caps'),
      prov: unique('prov'),
      veto: unique('veto'),
      symop: unique('symop'),
    };
  }

  /** Chooses the largest portable import chunk that fits both public caps. */
  #reputationImportChunk(
    subject: string,
    remaining: ReadonlyArray<ReputationArchive['contributions'][number]>,
    maxBytes: number,
    maxContributions: number
  ): ReputationArchive {
    const archive = (count: number): ReputationArchive => ({
      format: 'thaddeus.reputation.v1',
      subject,
      contributions: remaining.slice(0, count),
    });
    if (remaining.length === 0) return archive(0);
    let low = 1;
    let high = Math.min(remaining.length, maxContributions);
    let best = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const bytes = new TextEncoder().encode(
        encodeReputationArchive(archive(middle))
      ).length;
      if (bytes <= maxBytes) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    // Sending the irreducible record lets the destination return its stable
    // field/archive limit error; the client never loops without progress.
    return archive(Math.max(1, best));
  }

  /** Traverses rotating cursors with bounded retries and loop defenses. */
  async #collectPages<T extends { readonly nextCursor: string | null }>(
    load: (cursor: string | undefined) => Promise<T>
  ): Promise<T[]> {
    for (let attempt = 0; ; attempt += 1) {
      const pages: T[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      try {
        while (true) {
          const page = await load(cursor);
          pages.push(page);
          const next = page.nextCursor;
          if (next === null) return pages;
          if (seen.has(next)) {
            throw new Error('pagination cursor repeated');
          }
          seen.add(next);
          if (pages.length >= 10_000) {
            throw new Error('pagination page limit exceeded');
          }
          cursor = next;
        }
      } catch (error) {
        const retryable =
          error instanceof ClientResponseError &&
          (error.code === 'pagination_snapshot_changed' ||
            error.code === 'pagination_cursor_invalid');
        if (!retryable || attempt >= 2) throw error;
      }
    }
  }

  #pageUrl(path: string, options: PageOptions): string {
    const url = new URL(`${this.#server}${path}`);
    if (options.limit !== undefined) {
      url.searchParams.set('limit', String(options.limit));
    }
    if (options.cursor !== undefined) {
      url.searchParams.set('cursor', options.cursor);
    }
    return url.toString();
  }

  #nextCursor(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('malformed pagination cursor');
    }
    return value;
  }

  // POST a JSON body with the signed-request envelope.
  async #signed(
    method: string,
    path: string,
    bodyObj: unknown
  ): Promise<Response> {
    const body = new TextEncoder().encode(JSON.stringify(bodyObj));
    const h = signRequest(
      method,
      path,
      body,
      this.#identity,
      new Date().toISOString()
    );
    // Construct a Request so both global fetch and the injected server handler
    // receive an object with a parseable .url property.
    return this.#fetch(
      new Request(`${this.#server}${path}`, {
        method,
        body,
        headers: {
          'content-type': 'application/json',
          'x-thaddeus-did': h.did,
          'x-thaddeus-timestamp': h.timestamp,
          'x-thaddeus-nonce': h.nonce,
          'x-thaddeus-signature': h.signature,
        },
      })
    );
  }

  // Parse a JSON response; throw a useful Error on a non-2xx status.
  // JSON.parse is attempted first (in a try/catch) so a plain-text/HTML error
  // body does not throw SyntaxError and hide the real failure.
  async #ok(res: Response): Promise<unknown> {
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const details =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      const msg =
        parsed !== null &&
        parsed !== undefined &&
        typeof parsed === 'object' &&
        'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : text.length > 0
            ? text.slice(0, 200)
            : `request failed: ${res.status}`;
      throw new ClientResponseError(msg, res.status, details);
    }
    return parsed ?? {};
  }
}
