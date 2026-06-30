import type { Identity } from '@thaddeus.run/identity';
import { Platform, type Repo } from '@thaddeus.run/platform';
import { decodeBundle, encodeBundle, signRequest } from '@thaddeus.run/server';
import type { Backend } from '@thaddeus.run/store';

import { bundleFor } from './bundle';

export interface PushResult {
  accepted: { objects: number; ops: number; caps: number };
  rejected: { kind: string; id: string; reason: string }[];
}

export interface LandOutcome {
  landed: boolean;
  into: string;
  heads: string[];
  reason?: string;
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
  ): Promise<{ repo: Repo; heads: readonly string[] }> {
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
    return { repo, heads: body.heads };
  }

  async listRepos(): Promise<readonly string[]> {
    // Pass a Request object so both the global fetch and an injected server
    // handler (which calls new URL(req.url)) receive a well-formed input.
    const res = await this.#fetch(new Request(`${this.#server}/repos`));
    const body = (await this.#ok(res)) as { repos: string[] };
    return body.repos;
  }

  // Upload the ops/objects/caps reachable from `heads`. Idempotent — the server
  // re-ingest of existing content is a no-op.
  async push(
    name: string,
    repo: Repo,
    heads: readonly string[]
  ): Promise<PushResult> {
    const { ops, objects, caps } = bundleFor(repo, heads);
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/push`,
      encodeBundle(ops, objects, caps)
    );
    return (await this.#ok(res)) as PushResult;
  }

  // Land uploaded heads into a target view under the server's policy. A blocked
  // land returns { landed: false, reason } — it is NOT thrown.
  async land(
    name: string,
    fromHeads: readonly string[],
    into = 'main'
  ): Promise<LandOutcome> {
    const res = await this.#signed(
      'POST',
      `/repos/${encodeURIComponent(name)}/land`,
      { fromHeads: [...fromHeads], into }
    );
    return (await this.#ok(res)) as LandOutcome;
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
