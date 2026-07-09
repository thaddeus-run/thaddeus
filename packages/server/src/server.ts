import {
  AgentRegistry,
  type Delegation,
  delegationPolicy,
  verifyDelegation,
} from '@thaddeus.run/agent';
import { SymbolOpLog } from '@thaddeus.run/graph';
import { type Identity, PublicIdentity } from '@thaddeus.run/identity';
import type { Op } from '@thaddeus.run/log';
import {
  blockOnConflict,
  blockOnVeto,
  INTERNAL_VIEW_PREFIX,
  type LandPolicy,
  Platform,
  type Repo,
  requireReputationTier,
} from '@thaddeus.run/platform';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import {
  attest,
  type ContributionClaim,
  ReputationLog,
  verifyClaim,
} from '@thaddeus.run/reputation';
import { VetoLog } from '@thaddeus.run/review';
import {
  type Backend,
  type Capability,
  decodeRecord,
  encodeRecord,
  scoped,
  verifyCapability,
} from '@thaddeus.run/store';

import {
  decodeBundle,
  decodeClaim,
  decodeDelegation,
  encodeBundle,
  encodeDelegation,
} from './dto';
import { type SignedHeaders, verifyRequest } from './sign';

// Parse a JSON request body, returning undefined on malformed input (so a handler
// can answer 400 rather than throwing a 500). Used by every body-parsing handler.
function safeParseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

// Decode a percent-encoded path segment, returning undefined on a malformed
// escape sequence (e.g. %E0%A4%A) rather than throwing. Callers respond 400.
function safeDecode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

export interface ServerConfig {
  backend: Backend;
  policy?: LandPolicy;
  now?: () => string;
  // An optional host identity turns this into an ATTESTING instance: on a
  // successful land it co-signs each client-pushed reputation claim (P07) for a
  // landed op, minting a host-vouched Contribution. Without it, the server holds
  // no keys and reputation does not accrue.
  host?: Identity;
  // When set, land is additionally gated on durable server-wide reputation:
  // every incoming op's author must have at least this many ATTESTED merges.
  minMerges?: number;
}

export interface Server {
  fetch(req: Request): Promise<Response>;
}

interface RepoMeta {
  owner: string;
}

// Every op reachable from `heads` by walking parents (inclusive), in
// (lamport, id) order.
function reachableOps(all: readonly Op[], heads: readonly string[]): Op[] {
  const byId = new Map(all.map((o) => [o.id, o]));
  const seen = new Set<string>();
  const stack = [...heads];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const op = byId.get(id);
    if (op !== undefined) {
      stack.push(...op.parents);
    }
  }
  return all
    .filter((o) => seen.has(o.id))
    .sort((x, y) =>
      x.lamport !== y.lamport ? x.lamport - y.lamport : x.id < y.id ? -1 : 1
    );
}

// Compose LandPolicies: allow only if every policy allows; the first rejection
// (with its reason) wins. Each policy is awaited since policies may be async.
function all(...policies: LandPolicy[]): LandPolicy {
  return async (p) => {
    for (const policy of policies) {
      const decision = await policy(p);
      if (!decision.allow) {
        return decision;
      }
    }
    return { allow: true };
  };
}

