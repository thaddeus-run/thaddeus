import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import {
  decodeHeadRecord,
  encodeHeadRecord,
  type HeadRecord,
  type HeadRecordWire,
  OpLog,
  signHead,
} from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { encodeBundle } from '../src/dto';
import { createServer } from '../src/server';
import { signRequest } from '../src/sign';
import { createRepoBody, landBody } from './heads';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function signed(
  method: string,
  path: string,
  body: Uint8Array,
  signer: Identity
): Request {
  const h = signRequest(method, path, body, signer, new Date().toISOString());
  return new Request(`http://t${path}`, {
    method,
    body,
    headers: {
      'x-thaddeus-did': h.did,
      'x-thaddeus-timestamp': h.timestamp,
      'x-thaddeus-nonce': h.nonce,
      'x-thaddeus-signature': h.signature,
    },
  });
}
const jbody = (o: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(o));

// Build a committed branch locally and return its push bundle + heads.
async function localCommit(
  author: Identity
): Promise<{ bundle: ReturnType<typeof encodeBundle>; heads: string[] }> {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const ws = Workspace.open(log, store, {
    source: 'main',
    reader: author,
    name: 'feat',
  });
  ws.write('src/auth.rs', enc('fn refresh() {}'));
  await ws.commit(author);
  const ops = log.ops();
  const objects = [];
  const caps = [];
  for (const op of ops) {
    const pid = op.payload?.plaintext_id;
    if (pid !== undefined) {
      const cur = store.current(pid);
      if (cur !== undefined) {
        objects.push(cur);
        caps.push(...store.caps(pid));
      }
    }
  }
  return {
    bundle: encodeBundle(ops, objects, caps),
    heads: [...log.heads('feat')],
  };
}

