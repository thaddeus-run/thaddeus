import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { encodeBundle } from '../src/dto';
import { createServer } from '../src/server';
import { signRequest } from '../src/sign';

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
  test('owner push + land; non-owner push is 403', async () => {
    const a = Identity.create();
    const b = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(signed('POST', '/repos', jbody({ name: 'acme/web' }), a));

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
        jbody({ fromHeads: heads, into: 'main' }),
        a
      )
    );
    const lr = (await landed.json()) as { landed: boolean };
    expect(lr.landed).toBe(true);
  });

  test('a forged op lands in rejected[], not stored', async () => {
    const a = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(signed('POST', '/repos', jbody({ name: 'r' }), a));
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
    await srv.fetch(signed('POST', '/repos', jbody({ name: 'idem' }), a));
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
    await srv.fetch(signed('POST', '/repos', jbody({ name: 'cap-test' }), a));

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
    await srv.fetch(signed('POST', '/repos', jbody({ name: 'r2' }), a));
    const res = await srv.fetch(
      signed(
        'POST',
        '/repos/r2/land',
        jbody({ fromHeads: ['nope'], into: 'main' }),
        a
      )
    );
    expect(res.status).toBe(400);
  });
});
