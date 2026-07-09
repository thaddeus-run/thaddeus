import type { Delegation } from '@thaddeus.run/agent';
import { type SymbolOp, SymbolOpLog } from '@thaddeus.run/graph';
import type { Identity } from '@thaddeus.run/identity';
import type { Conflict } from '@thaddeus.run/log';
import { Platform, type Repo } from '@thaddeus.run/platform';
import { type Provenance, ProvenanceLog } from '@thaddeus.run/provenance';
import type { ContributionClaim } from '@thaddeus.run/reputation';
import { type Veto, VetoLog } from '@thaddeus.run/review';
import {
  decodeBundle,
  decodeDelegation,
  encodeBundle,
  encodeClaim,
  encodeDelegation,
  type RepoPolicyRecord,
  signRequest,
} from '@thaddeus.run/server';
import {
  type Backend,
  type Capability,
  type EncryptedObject,
  scoped,
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
  };
  rejected: { kind: string; id: string; reason: string }[];
}

export interface RevokeOutcome {
  agent: string;
  revoked: boolean;
  recalled?: PushResult;
}

export interface LandOutcome {
  landed: boolean;
  into: string;
  heads: string[];
  conflicts: Conflict[];
  reason?: string;
}

// A subject's server-wide reputation profile (P07): counts of attested
// (host-vouched) vs claimed (self-asserted) contributions, plus the attested
// tally by kind.
export interface ReputationProfile {
  subject: string;
  attested: number;
  claimed: number;
  byKind: Record<string, number>;
}

// FetchLike matches the server's fetch(req: Request) shape. The client always
// constructs a Request before calling fetchImpl, so the narrower signature is
// compatible with both the injected server handler and the global fetch.
type FetchLike = (req: Request) => Promise<Response>;

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
    const res = await this.#signed('POST', '/repos', { name });
    return (await this.#ok(res)) as { name: string; owner: string };
  }

  // Pull a view's reachable bundle in a single atomic request. The /pull
  // response now includes view+heads alongside ops/objects/caps, so we no
  // longer need a separate /views call (closes the PR #12 clone TOCTOU).
  async clone(
    name: string,
    backend: Backend,
    view = 'main'
  ): Promise<{
    repo: Repo;
    heads: readonly string[];
    provenance: ProvenanceLog;
    vetoes: VetoLog;
    symbols: SymbolOpLog;
  }> {
    const enc = encodeURIComponent;
    const res = await this.#fetch(
      new Request(`${this.#server}/repos/${enc(name)}/pull?view=${enc(view)}`)
    );
    const body = (await this.#ok(res)) as { heads: string[] } & Parameters<
      typeof decodeBundle
    >[0];
    const bundle = decodeBundle(body);

    const repo = await new Platform().openDurable(name, backend);
    for (const object of bundle.objects) {
      await repo.store.ingest(
        object,
        bundle.caps.filter((c) => c.object === object.plaintext_id)
      );
    }
    for (const op of bundle.ops) {
      await repo.log.ingest(op);
    }
    await repo.log.repoint(view, body.heads);
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
    return { repo, heads: body.heads, provenance, vetoes, symbols };
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
    const body = (await this.#ok(res)) as { heads: string[] } & Parameters<
      typeof decodeBundle
    >[0];
    const bundle = decodeBundle(body);
    for (const object of bundle.objects) {
      await repo.store.ingest(
        object,
        bundle.caps.filter((c) => c.object === object.plaintext_id)
      );
    }
    for (const op of bundle.ops) {
      await repo.log.ingest(op);
    }
    await repo.log.repoint(targetView, body.heads);
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
    return { heads: body.heads, provenance, vetoes, symbols };
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

  // The repo's branches and their heads. A branch is a name over a head-set, so
  // this is cheap and never touches content. Public read, like the rest.
  async listViews(name: string): Promise<Record<string, string[]>> {
    const res = await this.#fetch(
      new Request(`${this.#server}/repos/${encodeURIComponent(name)}/views`)
    );
    const body = (await this.#ok(res)) as { views: Record<string, string[]> };
    return body.views;
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

  // Create a branch at an already-ingested head-set. Creating a branch adds no
  // ops, so no land policy applies; merging it back still goes through `land`.
  async createView(
    name: string,
    view: string,
    heads: readonly string[]
  ): Promise<{ view: string; heads: string[] }> {
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/views`,
      { view, heads: [...heads] }
    );
    return (await this.#ok(res)) as { view: string; heads: string[] };
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
    fromHeads: readonly string[],
    into = 'main',
    contrib: readonly ContributionClaim[] = []
  ): Promise<LandOutcome> {
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/land`,
      { fromHeads: [...fromHeads], into, contrib: contrib.map(encodeClaim) }
    );
    return (await this.#ok(res)) as LandOutcome;
  }

  // A subject's server-wide reputation profile (P07). Public read — no signature.
  async reputation(did: string): Promise<ReputationProfile> {
    const res = await this.#fetch(
      new Request(`${this.#server}/reputation/${encodeURIComponent(did)}`)
    );
    return (await this.#ok(res)) as ReputationProfile;
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
      for (const pid of pids) {
        const current = recall.repo.store.current(pid);
        if (current === undefined) {
          continue;
        }
        objects.push(current);
        caps.push(...recall.repo.store.caps(pid));
      }
      body.recall = encodeBundle([], objects, caps);
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