describe('writes', () => {
  test('an exact signed request can mutate the server only once', async () => {
    const owner = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const body = jbody(createRepoBody('replay-proof', owner));
    const signedHeaders = signRequest(
      'POST',
      '/repos',
      body,
      owner,
      new Date().toISOString(),
      'captured-request'
    );
    const request = (): Request =>
      new Request('http://t/repos', {
        method: 'POST',
        body,
        headers: {
          'x-thaddeus-did': signedHeaders.did,
          'x-thaddeus-timestamp': signedHeaders.timestamp,
          'x-thaddeus-nonce': signedHeaders.nonce,
          'x-thaddeus-signature': signedHeaders.signature,
        },
      });

    expect((await srv.fetch(request())).status).toBe(201);
    const replayed = await srv.fetch(request());
    expect(replayed.status).toBe(401);
    expect(await replayed.json()).toEqual({
      error: 'unsigned or invalid request',
    });
  });

  test('owner push + land; non-owner push is 403', async () => {
    const a = Identity.create();
    const b = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(
      signed('POST', '/repos', jbody(createRepoBody('acme/web', a)), a)
    );

    const { bundle, heads } = await localCommit(a);

    // Non-owner push rejected.
    const forbidden = await srv.fetch(
      signed('POST', '/repos/acme%2Fweb/push', jbody(bundle), b)
    );
    expect(forbidden.status).toBe(403);

    // Owner push accepted.
    const pushed = await srv.fetch(
      signed('POST', '/repos/acme%2Fweb/push', jbody(bundle), a)
    );
    expect(pushed.status).toBe(200);
    const result = (await pushed.json()) as {
      accepted: { ops: number };
      rejected: unknown[];
    };
    expect(result.accepted.ops).toBeGreaterThan(0);
    expect(result.rejected).toHaveLength(0);

    // Owner land by heads.
    const landed = await srv.fetch(
      signed(
        'POST',
        '/repos/acme%2Fweb/land',
        jbody(await landBody(srv.fetch, 'acme/web', heads, a)),
        a
      )
    );
    const lr = (await landed.json()) as { landed: boolean };
    expect(lr.landed).toBe(true);
  });

  test('land rejects rollback, fork, gap, broken links, dropped heads, and forgery', async () => {
    const owner = Identity.create();
    const stranger = Identity.create();
    const backend = new MemoryBackend();
    const srv = createServer({ backend });
    await srv.fetch(
      signed('POST', '/repos', jbody(createRepoBody('monotonic', owner)), owner)
    );
    const { bundle, heads } = await localCommit(owner);
    await srv.fetch(
      signed('POST', '/repos/monotonic/push', jbody(bundle), owner)
    );
    const firstBody = await landBody(srv.fetch, 'monotonic', heads, owner);
    const firstLand = await srv.fetch(
      signed('POST', '/repos/monotonic/land', jbody(firstBody), owner)
    );
    expect(firstLand.status).toBe(200);
    expect((await firstLand.json()) as { landed: boolean }).toMatchObject({
      landed: true,
    });

    const view = (await (
      await srv.fetch(new Request('http://t/repos/monotonic/views/main'))
    ).json()) as { head: HeadRecordWire; chain: HeadRecordWire[] };
    const current = decodeHeadRecord(view.head);
    const genesis = decodeHeadRecord(view.chain[0]);
    const successor = (
      fields: Partial<HeadRecord>,
      signer = owner
    ): HeadRecord =>
      signHead(
        {
          repo: fields.repo ?? 'monotonic',
          view: fields.view ?? 'main',
          version: fields.version ?? current.version + 1,
          previous: fields.previous ?? current.id,
          heads: fields.heads ?? current.heads,
        },
        signer
      );
    const attempt = async (
      record: HeadRecord,
      requestSigner = owner,
      wire: HeadRecordWire = encodeHeadRecord(record)
    ) => {
      const response = await srv.fetch(
        signed(
          'POST',
          '/repos/monotonic/land',
          jbody({ fromHeads: heads, into: 'main', head: wire }),
          requestSigner
        )
      );
      return {
        status: response.status,
        body: (await response.json()) as { code?: string },
      };
    };

    expect(await attempt(genesis)).toMatchObject({
      status: 409,
      body: { code: 'rollback' },
    });
    expect(
      await attempt(
        successor({
          version: current.version,
          previous: 'f'.repeat(64),
        })
      )
    ).toMatchObject({ status: 409, body: { code: 'fork' } });
    expect(
      await attempt(successor({ version: current.version + 2 }))
    ).toMatchObject({ status: 409, body: { code: 'gap' } });
    expect(
      await attempt(successor({ previous: 'e'.repeat(64) }))
    ).toMatchObject({ status: 409, body: { code: 'broken_previous' } });
    expect(await attempt(successor({ heads: [] }))).toMatchObject({
      status: 409,
      body: { code: 'dropped_heads' },
    });
    expect(await attempt(successor({ repo: 'other' }))).toMatchObject({
      status: 400,
      body: { code: 'wrong_repo' },
    });
    expect(await attempt(successor({}, stranger), owner)).toMatchObject({
      status: 403,
    });

    const valid = successor({});
    expect(
      await attempt(valid, owner, {
        ...encodeHeadRecord(valid),
        id: '0'.repeat(64),
      })
    ).toMatchObject({ status: 400 });

    const restarted = createServer({ backend });
    const afterRestart = (await (
      await restarted.fetch(new Request('http://t/repos/monotonic/views/main'))
    ).json()) as { head: HeadRecordWire; chain: HeadRecordWire[] };
    expect(afterRestart.head.id).toBe(current.id);
    expect(afterRestart.chain).toHaveLength(2);

    await backend.delete(`repo/monotonic/op/${heads[0]}`);
    const incomplete = createServer({ backend });
    const incompletePull = await incomplete.fetch(
      new Request('http://t/repos/monotonic/pull?view=main')
    );
    expect(incompletePull.status).toBe(400);
    expect(await incompletePull.json()).toMatchObject({
      code: 'missing_operation',
    });
  });

  test('a forged op lands in rejected[], not stored', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(signed('POST', '/repos', jbody(createRepoBody('r', a)), a));
    // A real commit, then zero the op's signature → verifyOp fails on the server.
    const store = new MemoryStore();
    const log = new OpLog(store);
    const ws = Workspace.open(log, store, {
      source: 'main',
      reader: a,
      name: 'feat',
    });
    ws.write('x.rs', enc('x'));
    await ws.commit(a);
    const op = log.ops()[0];
    const forged = { ...op, sig: new Uint8Array(op.sig.length) };
    const pid = op.payload!.plaintext_id;
    const bundle = encodeBundle(
      [forged],
      [store.current(pid)!],
      [...store.caps(pid)]
    );

    const res = await srv.fetch(
      signed('POST', '/repos/r/push', jbody(bundle), a)
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      accepted: { ops: number };
      rejected: unknown[];
    };
    expect(result.accepted.ops).toBe(0); // the object ingests; the forged op does not
    expect(result.rejected.length).toBeGreaterThan(0);
  });

  test('re-pushing the same content is idempotent', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(
      signed('POST', '/repos', jbody(createRepoBody('idem', a)), a)
    );
    const { bundle } = await localCommit(a);
    const first = (await (
      await srv.fetch(signed('POST', '/repos/idem/push', jbody(bundle), a))
    ).json()) as {
      accepted: { ops: number };
    };
    const second = (await (
      await srv.fetch(signed('POST', '/repos/idem/push', jbody(bundle), a))
    ).json()) as {
      rejected: unknown[];
    };
    expect(first.accepted.ops).toBeGreaterThan(0);
    expect(second.rejected).toHaveLength(0); // re-ingest is a content-addressed no-op, not an error
  });

  test('forged cap lands in rejected[], valid cap counted in accepted.caps', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(
      signed('POST', '/repos', jbody(createRepoBody('cap-test', a)), a)
    );

    // Build a local commit to get a real bundle with a valid cap.
    const store = new MemoryStore();
    const log = new OpLog(store);
    const ws = Workspace.open(log, store, {
      source: 'main',
      reader: a,
      name: 'feat',
    });
    ws.write('hello.rs', enc('fn hi() {}'));
    await ws.commit(a);
    const op = log.ops()[0];
    const pid = op.payload!.plaintext_id;
    const validCaps = [...store.caps(pid)];
    // Build a forged cap by zeroing its signature bytes.
    const forgedCap = {
      ...validCaps[0],
      sig: new Uint8Array(validCaps[0].sig.length),
    };
    // Bundle: the object + both the valid cap AND the forged cap.
    const bundle = encodeBundle(
      [op],
      [store.current(pid)!],
      [...validCaps, forgedCap]
    );

    const res = await srv.fetch(
      signed('POST', '/repos/cap-test/push', jbody(bundle), a)
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      accepted: { objects: number; ops: number; caps: number };
      rejected: { kind: string; id: string; reason: string }[];
    };
    // The forged cap must appear in rejected[] with kind 'cap'.
    const rejectedCaps = result.rejected.filter((r) => r.kind === 'cap');
    expect(rejectedCaps).toHaveLength(1);
    expect(rejectedCaps[0].reason).toBe('invalid capability signature');
    // Only the valid cap(s) count in accepted.caps.
    expect(result.accepted.caps).toBe(validCaps.length);
  });

  test('land with an unknown head is 400', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(
      signed('POST', '/repos', jbody(createRepoBody('r2', a)), a)
    );
    const unknown = 'a'.repeat(64);
    const res = await srv.fetch(
      signed(
        'POST',
        '/repos/r2/land',
        jbody(await landBody(srv.fetch, 'r2', [unknown], a)),
        a
      )
    );
    expect(res.status).toBe(400);
  });

  test('a null JSON body to POST push is 400 not 500', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(
      signed('POST', '/repos', jbody(createRepoBody('null-push', a)), a)
    );
    const nullBody = new TextEncoder().encode('null');
    const h = signRequest(
      'POST',
      '/repos/null-push/push',
      nullBody,
      a,
      new Date().toISOString()
    );
    const res = await srv.fetch(
      new Request('http://t/repos/null-push/push', {
        method: 'POST',
        body: nullBody,
        headers: {
          'x-thaddeus-did': h.did,
          'x-thaddeus-timestamp': h.timestamp,
          'x-thaddeus-nonce': h.nonce,
          'x-thaddeus-signature': h.signature,
        },
      })
    );
    expect(res.status).toBe(400);
  });

  test('a null JSON body to POST land is 400 not 500', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(
      signed('POST', '/repos', jbody(createRepoBody('null-land', a)), a)
    );
    const nullBody = new TextEncoder().encode('null');
    const h = signRequest(
      'POST',
      '/repos/null-land/land',
      nullBody,
      a,
      new Date().toISOString()
    );
    const res = await srv.fetch(
      new Request('http://t/repos/null-land/land', {
        method: 'POST',
        body: nullBody,
        headers: {
          'x-thaddeus-did': h.did,
          'x-thaddeus-timestamp': h.timestamp,
          'x-thaddeus-nonce': h.nonce,
          'x-thaddeus-signature': h.signature,
        },
      })
    );
    expect(res.status).toBe(400);
  });
});
