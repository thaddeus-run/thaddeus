import type { Identity } from '@thaddeus.run/identity';
import { Platform, type Repo } from '@thaddeus.run/platform';
import { decodeBundle, signRequest } from '@thaddeus.run/server';
import type { Backend } from '@thaddeus.run/store';

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

  // Pull a view's reachable bundle, ingest it into `backend` as a local durable
  // repo, and set the local view to the server's reported heads (read from
  // /views/<view> — not inferred from the bundle frontier). Returns the opened
  // local Repo and those heads.
  async clone(
    name: string,
    backend: Backend,
    view = 'main'
  ): Promise<{ repo: Repo; heads: readonly string[] }> {
    const enc = encodeURIComponent;
    const viewRes = await this.#fetch(
      new Request(`${this.#server}/repos/${enc(name)}/views/${enc(view)}`)
    );
    const viewBody = (await this.#ok(viewRes)) as {
      view: string;
      heads: string[];
    };
    const pullRes = await this.#fetch(
      new Request(`${this.#server}/repos/${enc(name)}/pull?view=${enc(view)}`)
    );
    const bundle = decodeBundle(
      (await this.#ok(pullRes)) as Parameters<typeof decodeBundle>[0]
    );

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
    await repo.log.repoint(view, viewBody.heads);
    return { repo, heads: viewBody.heads };
  }

  async listRepos(): Promise<readonly string[]> {
    // Pass a Request object so both the global fetch and an injected server
    // handler (which calls new URL(req.url)) receive a well-formed input.
    const res = await this.#fetch(new Request(`${this.#server}/repos`));
    const body = (await this.#ok(res)) as { repos: string[] };
    return body.repos;
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
  async #ok(res: Response): Promise<unknown> {
    const text = await res.text();
    const body: unknown = text.length > 0 ? JSON.parse(text) : {};
    if (!res.ok) {
      const msg =
        body !== null && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `request failed: ${res.status}`;
      throw new Error(msg);
    }
    return body;
  }
}
