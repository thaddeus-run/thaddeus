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

  // Suppress unused-variable warnings for helpers used in later tasks.
  void getRepo;
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
      // push / land / pull / views are added in later tasks.
      return json(404, { error: 'not found' });
    },
  };
}
