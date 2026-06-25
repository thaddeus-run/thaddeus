import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { FileBackend } from '@thaddeus.run/persist';
import { AccessDenied, MemoryStore } from '@thaddeus.run/store';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Bundle, decodeBundle, encodeBundle } from '../src/dto';
import { createServer } from '../src/server';
import { signRequest } from '../src/sign';
import { expectRejects } from './reject';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-server-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A tiny HTTP client over a live base URL.
function client(base: string) {
  const post = async (
    path: string,
    bodyObj: unknown,
    signer: Identity
  ): Promise<Response> => {
    const body = new TextEncoder().encode(JSON.stringify(bodyObj));
    const h = signRequest('POST', path, body, signer, new Date().toISOString());
    return fetch(`${base}${path}`, {
      method: 'POST',
      body,
      headers: {
        'x-thaddeus-did': h.did,
        'x-thaddeus-timestamp': h.timestamp,
        'x-thaddeus-signature': h.signature,
      },
    });
  };
  const get = (path: string): Promise<Response> => fetch(`${base}${path}`);
  return { post, get };
}

// Locally commit `content` to `path` and return the push bundle, branch heads,
// the local store (for post-commit operations like grant), and the Ref for the
// committed file (so callers can grant/revoke without re-deriving it).
async function commitLocally(author: Identity, path: string, content: string) {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const ws = Workspace.open(log, store, {
    source: 'main',
    reader: author,
    name: 'feat',
  });
  ws.write(path, enc(content));
  await ws.commit(author);
  const objects = [];
  const caps = [];
  for (const op of log.ops()) {
    const pid = op.payload?.plaintext_id;
    if (pid !== undefined) {
      const cur = store.current(pid);
      if (cur !== undefined) {
        objects.push(cur);
        caps.push(...store.caps(pid));
      }
    }
  }
  // Derive the Ref for the committed file from the materialized main view so
  // callers can pass it directly to store.grant / store.caps.
  log.view('feat', log.heads('feat'));
  const ref = log.materialize('feat', author).get(path)?.ref;
  return {
    bundle: encodeBundle(log.ops(), objects, caps),
    heads: [...log.heads('feat')],
    store,
    log,
    ref,
  };
}