// Merge two capability sets for one object, deduped by the fields a capability's
// signature binds plus its granter — two caps with the same
// (grantee, granted_by, not_before) are the same grant, so one copy suffices.
// Used to keep a concurrent push from dropping a just-issued grant.
function unionCaps(
  existing: readonly Capability[],
  incoming: readonly Capability[]
): Capability[] {
  const out: Capability[] = [];
  const seen = new Set<string>();
  for (const cap of [...existing, ...incoming]) {
    const key = `${cap.grantee}\n${cap.granted_by}\n${cap.not_before}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(cap);
    }
  }
  return out;
}

// A Bun.serve-compatible handler over a durable Platform. No keys; verifies and
// serves ciphertext. Per-node state is just the opened-Repo cache + per-repo
// mutation lock, both rebuildable from the backend.
export function createServer(config: ServerConfig): Server {
  const platform = new Platform();
  const policy = config.policy ?? blockOnConflict;
  const now = config.now ?? ((): string => new Date().toISOString());
  const repoCache = new Map<string, Repo>();
  // Per-repo promise chain: each mutation awaits the previous, so a land's
  // read-heads -> re-point can't interleave with a concurrent push.
  const locks = new Map<string, Promise<unknown>>();
  const metaBackend = (name: string): Backend =>
    scoped(config.backend, `repo/${name}/`);

  async function readMeta(name: string): Promise<RepoMeta | undefined> {
    const bytes = await metaBackend(name).get('meta/repo');
    return bytes === undefined ? undefined : (decodeRecord(bytes) as RepoMeta);
  }

  // Durable per-repo AgentRegistry cache, keyed by the in-flight BUILD promise
  // (not the resolved registry) so registryFor is single-flight: two concurrent
  // cold-cache callers share ONE AgentRegistry instance, mutated in place. If we
  // cached the resolved value instead, both callers would build separate
  // registries and the last `set` would clobber a grant/revoke on the other.
  const registries = new Map<string, Promise<AgentRegistry>>();

  // Single-flight cacher: store the build promise synchronously (before any
  // await) so a second caller in the same tick reuses it. Callers already
  // `await registryFor(name)`, so they all share the one instance.
  function registryFor(name: string): Promise<AgentRegistry> {
    let p = registries.get(name);
    if (p === undefined) {
      // Evict a REJECTED build so a transient load error self-heals on the next
      // request instead of poisoning the repo until restart (the success promise
      // stays cached for single-flight).
      p = buildRegistry(name).catch((e: unknown) => {
        registries.delete(name);
        throw e;
      });
      registries.set(name, p);
    }
    return p;
  }

  // Durable per-repo ProvenanceLog cache — the "why" (P04) alongside the code.
  // Single-flight like registries so concurrent callers share one instance.
  const provenances = new Map<string, Promise<ProvenanceLog>>();

  async function buildProvenance(name: string): Promise<ProvenanceLog> {
    const repo = await getRepo(name);
    if (repo === undefined) {
      throw new Error(`no repo ${name}`);
    }
    return ProvenanceLog.load(repo.store, metaBackend(name));
  }

  function provenanceFor(name: string): Promise<ProvenanceLog> {
    let p = provenances.get(name);
    if (p === undefined) {
      // Evict a REJECTED load so a transient backend error self-heals next call
      // rather than caching the failure forever (same fix as registryFor).
      p = buildProvenance(name).catch((e: unknown) => {
        provenances.delete(name);
        throw e;
      });
      provenances.set(name, p);
    }
    return p;
  }

  // Durable per-repo VetoLog cache — the standing human "no" (P10) alongside the
  // code. Single-flight like provenances so concurrent callers share one
  // instance; store-free (a veto carries no capability-gated payload).
  const vetoes = new Map<string, Promise<VetoLog>>();

  function vetoFor(name: string): Promise<VetoLog> {
    let p = vetoes.get(name);
    if (p === undefined) {
      // Evict a REJECTED load so a transient backend error self-heals next call.
      p = VetoLog.load(metaBackend(name)).catch((e: unknown) => {
        vetoes.delete(name);
        throw e;
      });
      vetoes.set(name, p);
    }
    return p;
  }

  // Durable per-repo SymbolOpLog cache — the signed semantic-graph ops (P08)
  // alongside the code. Single-flight + evict-on-reject like vetoFor.
  const symops = new Map<string, Promise<SymbolOpLog>>();

  function symopFor(name: string): Promise<SymbolOpLog> {
    let p = symops.get(name);
    if (p === undefined) {
      p = SymbolOpLog.load(metaBackend(name)).catch((e: unknown) => {
        symops.delete(name);
        throw e;
      });
      symops.set(name, p);
    }
    return p;
  }

  // The durable server-wide ReputationLog (P07). Reputation spans repos, so it is
  // held ONCE over the un-scoped backend (top-level `rep/` prefix), not a per-repo
  // scope. Single-flight so concurrent callers share one instance; evict a
  // rejected load so a transient backend error self-heals.
  let reputationPromise: Promise<ReputationLog> | undefined;
  function reputationLog(): Promise<ReputationLog> {
    reputationPromise ??= ReputationLog.load(config.backend).catch(
      (e: unknown) => {
        reputationPromise = undefined;
        throw e;
      }
    );
    return reputationPromise;
  }

  // Build the durable AgentRegistry for a repo: register every persisted grant,
  // replay the persisted meters, then apply revocations. Load order matters —
  // record() throws for an unregistered agent, so grants must be registered
  // before their meters replay; revocations apply last.
  async function buildRegistry(name: string): Promise<AgentRegistry> {
    const reg = new AgentRegistry();
    const b = metaBackend(name);
    for (const key of await b.list('grant/')) {
      const bytes = await b.get(key);
      if (bytes !== undefined) {
        try {
          reg.register(decodeRecord(bytes) as Delegation);
        } catch {
          // skip a corrupt/invalid persisted grant
        }
      }
    }
    for (const key of await b.list('meter/')) {
      const bytes = await b.get(key);
      if (bytes !== undefined) {
        const agent = key.slice('meter/'.length);
        const m = decodeRecord(bytes) as { changes: number; spend: number };
        try {
          reg.record(agent, m.changes, m.spend);
        } catch {
          // a meter for an agent with no grant — skip
        }
      }
    }
    for (const key of await b.list('revoked/')) {
      reg.revoke(key.slice('revoked/'.length));
    }
    return reg;
  }

  async function getRepo(name: string): Promise<Repo | undefined> {
    const cached = repoCache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    if ((await readMeta(name)) === undefined) {
      return undefined; // unknown repo
    }
    const repo = await platform.openDurable(name, config.backend);
    repoCache.set(name, repo);
    return repo;
  }

  // Serialize mutations per repo.
  function withRepoLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(name) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(
      name,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  function headers(req: Request): SignedHeaders | null {
    const did = req.headers.get('x-thaddeus-did');
    const timestamp = req.headers.get('x-thaddeus-timestamp');
    const signature = req.headers.get('x-thaddeus-signature');
    if (did === null || timestamp === null || signature === null) {
      return null;
    }
    return { did, timestamp, signature };
  }

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  async function createRepo(req: Request, body: Uint8Array): Promise<Response> {
    const signer = verifyRequest(
      'POST',
      '/repos',
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer === null) {
      return json(401, { error: 'unsigned or invalid request' });
    }
    // Signature verification is read-only and can stay outside the lock.
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const { name } = parsed as { name: string };
    if (typeof name !== 'string' || name.length === 0) {
      return json(400, { error: 'missing repo name' });
    }
    // Wrap the existence-check-through-write in the per-repo lock so two
    // concurrent creates for the same name cannot both pass the existence check
    // (TOCTOU). The second request sees the meta written by the first → 409.
    return withRepoLock(name, async () => {
      if ((await readMeta(name)) !== undefined) {
        return json(409, { error: `repo ${name} already exists` });
      }
      await metaBackend(name).put('meta/repo', encodeRecord({ owner: signer }));
      const repo = await platform.createDurable(name, config.backend);
      repoCache.set(name, repo);
      return json(201, { name, owner: signer });
    });
  }

  async function listRepos(): Promise<Response> {
    // Repos are the `meta/repo` keys across the backend: list `repo/*/meta/repo`.
    const keys = await config.backend.list('repo/');
    const names = keys
      .filter((k) => k.endsWith('/meta/repo'))
      .map((k) => k.slice('repo/'.length, -'/meta/repo'.length))
      .sort();
    // Include each repo's owner DID so a client can list "repos I own" without a
    // second round-trip. Owners are already public on the mirror (they sign
    // every op), so this leaks nothing new.
    const owners: Record<string, string> = {};
    for (const name of names) {
      const meta = await readMeta(name);
      if (meta !== undefined) {
        owners[name] = meta.owner;
      }
    }
    return json(200, { repos: names, owners });
  }

  // DELETE /repos/:name — owner-only. Drops every backend key under the repo's
  // scope and evicts its per-repo caches. Irreversible (no GC/undo yet). The
  // server-wide ReputationLog (top-level `rep/`) spans repos and is NOT removed.
  async function deleteRepo(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = verifyRequest(
      'DELETE',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer === null) {
      return json(401, { error: 'unsigned or invalid request' });
    }
    return withRepoLock(name, async () => {
      const meta = await readMeta(name);
      if (meta === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      if (signer !== meta.owner) {
        return json(403, { error: 'not the repo owner' });
      }
      const b = metaBackend(name);
      for (const key of await b.list('')) {
        await b.delete(key);
      }
      repoCache.delete(name);
      registries.delete(name);
      provenances.delete(name);
      vetoes.delete(name);
      symops.delete(name);
      return json(200, { deleted: name });
    });
  }

  // Returns the heads of a named view for a repo; 404 if the repo doesn't exist.
  async function getView(name: string, view: string): Promise<Response> {
    const repo = await getRepo(name);
    if (repo === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    return json(200, { view, heads: [...repo.log.heads(view)] });
  }

  // GET /repos/:name/views — the repo's branches and their heads. A public read,
  // like the rest of the mirror: head ids are already public.
  async function listViews(name: string): Promise<Response> {
    const repo = await getRepo(name);
    if (repo === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    const views: Record<string, string[]> = {};
    for (const branch of repo.branches()) {
      views[branch] = [...repo.log.heads(branch)];
    }
    return json(200, { views });
  }

  // POST /repos/:name/views — create a branch at an already-ingested head-set.
  // Creating a branch introduces NO new ops, so no land policy applies (landing
  // into a fresh view would otherwise re-check the entire history against a
  // delegate's path/budget scope). CREATE-ONLY: re-pointing an existing view
  // must go through `land`, so its policy gates always run.
  async function createView(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer === null) {
      return json(401, { error: 'unsigned or invalid request' });
    }
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const { view, heads } = parsed as { view?: unknown; heads?: unknown };
    if (typeof view !== 'string' || view.length === 0) {
      return json(400, { error: 'missing view name' });
    }
    if (view.startsWith(INTERNAL_VIEW_PREFIX)) {
      return json(400, { error: `reserved view name ${view}` });
    }
    if (!Array.isArray(heads) || heads.some((h) => typeof h !== 'string')) {
      return json(400, { error: 'heads must be an array of op ids' });
    }
    return withRepoLock(name, async () => {
      const meta = await readMeta(name);
      if (meta === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      const reg = await registryFor(name);
      if (
        signer !== meta.owner &&
        !(reg.delegationFor(signer) !== undefined && !reg.isRevoked(signer))
      ) {
        return json(403, { error: 'not authorized to write this repo' });
      }
      const repo = await getRepo(name);
      if (repo === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      if (repo.log.hasView(view)) {
        return json(409, { error: `view ${view} already exists` });
      }
      const known = new Set(repo.log.ops().map((o) => o.id));
      for (const head of heads as string[]) {
        if (!known.has(head)) {
          return json(400, { error: `unknown head ${head}` });
        }
      }
      await repo.log.repoint(view, heads as string[]);
      return json(201, { view, heads });
    });
  }

  // Returns the reachable bundle for a view: ops in lamport order, plus the
  // CURRENT ciphertext object and its served caps for each plaintext_id an
  // op's payload references. Use this for clone (pull main).
  async function pull(name: string, view: string): Promise<Response> {
    const repo = await getRepo(name);
    if (repo === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    const ops = reachableOps(repo.log.ops(), repo.log.heads(view));
    // For every plaintext_id an op's payload references, the CURRENT ciphertext
    // object + its served caps (store.get decrypts the current object, so the
    // client needs current — not a historical version — to read after rotation).
    const objects = [];
    const caps = [];
    const seen = new Set<string>();
    for (const op of ops) {
      const pid = op.payload?.plaintext_id;
      if (pid === undefined || seen.has(pid)) {
        continue;
      }
      seen.add(pid);
      const current = repo.store.current(pid);
      if (current !== undefined) {
        objects.push(current);
        caps.push(...repo.store.caps(pid));
      }
    }
    // The signed "why" for every op in the view (P04), so a clone carries the
    // meaning, not just the code. The standing "no" (P10) travels the same way,
    // so a clone can see (and re-serve) any veto over the view's ops.
    const provLog = await provenanceFor(name);
    const prov = ops.flatMap((op) => [...provLog.forOp(op.id)]);
    const vetoLog = await vetoFor(name);
    const veto = ops.flatMap((op) => [...vetoLog.forOp(op.id)]);
    // The semantic-graph ops (P08) are keyed by symbol, not by a P03 op, so a
    // clone carries the repo's whole structural history (e.g. rename chains).
    const symopLog = await symopFor(name);
    const symop = [...symopLog.all()];
    return json(200, {
      view,
      heads: [...repo.log.heads(view)],
      ...encodeBundle(ops, objects, caps, prov, veto, symop),
    });
  }

  // Verify signature + owner, then ingest each object (with its caps) and each
  // op under the repo lock. Per-item failures go to rejected[] — a single bad
  // item does not abort the whole request. Views are never advanced here; only
  // land moves views.
  async function push(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer === null) {
      return json(401, { error: 'unsigned or invalid request' });
    }
    const meta = await readMeta(name);
    if (meta === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    let bundle: ReturnType<typeof decodeBundle>;
    try {
      bundle = decodeBundle(parsed as Parameters<typeof decodeBundle>[0]);
    } catch {
      return json(400, { error: 'malformed bundle' });
    }
    return withRepoLock(name, async () => {
      // Owner-or-delegate gate INSIDE the lock: re-check against the one-true
      // registry AFTER acquiring the lock, so a revoke that ran just before is
      // seen. The owner is always authorized; a non-owner must hold a
      // non-revoked delegation for this repo.
      const reg = await registryFor(name);
      if (
        signer !== meta.owner &&
        !(reg.delegationFor(signer) !== undefined && !reg.isRevoked(signer))
      ) {
        return json(403, { error: 'not authorized to write this repo' });
      }
      const repo = await getRepo(name);
      if (repo === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      const rejected: { kind: string; id: string; reason: string }[] = [];
      let objectsOk = 0;
      let capsOk = 0;
      let opsOk = 0;
      // Verify each cap at the push boundary before grouping. Caps with invalid
      // or malformed signatures are rejected immediately so they never reach
      // store.ingest; only valid caps are grouped and counted in accepted.caps.
      const capsByPid = new Map<string, Capability[]>();
      for (const cap of bundle.caps) {
        let valid = false;
        try {
          valid = verifyCapability(cap);
        } catch {
          valid = false;
        }
        if (valid) {
          const list = capsByPid.get(cap.object) ?? [];
          list.push(cap);
          capsByPid.set(cap.object, list);
        } else {
          rejected.push({
            kind: 'cap',
            id: cap.object ?? '?',
            reason: 'invalid capability signature',
          });
        }
      }
      for (const object of bundle.objects) {
        try {
          const pushed = capsByPid.get(object.plaintext_id) ?? [];
          // `store.ingest` is authoritative-replace, and a client only sends the
          // caps ITS store holds — so a pusher with a stale view would silently
          // erase a capability another member was just granted. Union the pushed
          // caps with the ones already served, but ONLY when the ciphertext is
          // unchanged: a new ciphertext means a new content key, and the old caps
          // would unwrap the wrong one, so those must be replaced outright.
          const stored = repo.store.current(object.plaintext_id);
          const sameKey = stored !== undefined && stored.id === object.id;
          await repo.store.ingest(
            object,
            sameKey
              ? unionCaps(repo.store.caps(object.plaintext_id), pushed)
              : pushed
          );
          objectsOk += 1;
          capsOk += pushed.length;
        } catch (err) {
          rejected.push({
            kind: 'object',
            id: object.id ?? '?',
            reason: String(err),
          });
        }
      }
      for (const op of bundle.ops) {
        try {
          await repo.log.ingest(op);
          opsOk += 1;
        } catch (err) {
          rejected.push({ kind: 'op', id: op.id ?? '?', reason: String(err) });
        }
      }
      // Ingest the signed "why" (P04): keep-and-label + durable write-through, so
      // a restarted server still serves the reason behind each change. An
      // unverifiable why poisons nothing (it is kept and rendered `unverified`).
      let provOk = 0;
      const provLog = await provenanceFor(name);
      for (const p of bundle.prov) {
        try {
          await provLog.ingest(p);
          provOk += 1;
        } catch (err) {
          rejected.push({ kind: 'prov', id: p.op ?? '?', reason: String(err) });
        }
      }
      // Ingest the standing "no" (P10) the same way: keep-and-label + durable
      // write-through so a restarted server still blocks a vetoed land. A forged
      // veto is kept but rendered `unverified`, and the land gate never counts it.
      let vetoOk = 0;
      const vetoLog = await vetoFor(name);
      for (const v of bundle.veto) {
        try {
          await vetoLog.ingest(v);
          vetoOk += 1;
        } catch (err) {
          rejected.push({ kind: 'veto', id: v.op ?? '?', reason: String(err) });
        }
      }
      // Ingest the signed semantic-graph ops (P08) the same way, so a restarted
      // server still serves a symbol's rename chain. Keep-and-label — an
      // unverifiable structural claim is kept and rendered unverifiable.
      let symopOk = 0;
      const symopLog = await symopFor(name);
      for (const s of bundle.symop) {
        try {
          await symopLog.ingest(s);
          symopOk += 1;
        } catch (err) {
          rejected.push({
            kind: 'symop',
            id: s.id ?? '?',
            reason: String(err),
          });
        }
      }
      return json(200, {
        accepted: {
          objects: objectsOk,
          ops: opsOk,
          caps: capsOk,
          prov: provOk,
          veto: vetoOk,
          symop: symopOk,
        },
        rejected,
      });
    });
  }

  // Verify signature + owner, validate that every fromHead is a known ingested
  // op, build an ephemeral in-memory source view (not persisted), and run
  // policy-gated Repo.land with the signer as a key-less author.
  async function land(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer === null) {
      return json(401, { error: 'unsigned or invalid request' });
    }
    const meta = await readMeta(name);
    if (meta === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const { fromHeads, into, contrib } = parsed as {
      fromHeads: string[];
      into?: string;
      contrib?: string[];
    };
    if (into !== undefined && typeof into !== 'string') {
      return json(400, { error: 'into must be a string' });
    }
    // Decode any client-pushed reputation claims (P07). A malformed entry is
    // dropped rather than failing the whole land.
    const claims: ContributionClaim[] = [];
    if (Array.isArray(contrib)) {
      for (const s of contrib) {
        try {
          claims.push(decodeClaim(s));
        } catch {
          // skip a malformed claim
        }
      }
    }
    return withRepoLock(name, async () => {
      // Owner-or-delegate gate INSIDE the lock: re-check against the one-true
      // registry AFTER acquiring the lock, so a revoke that ran just before is
      // seen. The owner is always authorized; a non-owner must hold a
      // non-revoked delegation for this repo. The same `reg` composes the
      // delegationPolicy below.
      const reg = await registryFor(name);
      if (
        signer !== meta.owner &&
        !(reg.delegationFor(signer) !== undefined && !reg.isRevoked(signer))
      ) {
        return json(403, { error: 'not authorized to write this repo' });
      }
      const repo = await getRepo(name);
      if (repo === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      // Every head must be an op the server has already ingested; a reference to
      // unknown history means the closure is partial and land would be wrong.
      const known = new Set(repo.log.ops().map((o) => o.id));
      if (!Array.isArray(fromHeads) || fromHeads.some((h) => !known.has(h))) {
        return json(400, {
          error: 'fromHeads references an op the server has not ingested',
        });
      }
      // Capture the target frontier BEFORE land re-points the view; the
      // incoming closure is the ops reachable from fromHeads but not from here.
      // NOTE: this `?? 'main'` default MUST match Repo.land's own `into` default
      // — they share the same frontier, and a drift would mis-meter delegates.
      const target = into ?? 'main';
      const priorInto = [...repo.log.heads(target)];
      // Ephemeral in-memory source view: reuse a constant name so the view
      // count stays bounded. Safe because withRepoLock serializes land calls
      // per repo — each land overwrites the view before reading it. It lives
      // under the internal prefix so it never surfaces as a branch.
      const src = `${INTERNAL_VIEW_PREFIX}incoming`;
      repo.log.view(src, fromHeads);
      // Compose the base policy with delegation enforcement AND the durable
      // standing veto: every non-owner op is path+budget gated (the owner is
      // exempt), and — no matter how green every automated gate is — a verified
      // veto pushed for any incoming op is the ceiling that blocks the land. With
      // no vetoes recorded, blockOnVeto allows, so this is a safe always-on gate.
      const vetoLog = await vetoFor(name);
      const gates: LandPolicy[] = [
        policy,
        delegationPolicy(reg, (a) => a === meta.owner),
        blockOnVeto(vetoLog),
      ];
      // When configured with a reputation floor, add a durable tier gate: every
      // incoming op's author must clear `minMerges` ATTESTED merges. Self-claimed
      // reputation never counts, so the gate honors only host-vouched history.
      // Loaded lazily — a server with no host and no floor never touches `rep/`.
      if (config.minMerges !== undefined) {
        gates.push(
          requireReputationTier(await reputationLog(), config.minMerges)
        );
      }
      const result = await repo.land({
        from: src,
        into: target,
        author: PublicIdentity.fromDid(signer),
        policy: all(...gates),
      });
      if (result.landed) {
        // Record each delegate's landed-op count (owner exempt). incoming =
        // ops reachable from fromHeads but not from the prior `into` frontier.
        const priorSet = new Set(
          reachableOps(repo.log.ops(), priorInto).map((o) => o.id)
        );
        const incoming = reachableOps(repo.log.ops(), fromHeads).filter(
          (o) => !priorSet.has(o.id)
        );
        const countByAuthor = new Map<string, number>();
        for (const op of incoming) {
          if (op.author !== meta.owner) {
            countByAuthor.set(
              op.author,
              (countByAuthor.get(op.author) ?? 0) + 1
            );
          }
        }
        for (const [agent, count] of countByAuthor) {
          if (reg.delegationFor(agent) !== undefined) {
            reg.record(agent, count, 0);
            const u = reg.usage(agent);
            await metaBackend(name).put(
              `meter/${agent}`,
              encodeRecord({ changes: u.changes, spend: u.spend })
            );
          }
        }
        // Attest client-pushed reputation claims (P07) for the landed ops. Only
        // an attesting instance (config.host) mints, and only for a claim whose
        // subject is the ACTUAL author of the landed op it names — so no one can
        // claim credit for another's merge, and a claim for an unlanded op is
        // ignored. The result is a host-vouched, durable Contribution.
        if (config.host !== undefined && claims.length > 0) {
          const reps = await reputationLog();
          const byId = new Map(incoming.map((o) => [o.id, o]));
          for (const claim of claims) {
            const op = byId.get(claim.ref);
            if (
              op !== undefined &&
              claim.subject === op.author &&
              verifyClaim(claim)
            ) {
              await reps.ingest(attest(claim, config.host));
            }
          }
        }
      }
      return json(200, result);
    });
  }

  // Owner-signed grant: register + persist a P09 Delegation for the repo. The
  // delegation's operator must be the repo owner too, so an owner cannot launder
  // a third-party-issued grant through their own signed request.
  async function grant(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer === null) {
      return json(401, { error: 'unsigned or invalid request' });
    }
    const meta = await readMeta(name);
    if (meta === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    if (signer !== meta.owner) {
      return json(403, { error: 'not the repo owner' });
    }
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const { delegation } = parsed as { delegation?: string };
    if (typeof delegation !== 'string') {
      return json(400, { error: 'missing delegation' });
    }
    let d: Delegation;
    try {
      d = decodeDelegation(delegation);
    } catch {
      return json(400, { error: 'malformed delegation' });
    }
    if (d.operator !== meta.owner) {
      return json(403, { error: 'delegation operator is not the repo owner' });
    }
    if (!verifyDelegation(d)) {
      return json(400, { error: 'invalid delegation signature' });
    }
    return withRepoLock(name, async () => {
      const reg = await registryFor(name);
      // Revocation is terminal (P09): register() would replace the grant record
      // but never clear the quarantine, so a re-grant would 200 yet leave the
      // agent permanently blocked (and absent from GET /grants). Reject it
      // explicitly so the terminal semantics are unambiguous — issue a fresh DID.
      if (reg.isRevoked(d.agent)) {
        return json(409, {
          error:
            'agent is revoked; revocation is terminal — grant a fresh identity',
        });
      }
      // register() can throw on a malformed delegation; map it to a 400 rather
      // than letting it escape as a 500 (defense-in-depth after verifyDelegation).
      try {
        reg.register(d);
      } catch {
        return json(400, { error: 'invalid delegation' });
      }
      await metaBackend(name).put(`grant/${d.agent}`, encodeRecord(d));
      return json(200, {
        agent: d.agent,
        paths: [...d.paths],
        maxChanges: d.maxChanges,
        maxSpend: d.maxSpend,
      });
    });
  }

  // Owner-signed revoke: quarantine + persist (terminal). A revoked agent stays
  // blocked across reloads.
  async function revoke(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer === null) {
      return json(401, { error: 'unsigned or invalid request' });
    }
    const meta = await readMeta(name);
    if (meta === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    if (signer !== meta.owner) {
      return json(403, { error: 'not the repo owner' });
    }
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const { agent } = parsed as { agent?: string };
    if (typeof agent !== 'string') {
      return json(400, { error: 'missing agent' });
    }
    return withRepoLock(name, async () => {
      const reg = await registryFor(name);
      reg.revoke(agent);
      await metaBackend(name).put(`revoked/${agent}`, encodeRecord(true));
      return json(200, { agent, revoked: true });
    });
  }

  // Public: the active (non-revoked) grants for a repo, each as a wire delegation.
  async function listGrants(name: string): Promise<Response> {
    if ((await readMeta(name)) === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    const reg = await registryFor(name);
    const b = metaBackend(name);
    const grants: string[] = [];
    for (const key of await b.list('grant/')) {
      const bytes = await b.get(key);
      if (bytes !== undefined) {
        let d: Delegation;
        try {
          d = decodeRecord(bytes) as Delegation;
        } catch {
          // skip a corrupt/invalid persisted grant (mirror buildRegistry)
          continue;
        }
        if (!reg.isRevoked(d.agent)) {
          grants.push(encodeDelegation(d));
        }
      }
    }
    return json(200, { grants });
  }

  // Public: a subject's server-wide reputation profile (P07) — attested vs
  // claimed counts and the attested tally by kind. Counts (not the full records)
  // keep the response JSON-safe; the tier gate reads the same durable log.
  async function reputationProfile(did: string): Promise<Response> {
    const reps = await reputationLog();
    const profile = reps.profile(did);
    return json(200, {
      subject: profile.subject,
      attested: profile.attested.length,
      claimed: profile.claimed.length,
      byKind: profile.byKind,
    });
  }

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      const body =
        req.method === 'POST'
          ? new Uint8Array(await req.arrayBuffer())
          : new Uint8Array();

      if (path === '/repos' && req.method === 'GET') {
        return listRepos();
      }
      // GET /reputation/:did — the subject's server-wide profile.
      const repMatch = path.match(/^\/reputation\/(.+)$/);
      if (repMatch !== null && req.method === 'GET') {
        const did = safeDecode(repMatch[1]);
        if (did === undefined) {
          return json(400, { error: 'malformed path' });
        }
        return reputationProfile(did);
      }
      if (path === '/repos' && req.method === 'POST') {
        return createRepo(req, body);
      }
      // DELETE /repos/:name — owner-only. (Suffixed routes below are GET/POST,
      // so this bare-name match never steals a push/land/grants path.)
      const deleteMatch = path.match(/^\/repos\/(.+)$/);
      if (deleteMatch !== null && req.method === 'DELETE') {
        const repoName = safeDecode(deleteMatch[1]);
        if (repoName === undefined) {
          return json(400, { error: 'malformed path' });
        }
        return deleteRepo(repoName, req, body);
      }
      // /repos/:name/views — list the branches, or create one.
      const viewsMatch = path.match(/^\/repos\/(.+)\/views$/);
      if (viewsMatch !== null && req.method === 'GET') {
        const repoName = safeDecode(viewsMatch[1]);
        if (repoName === undefined) {
          return json(400, { error: 'malformed path' });
        }
        return listViews(repoName);
      }
      if (viewsMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(viewsMatch[1]);
        if (repoName === undefined) {
          return json(400, { error: 'malformed path' });
        }
        return createView(repoName, req, body);
      }
      // /repos/:name/views/:view  and  /repos/:name/pull
      // Names can contain '/' (e.g. "acme/web"); split on the fixed suffixes.
      const viewMatch = path.match(/^\/repos\/(.+)\/views\/([^/]+)$/);
      if (viewMatch !== null && req.method === 'GET') {
        const repoName = safeDecode(viewMatch[1]);
        const viewName = safeDecode(viewMatch[2]);
        if (repoName === undefined || viewName === undefined) {
          return json(400, { error: 'malformed path' });
        }
        return getView(repoName, viewName);
      }
      const pullMatch = path.match(/^\/repos\/(.+)\/pull$/);
      if (pullMatch !== null && req.method === 'GET') {
        const repoName = safeDecode(pullMatch[1]);
        if (repoName === undefined) {
          return json(400, { error: 'malformed path' });
        }
        return pull(repoName, url.searchParams.get('view') ?? 'main');
      }
      // push / land: POST /repos/:name/push and POST /repos/:name/land
      // Match before the generic catch-all; names can contain '/'.
      const pushMatch = path.match(/^\/repos\/(.+)\/push$/);
      if (pushMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(pushMatch[1]);
        if (repoName === undefined) {
          return json(400, { error: 'malformed path' });
        }
        return push(repoName, req, body);
      }
      const landMatch = path.match(/^\/repos\/(.+)\/land$/);
      if (landMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(landMatch[1]);
        if (repoName === undefined) {
          return json(400, { error: 'malformed path' });
        }
        return land(repoName, req, body);
      }
      // grants / revoke: GET+POST /repos/:name/grants and POST /repos/:name/revoke
      const grantsMatch = path.match(/^\/repos\/(.+)\/grants$/);
      if (grantsMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(grantsMatch[1]);
        if (repoName === undefined) {
          return json(400, { error: 'malformed path' });
        }
        return grant(repoName, req, body);
      }
      if (grantsMatch !== null && req.method === 'GET') {
        const repoName = safeDecode(grantsMatch[1]);
        if (repoName === undefined) {
          return json(400, { error: 'malformed path' });
        }
        return listGrants(repoName);
      }
      const revokeMatch = path.match(/^\/repos\/(.+)\/revoke$/);
      if (revokeMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(revokeMatch[1]);
        if (repoName === undefined) {
          return json(400, { error: 'malformed path' });
        }
        return revoke(repoName, req, body);
      }
      return json(404, { error: 'not found' });
    },
  };
}
