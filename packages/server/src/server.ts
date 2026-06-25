import type { Op } from '@thaddeus.run/log';
import {
  blockOnConflict,
  type LandPolicy,
  Platform,
  type Repo,
} from '@thaddeus.run/platform';
import {
  type Backend,
  decodeRecord,
  encodeRecord,
  scoped,
} from '@thaddeus.run/store';

import { encodeBundle } from './dto';
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
    const parsed = safeParseJson(body);
    if (parsed === undefined || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const { name } = parsed as { name: string };
    if (typeof name !== 'string' || name.length === 0) {
      return json(400, { error: 'missing repo name' });
    }
    if ((await readMeta(name)) !== undefined) {
      return json(409, { error: `repo ${name} already exists` });
    }
    await metaBackend(name).put('meta/repo', encodeRecord({ owner: signer }));
    const repo = await platform.createDurable(name, config.backend);
    repoCache.set(name, repo);
    return json(201, { name, owner: signer });
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
    return json(200, encodeBundle(ops, objects, caps));
  }

  // Suppress unused-variable warnings for helpers used in later tasks.
  void withRepoLock;
  void policy;

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
        return getView(
          decodeURIComponent(viewMatch[1]),
          decodeURIComponent(viewMatch[2])
        );
      }
      const pullMatch = path.match(/^\/repos\/(.+)\/pull$/);
      if (pullMatch !== null && req.method === 'GET') {
        return pull(
          decodeURIComponent(pullMatch[1]),
          url.searchParams.get('view') ?? 'main'
        );
      }
      // push / land are added in later tasks.
      return json(404, { error: 'not found' });
    },
  };
}