describe('server e2e', () => {
  test('clone round-trip + stateless restart over real HTTP', async () => {
    const root = mkdtempSync(join(tmp, 'data-'));
    const a = Identity.create();

    // Boot a server.
    const srv1 = createServer({ backend: new FileBackend(root) });
    const http1 = Bun.serve({ port: 0, fetch: srv1.fetch });
    const base1 = `http://localhost:${http1.port}`;
    const c1 = client(base1);

    let pulled: ReturnType<typeof decodeBundle>;
    try {
      await c1.post('/repos', { name: 'acme/web' }, a);
      const { bundle, heads } = await commitLocally(
        a,
        'src/auth.rs',
        'fn refresh() {}'
      );
      await c1.post('/repos/acme%2Fweb/push', bundle, a);
      const landed = (await (
        await c1.post(
          '/repos/acme%2Fweb/land',
          { fromHeads: heads, into: 'main' },
          a
        )
      ).json()) as { landed: boolean };
      expect(landed.landed).toBe(true);

      // Fresh client clones via pull and decrypts the original content.
      pulled = decodeBundle(
        (await (
          await c1.get('/repos/acme%2Fweb/pull?view=main')
        ).json()) as Bundle
      );
      const cstore = new MemoryStore();
      const clog = new OpLog(cstore);
      for (const o of pulled.objects) {
        await cstore.ingest(
          o,
          pulled.caps.filter((cp) => cp.object === o.plaintext_id)
        );
      }
      for (const o of pulled.ops) {
        await clog.ingest(o);
      }
      // Reconstruct the 'main' view: the head(s) of the pulled op set are the
      // tip(s) that the server's land pointed 'main' at. The global frontier
      // (ops with no children in this set) equals the landed heads.
      clog.view('main', clog.heads());
      const ref = clog.materialize('main', a).get('src/auth.rs')?.ref;
      expect(ref).toBeDefined();
      expect(dec(await cstore.get(ref!, a))).toBe('fn refresh() {}');
    } finally {
      await http1.stop(true);
    }

    // Stateless: a brand-new server over the SAME dir still serves the landed content.
    const srv2 = createServer({ backend: new FileBackend(root) });
    const http2 = Bun.serve({ port: 0, fetch: srv2.fetch });
    const c2 = client(`http://localhost:${http2.port}`);
    try {
      const repull = decodeBundle(
        (await (
          await c2.get('/repos/acme%2Fweb/pull?view=main')
        ).json()) as Bundle
      );
      expect(repull.ops.length).toBe(pulled!.ops.length);

      // Rebuild a fresh client from the RESTARTED server and decrypt the content.
      const cstore2 = new MemoryStore();
      const clog2 = new OpLog(cstore2);
      for (const o of repull.objects) {
        await cstore2.ingest(
          o,
          repull.caps.filter((cp) => cp.object === o.plaintext_id)
        );
      }
      for (const o of repull.ops) {
        await clog2.ingest(o);
      }
      clog2.view('main', clog2.heads()); // reconstruct main from the pulled closure's frontier
      const ref2 = clog2.materialize('main', a).get('src/auth.rs')?.ref;
      expect(ref2).toBeDefined();
      expect(dec(await cstore2.get(ref2!, a))).toBe('fn refresh() {}');
    } finally {
      await http2.stop(true);
    }
  });

  test('decryption-bounded over the wire: B cannot read until granted', async () => {
    const root = mkdtempSync(join(tmp, 'grant-'));
    const a = Identity.create();
    const b = Identity.create();
    const srv = createServer({ backend: new FileBackend(root) });
    const http = Bun.serve({ port: 0, fetch: srv.fetch });
    const c = client(`http://localhost:${http.port}`);

    try {
      await c.post('/repos', { name: 'r' }, a);
      // Keep aStore and aRef in scope: needed for the grant step below.
      const {
        bundle,
        heads,
        store: aStore,
        ref: aRef,
      } = await commitLocally(a, 'f.rs', 'secret');
      await c.post('/repos/r/push', bundle, a);
      await c.post('/repos/r/land', { fromHeads: heads, into: 'main' }, a);

      // B pulls the ciphertext but cannot decrypt (no cap).
      const pulled = decodeBundle(
        (await (await c.get('/repos/r/pull?view=main')).json()) as Bundle
      );
      const bstore = new MemoryStore();
      const blog = new OpLog(bstore);
      for (const o of pulled.objects) {
        await bstore.ingest(
          o,
          pulled.caps.filter((cp) => cp.object === o.plaintext_id)
        );
      }
      for (const o of pulled.ops) {
        await blog.ingest(o);
      }
      // Reconstruct the 'main' view from the global frontier of pulled ops.
      blog.view('main', blog.heads());
      const ref = blog.materialize('main', b).get('f.rs')?.ref;
      expect(ref).toBeDefined();
      // AccessDenied — B has no capability for the object A encrypted
      await expectRejects(bstore.get(ref!, b), AccessDenied);

      // --- Acceptance #8 positive half: after A grants B, B pulls and decrypts ---
      // Grant B on A's LOCAL store (appends a cap; no key rotation, object id
      // unchanged), then re-push the object with the FULL cap set [A, B] so the
      // server's ingest replaces the stored caps with the complete set.
      await aStore.grant(aRef!, b.toPublic(), a);
      const aObj = aStore.current(aRef!.plaintext_id)!;
      const fullCaps = [...aStore.caps(aRef!.plaintext_id)];
      // Re-push: ops are already landed (idempotent), objects+caps carry the
      // new B cap so the server's store.ingest will replace the cap set.
      const rePushBundle = encodeBundle([], [aObj], fullCaps);
      await c.post('/repos/r/push', rePushBundle, a);

      // B builds a fresh local store/log from a new pull and now decrypts.
      const pulled2 = decodeBundle(
        (await (await c.get('/repos/r/pull?view=main')).json()) as Bundle
      );
      const bstore2 = new MemoryStore();
      const blog2 = new OpLog(bstore2);
      for (const o of pulled2.objects) {
        await bstore2.ingest(
          o,
          pulled2.caps.filter((cp) => cp.object === o.plaintext_id)
        );
      }
      for (const o of pulled2.ops) {
        await blog2.ingest(o);
      }
      blog2.view('main', blog2.heads());
      const ref2 = blog2.materialize('main', b).get('f.rs')?.ref;
      expect(ref2).toBeDefined();
      // B can now unwrap its cap and decrypt the content.
      expect(dec(await bstore2.get(ref2!, b))).toBe('secret');
    } finally {
      await http.stop(true);
    }
  });
});
