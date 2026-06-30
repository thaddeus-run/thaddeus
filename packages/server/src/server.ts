import {
  AgentRegistry,
  type Delegation,
  delegationPolicy,
  verifyDelegation,
} from '@thaddeus.run/agent';
import { PublicIdentity } from '@thaddeus.run/identity';
import type { Op } from '@thaddeus.run/log';
import {
  blockOnConflict,
  type LandPolicy,
  Platform,
  type Repo,
} from '@thaddeus.run/platform';
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

  // Durable per-repo AgentRegistry cache, rebuilt from the scoped backend.
  const registries = new Map<string, AgentRegistry>();

  // Build (or fetch the cached) durable AgentRegistry for a repo: register every
  // persisted grant, replay the persisted meters, then apply revocations. Load
  // order matters — record() throws for an unregistered agent, so grants must be
  // registered before their meters replay; revocations apply last.
  async function registryFor(name: string): Promise<AgentRegistry> {
    const cached = registries.get(name);
    if (cached !== undefined) {
      return cached;
    }
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
    registries.set(name, reg);
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
      .map((k) => k.slice('repo/'.length, -'/meta/repo'.length));
    return json(200, { repos: names.sort() });
  }

  // Returns the heads of a named view for a repo; 404 if the repo doesn't exist.
  async function getView(name: string, view: string): Promise<Response> {
    const repo = await getRepo(name);
    if (repo === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    return json(200, { view, heads: [...repo.log.heads(view)] });
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
    return json(200, {
      view,
      heads: [...repo.log.heads(view)],
      ...encodeBundle(ops, objects, caps),
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
    // Owner-or-delegate gate: the owner is always authorized; a non-owner must
    // hold a non-revoked delegation for this repo.
    const reg = await registryFor(name);
    if (
      signer !== meta.owner &&
      !(reg.delegationFor(signer) !== undefined && !reg.isRevoked(signer))
    ) {
      return json(403, { error: 'not authorized to write this repo' });
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
          await repo.store.ingest(
            object,
            capsByPid.get(object.plaintext_id) ?? []
          );
          objectsOk += 1;
          capsOk += (capsByPid.get(object.plaintext_id) ?? []).length;
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
      return json(200, {
        accepted: { objects: objectsOk, ops: opsOk, caps: capsOk },
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
    // Owner-or-delegate gate: the owner is always authorized; a non-owner must
    // hold a non-revoked delegation for this repo.
    const reg = await registryFor(name);
    if (
      signer !== meta.owner &&
      !(reg.delegationFor(signer) !== undefined && !reg.isRevoked(signer))
    ) {
      return json(403, { error: 'not authorized to write this repo' });
    }
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const { fromHeads, into } = parsed as {
      fromHeads: string[];
      into?: string;
    };
    if (into !== undefined && typeof into !== 'string') {
      return json(400, { error: 'into must be a string' });
    }
    return withRepoLock(name, async () => {
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
      const target = into ?? 'main';
      const priorInto = [...repo.log.heads(target)];
      // Ephemeral in-memory source view: reuse a constant name so the view
      // count stays bounded. Safe because withRepoLock serializes land calls
      // per repo — each land overwrites the view before reading it.
      const src = 'incoming';
      repo.log.view(src, fromHeads);
      // Compose the base policy with delegation enforcement: every non-owner op
      // is path+budget gated (the owner is exempt — never scope/budget checked).
      const result = await repo.land({
        from: src,
        into: target,
        author: PublicIdentity.fromDid(signer),
        policy: all(
          policy,
          delegationPolicy(reg, (a) => a === meta.owner)
        ),
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
      reg.register(d);
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
        const d = decodeRecord(bytes) as Delegation;
        if (!reg.isRevoked(d.agent)) {
          grants.push(encodeDelegation(d));
        }
      }
    }
    return json(200, { grants });
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
      if (path === '/repos' && req.method === 'POST') {
        return createRepo(req, body);
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
