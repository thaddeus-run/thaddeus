import type { Delegation } from '@thaddeus.run/agent';
import { type SymbolOp, SymbolOpLog } from '@thaddeus.run/graph';
import type { Identity } from '@thaddeus.run/identity';
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

// A small client over the Thaddeus HTTP remote. Holds one Identity, signs every
// write request, and does all crypto client-side. `fetchImpl` is injectable so
// tests pass createServer(...).fetch directly (no port).
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

  // Pull a view's reachable bundle in a single atomic request. The /pull
  // response now includes view+heads alongside ops/objects/caps, so we no
  // longer need a separate /views call (closes the PR #12 clone TOCTOU).
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
    const enc = encodeURIComponent;
    const res = await this.#fetch(
      new Request(`${this.#server}/repos/${enc(name)}/pull?view=${enc(view)}`)
    );
    const body = (await this.#ok(res)) as HeadResponse &
      Parameters<typeof decodeBundle>[0];
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
    const enc = encodeURIComponent;
    const res = await this.#fetch(
      new Request(
        `${this.#server}/repos/${enc(name)}/pull?view=${enc(remoteView)}`
      )
    );
    const body = (await this.#ok(res)) as HeadResponse &
      Parameters<typeof decodeBundle>[0];
    const verified = decodeVerifiedChain(body, name, remoteView, {
      owner: repo.headRecords.owner,
      prefix: repo.headRecords.history(remoteView),
    });
    const bundle = decodeBundle(body);
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

  // The repo's collaborators: its owner plus every non-revoked delegate (the
  // server filters revoked agents out of /grants). Every member is a did:key, so
  // a caller derives each member's public key with `PublicIdentity.fromDid` —
  // no key exchange is needed to share a decryption capability with them.
  async members(name: string): Promise<string[]> {
    // The two reads are independent, so issue them concurrently — `push` calls
    // this on every publish and a serial pair doubles the round-trip latency.
    const [repos, grants] = await Promise.all([
      this.listReposWithOwners(),
      this.listGrants(name),
    ]);
    const owner = repos.find((r) => r.name === name)?.owner;
    const delegates = grants.map((g) => g.agent);
    const dids =
      owner === null || owner === undefined ? delegates : [owner, ...delegates];
    return [...new Set(dids)].sort();
  }

  // The repo's branches and their heads. Listing does not ingest content or
  // mutate trust, but newer records fetch their complete chain for validation.
  async listViews(name: string, repo: Repo): Promise<Record<string, string[]>> {
    const res = await this.#fetch(
      new Request(`${this.#server}/repos/${encodeURIComponent(name)}/views`)
    );
    const body = (await this.#ok(res)) as {
      views: Record<string, HeadRecordWire>;
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
    for (const [view, wire] of Object.entries(body.views)) {
      let head: HeadRecord;
      try {
        head = decodeHeadRecord(wire);
      } catch (error) {
        throw new Error(
          `malformed_record: ${error instanceof Error ? error.message : 'invalid head record'}`
        );
      }
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
        const detailResponse = await this.#fetch(
          new Request(
            `${this.#server}/repos/${encodeURIComponent(name)}/views/${encodeURIComponent(view)}`
          )
        );
        const detail = (await this.#ok(detailResponse)) as HeadResponse;
        const verified = decodeVerifiedChain(detail, name, view, {
          owner: listedOwner,
          prefix: repo.headRecords.history(view),
        });
        if (verified.head.id !== head.id) {
          throw new Error(
            'fork: listed view does not match its signed head chain'
          );
        }
      }
      views[view] = [...head.heads];
    }
    return views;
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
    const res = await this.#fetch(
      new Request(`${this.#server}/repos/${encodeURIComponent(name)}/releases`)
    );
    const body = (await this.#ok(res)) as { releases: string[] };
    const releases: Release[] = [];
    for (const wire of body.releases) {
      try {
        releases.push(verifiedRelease(wire, name));
      } catch {
        // A malicious/torn record is never returned as a trusted release.
      }
    }
    return releases;
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
    // Pass a Request object so both the global fetch and an injected server
    // handler (which calls new URL(req.url)) receive a well-formed input.
    const res = await this.#fetch(new Request(`${this.#server}/repos`));
    const body = (await this.#ok(res)) as { repos: string[] };
    return body.repos;
  }

  // Repos with their owner DID (the mirror's GET /repos carries owners). Lets a
  // caller list "repos I own" by filtering on its identity's did.
  async listReposWithOwners(): Promise<
    readonly { name: string; owner: string | null }[]
  > {
    const res = await this.#fetch(new Request(`${this.#server}/repos`));
    const body = (await this.#ok(res)) as {
      repos: string[];
      owners?: Record<string, string>;
    };
    return body.repos.map((name) => ({
      name,
      owner: body.owners?.[name] ?? null,
    }));
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
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/reveals/pending`,
      { objects: [...requested] }
    );
    // Pre-P7 servers do not expose this owner-only route and cannot hold
    // pending reveals, so absence is equivalent to an empty schedule set.
    if (res.status === 404) {
      return 0;
    }
    const body = (await this.#ok(res)) as { capabilities: string[] };
    let ingested = 0;
    const wires = Array.isArray(body.capabilities) ? body.capabilities : [];
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
    const res = await this.#fetch(
      new Request(
        `${this.#server}/reputation/${encodeURIComponent(did)}/export`
      )
    );
    const body = (await this.#ok(res)) as { archive: string };
    return decodeReputationArchive(body.archive);
  }

  // Signed, subject-authorized import. The destination independently verifies
  // the archive before making its one-write durable merge.
  async importReputation(
    archive: ReputationArchive
  ): Promise<ReputationImportOutcome> {
    const res = await this.#signed('POST', '/reputation/import', {
      archive: encodeReputationArchive(archive),
    });
    return (await this.#ok(res)) as ReputationImportOutcome;
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
    const res = await this.#fetch(
      new Request(`${this.#server}/repos/${encodeURIComponent(name)}/grants`)
    );
    const body = (await this.#ok(res)) as { grants: string[] };
    // Decode each entry defensively: a single malformed grant must not crash the
    // caller, so failures are skipped rather than thrown.
    const out: Delegation[] = [];
    for (const g of body.grants) {
      try {
        out.push(decodeDelegation(g));
      } catch {
        // skip a malformed wire delegation
      }
    }
    return out;
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
      const msg =
        parsed !== null &&
        parsed !== undefined &&
        typeof parsed === 'object' &&
        'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : text.length > 0
            ? text.slice(0, 200)
            : `request failed: ${res.status}`;
      throw new Error(msg);
    }
    return parsed ?? {};
  }
}
