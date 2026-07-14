import { signDelegation } from '@thaddeus.run/agent';
import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import {
  AccessDenied,
  type Backend,
  encrypt,
  issueCapability,
  MemoryStore,
  newContentKey,
  publicDid,
  publicIdentity,
  type ReplayNonceBackend,
} from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  type Bundle,
  decodeBundle,
  encodeBundle,
  encodeCapability,
  encodeDelegation,
} from '../src/dto';
import { createServer } from '../src/server';
import { signRequest } from '../src/sign';
import { createRepoBody, landBody } from './heads';
import { expectRejects } from './reject';

beforeAll(async () => {
  await ready();
});

const enc = (value: string): Uint8Array => new TextEncoder().encode(value);
const dec = (value: Uint8Array): string => new TextDecoder().decode(value);

function signedPost(
  path: string,
  bodyValue: unknown,
  signer: Identity,
  now: string
): Request {
  const body = enc(JSON.stringify(bodyValue));
  const headers = signRequest('POST', path, body, signer, now);
  return new Request(`http://t${path}`, {
    method: 'POST',
    body,
    headers: {
      'x-thaddeus-did': headers.did,
      'x-thaddeus-timestamp': headers.timestamp,
      'x-thaddeus-nonce': headers.nonce,
      'x-thaddeus-signature': headers.signature,
    },
  });
}

async function committed(author: Identity) {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const workspace = Workspace.open(log, store, {
    source: 'main',
    reader: author,
    name: 'feat',
  });
  workspace.write('src/launch.ts', enc('export const launch = true;'));
  await workspace.commit(author);
  const op = log.ops()[0];
  const ref = op.payload!;
  return {
    store,
    ref,
    heads: [...log.heads('feat')],
    bundle: encodeBundle(
      [op],
      [store.current(ref.plaintext_id)!],
      [...store.caps(ref.plaintext_id)]
    ),
  };
}

describe('timed reveal', () => {
  const before = '2029-12-31T23:59:00.000Z';
  const at = '2030-01-01T00:00:00.000Z';

  test('owner schedules a reveal and the server releases it when due', async () => {
    let clock = before;
    const owner = Identity.create();
    const local = await committed(owner);
    const srv = createServer({
      backend: new MemoryBackend(),
      now: () => clock,
    });
    await srv.fetch(
      signedPost('/repos', createRepoBody('r', owner), owner, clock)
    );
    await srv.fetch(signedPost('/repos/r/push', local.bundle, owner, clock));
    await srv.fetch(
      signedPost(
        '/repos/r/land',
        await landBody(srv.fetch, 'r', local.heads, owner),
        owner,
        clock
      )
    );

    const capability = await local.store.scheduleReveal(local.ref, at, owner);
    const scheduled = await srv.fetch(
      signedPost(
        '/repos/r/reveals',
        {
          capability: encodeCapability(capability),
          object: local.store.current(local.ref.plaintext_id)!.id,
        },
        owner,
        clock
      )
    );
    expect(scheduled.status).toBe(201);
    expect(await scheduled.json()).toMatchObject({
      object: local.ref.plaintext_id,
      at,
      scheduled: true,
      released: false,
      public: false,
    });
    const pendingPath = '/repos/r/reveals/pending';
    const pending = await srv.fetch(
      signedPost(
        pendingPath,
        { objects: [local.ref.plaintext_id] },
        owner,
        clock
      )
    );
    expect(
      ((await pending.json()) as { capabilities: string[] }).capabilities
    ).toHaveLength(1);
    expect(
      (
        await srv.fetch(
          signedPost(
            pendingPath,
            { objects: [local.ref.plaintext_id] },
            Identity.create(),
            clock
          )
        )
      ).status
    ).toBe(403);

    const beforeWire = (await (
      await srv.fetch(new Request('http://t/repos/r/pull?view=main'))
    ).json()) as Bundle;
    expect(beforeWire).not.toHaveProperty('pending');
    const beforePull = decodeBundle(beforeWire);
    expect(beforePull.caps.some((cap) => cap.grantee === publicDid())).toBe(
      false
    );
    expect(await srv.revealDue()).toBe(0);

    clock = at;
    expect(await srv.revealDue()).toBe(1);
    expect(await srv.revealDue()).toBe(0);

    const afterPull = decodeBundle(
      (await (
        await srv.fetch(new Request('http://t/repos/r/pull?view=main'))
      ).json()) as Bundle
    );
    expect(afterPull.pending).toHaveLength(0);
    expect(afterPull.caps.some((cap) => cap.grantee === publicDid())).toBe(
      true
    );
    const clone = new MemoryStore();
    await clone.ingest(
      afterPull.objects[0],
      afterPull.caps.filter(
        (cap) => cap.object === afterPull.objects[0].plaintext_id
      )
    );
    expect(dec(await clone.get(local.ref, Identity.create(), clock))).toBe(
      'export const launch = true;'
    );
  });

  test('only the owner can schedule, and a stale ciphertext is rejected', async () => {
    const owner = Identity.create();
    const stranger = Identity.create();
    const local = await committed(owner);
    const srv = createServer({
      backend: new MemoryBackend(),
      now: () => before,
    });
    await srv.fetch(
      signedPost('/repos', createRepoBody('r', owner), owner, before)
    );
    await srv.fetch(signedPost('/repos/r/push', local.bundle, owner, before));
    const capability = await local.store.scheduleReveal(local.ref, at, owner);
    const body = {
      capability: encodeCapability(capability),
      object: local.store.current(local.ref.plaintext_id)!.id,
    };

    expect(
      (await srv.fetch(signedPost('/repos/r/reveals', body, stranger, before)))
        .status
    ).toBe(403);
    expect(
      (
        await srv.fetch(
          signedPost(
            '/repos/r/reveals',
            { ...body, object: 'stale-ciphertext' },
            owner,
            before
          )
        )
      ).status
    ).toBe(409);
  });

  test('owner recall rejects a pending schedule granted by another identity', async () => {
    const owner = Identity.create();
    const attacker = Identity.create();
    const local = await committed(owner);
    const srv = createServer({
      backend: new MemoryBackend(),
      now: () => before,
    });
    await srv.fetch(
      signedPost('/repos', createRepoBody('r', owner), owner, before)
    );
    await srv.fetch(signedPost('/repos/r/push', local.bundle, owner, before));
    const forged = issueCapability({
      object: local.ref.plaintext_id,
      contentKey: newContentKey(),
      grantee: publicIdentity().toPublic(),
      grantedBy: attacker,
      notBefore: at,
    });
    const recall = encodeBundle([], [], [], [], [], [], [forged]);

    const response = await srv.fetch(
      signedPost(
        '/repos/r/revoke',
        { agent: attacker.did, recall },
        owner,
        before
      )
    );
    const body = (await response.json()) as {
      recalled: {
        accepted: { pending: number };
        rejected: { kind: string; id: string; reason: string }[];
      };
    };
    expect(body.recalled.accepted.pending).toBe(0);
    expect(body.recalled.rejected).toContainEqual({
      kind: 'reveal',
      id: local.ref.plaintext_id,
      reason: 'reveal was not granted by the repo owner',
    });
  });

  test('ordinary push cannot publish a future public capability', async () => {
    const owner = Identity.create();
    const local = await committed(owner);
    const srv = createServer({
      backend: new MemoryBackend(),
      now: () => before,
    });
    await srv.fetch(
      signedPost('/repos', createRepoBody('r', owner), owner, before)
    );
    await srv.fetch(signedPost('/repos/r/push', local.bundle, owner, before));
    const capability = await local.store.scheduleReveal(local.ref, at, owner);
    const bundle = encodeBundle(
      [],
      [local.store.current(local.ref.plaintext_id)!],
      [capability]
    );

    const response = await srv.fetch(
      signedPost('/repos/r/push', bundle, owner, before)
    );
    const result = (await response.json()) as {
      rejected: { kind: string; id: string; reason: string }[];
    };
    expect(result.rejected).toContainEqual({
      kind: 'cap',
      id: local.ref.plaintext_id,
      reason: 'future public capabilities require the reveal route',
    });
    const pull = decodeBundle(
      (await (
        await srv.fetch(new Request('http://t/repos/r/pull?view=main'))
      ).json()) as Bundle
    );
    expect(pull.caps.some((cap) => cap.grantee === publicDid())).toBe(false);
  });

  test('ordinary push rejects a public capability with an invalid timestamp', async () => {
    const owner = Identity.create();
    const local = await committed(owner);
    const srv = createServer({
      backend: new MemoryBackend(),
      now: () => before,
    });
    await srv.fetch(
      signedPost('/repos', createRepoBody('r', owner), owner, before)
    );
    await srv.fetch(signedPost('/repos/r/push', local.bundle, owner, before));
    const capability = issueCapability({
      object: local.ref.plaintext_id,
      contentKey: newContentKey(),
      grantee: publicIdentity().toPublic(),
      grantedBy: owner,
      notBefore: 'not-a-timestamp',
    });
    const bundle = encodeBundle(
      [],
      [local.store.current(local.ref.plaintext_id)!],
      [capability]
    );

    const result = (await (
      await srv.fetch(signedPost('/repos/r/push', bundle, owner, before))
    ).json()) as {
      rejected: { kind: string; id: string; reason: string }[];
    };
    expect(result.rejected).toContainEqual({
      kind: 'cap',
      id: local.ref.plaintext_id,
      reason: 'invalid public capability timestamp',
    });
  });

  test('delegate push cannot cancel a pending reveal by replacing ciphertext', async () => {
    const owner = Identity.create();
    const delegate = Identity.create();
    const local = await committed(owner);
    const srv = createServer({
      backend: new MemoryBackend(),
      now: () => before,
    });
    await srv.fetch(
      signedPost('/repos', createRepoBody('r', owner), owner, before)
    );
    await srv.fetch(signedPost('/repos/r/push', local.bundle, owner, before));
    await srv.fetch(
      signedPost(
        '/repos/r/land',
        await landBody(srv.fetch, 'r', local.heads, owner),
        owner,
        before
      )
    );
    await srv.fetch(
      signedPost(
        '/repos/r/grants',
        {
          delegation: encodeDelegation(
            signDelegation(
              {
                agent: delegate.did,
                paths: ['**'],
                maxChanges: 100,
                maxSpend: 1000,
              },
              owner
            )
          ),
        },
        owner,
        before
      )
    );
    const scheduled = await local.store.scheduleReveal(local.ref, at, owner);
    await srv.fetch(
      signedPost(
        '/repos/r/reveals',
        {
          capability: encodeCapability(scheduled),
          object: local.store.current(local.ref.plaintext_id)!.id,
        },
        owner,
        before
      )
    );

    const replacementKey = newContentKey();
    const replacement = encrypt(
      enc('export const launch = true;'),
      replacementKey
    );
    const replacementCap = issueCapability({
      object: local.ref.plaintext_id,
      contentKey: replacementKey,
      grantee: delegate.toPublic(),
      grantedBy: delegate,
    });
    const pushed = (await (
      await srv.fetch(
        signedPost(
          '/repos/r/push',
          encodeBundle([], [replacement], [replacementCap]),
          delegate,
          before
        )
      )
    ).json()) as {
      accepted: { objects: number };
      rejected: { kind: string; reason: string }[];
    };
    expect(pushed.accepted.objects).toBe(0);
    expect(pushed.rejected[0]).toMatchObject({
      kind: 'object',
      reason:
        'TypeError: ciphertext replacement with a pending reveal requires owner-authorized recall',
    });
    const pending = (await (
      await srv.fetch(
        signedPost(
          '/repos/r/reveals/pending',
          { objects: [local.ref.plaintext_id] },
          owner,
          before
        )
      )
    ).json()) as { capabilities: string[] };
    expect(pending.capabilities).toHaveLength(1);
  });

  test('same-ciphertext re-push preserves a re-wrapped capability', async () => {
    const owner = Identity.create();
    const revoked = Identity.create();
    const local = await committed(owner);
    const oldOwnerCap = local.store
      .caps(local.ref.plaintext_id)
      .find((capability) => capability.grantee === owner.did)!;
    const srv = createServer({
      backend: new MemoryBackend(),
      now: () => before,
    });
    await srv.fetch(
      signedPost('/repos', createRepoBody('r', owner), owner, before)
    );
    await srv.fetch(signedPost('/repos/r/push', local.bundle, owner, before));
    await srv.fetch(
      signedPost(
        '/repos/r/land',
        await landBody(srv.fetch, 'r', local.heads, owner),
        owner,
        before
      )
    );

    await local.store.grant(local.ref, revoked.toPublic(), owner);
    await local.store.revoke(local.ref, revoked.toPublic(), owner);
    const rotated = local.store.current(local.ref.plaintext_id)!;
    const rewrappedOwnerCap = local.store
      .caps(local.ref.plaintext_id)
      .find((capability) => capability.grantee === owner.did)!;

    await srv.fetch(
      signedPost(
        '/repos/r/push',
        encodeBundle([], [rotated], [oldOwnerCap]),
        owner,
        before
      )
    );
    await srv.fetch(
      signedPost(
        '/repos/r/push',
        encodeBundle([], [rotated], [rewrappedOwnerCap]),
        owner,
        before
      )
    );

    const pull = decodeBundle(
      (await (
        await srv.fetch(new Request('http://t/repos/r/pull?view=main'))
      ).json()) as Bundle
    );
    const ownerCaps = pull.caps.filter(
      (capability) => capability.grantee === owner.did
    );
    expect(ownerCaps).toHaveLength(1);
    expect(ownerCaps[0]?.wrapped_key).toEqual(rewrappedOwnerCap.wrapped_key);

    const clone = new MemoryStore();
    const current = pull.objects.find(
      (object) => object.plaintext_id === local.ref.plaintext_id
    )!;
    await clone.ingest(current, ownerCaps);
    expect(dec(await clone.get(local.ref, owner))).toBe(
      'export const launch = true;'
    );
  });

  test('manual reveal respects the trusted server clock', async () => {
    let clock = before;
    const owner = Identity.create();
    const local = await committed(owner);
    const srv = createServer({
      backend: new MemoryBackend(),
      now: () => clock,
    });
    await srv.fetch(
      signedPost('/repos', createRepoBody('r', owner), owner, clock)
    );
    await srv.fetch(signedPost('/repos/r/push', local.bundle, owner, clock));
    const capability = await local.store.scheduleReveal(local.ref, at, owner);
    const object = local.store.current(local.ref.plaintext_id)!.id;
    await srv.fetch(
      signedPost(
        '/repos/r/reveals',
        { capability: encodeCapability(capability), object },
        owner,
        clock
      )
    );

    const path = `/repos/r/reveals/${encodeURIComponent(local.ref.plaintext_id)}`;
    const early = await srv.fetch(signedPost(path, { object }, owner, clock));
    expect(await early.json()).toMatchObject({
      released: false,
      public: false,
    });

    clock = at;
    const due = await srv.fetch(signedPost(path, { object }, owner, clock));
    expect(await due.json()).toMatchObject({ released: true, public: true });
    const again = await srv.fetch(signedPost(path, { object }, owner, clock));
    expect(await again.json()).toMatchObject({ released: false, public: true });
  });

  test('a scheduled reveal survives a stateless server restart', async () => {
    let clock = before;
    const owner = Identity.create();
    const local = await committed(owner);
    const backend = new MemoryBackend();
    const first = createServer({ backend, now: () => clock });
    await first.fetch(
      signedPost('/repos', createRepoBody('r', owner), owner, clock)
    );
    await first.fetch(signedPost('/repos/r/push', local.bundle, owner, clock));
    await first.fetch(
      signedPost(
        '/repos/r/land',
        await landBody(first.fetch, 'r', local.heads, owner),
        owner,
        clock
      )
    );
    const capability = await local.store.scheduleReveal(local.ref, at, owner);
    await first.fetch(
      signedPost(
        '/repos/r/reveals',
        {
          capability: encodeCapability(capability),
          object: local.store.current(local.ref.plaintext_id)!.id,
        },
        owner,
        clock
      )
    );

    clock = at;
    const restarted = createServer({ backend, now: () => clock });
    expect(await restarted.revealDue()).toBe(1);
    const pull = decodeBundle(
      (await (
        await restarted.fetch(new Request('http://t/repos/r/pull?view=main'))
      ).json()) as Bundle
    );
    expect(pull.caps.some((cap) => cap.grantee === publicDid())).toBe(true);
  });

  test('one failing repo does not starve later scheduled reveals', async () => {
    const inner = new MemoryBackend();
    let armed = false;
    let failed = false;
    const backend: Backend & ReplayNonceBackend = {
      put: async (key, bytes) => {
        if (armed && !failed && key.startsWith('repo/a/cap/')) {
          failed = true;
          throw new Error('injected repo a failure');
        }
        await inner.put(key, bytes);
      },
      get: (key) => inner.get(key),
      list: (prefix) => inner.list(prefix),
      delete: (key) => inner.delete(key),
      consumeNonce: (input) => inner.consumeNonce(input),
    };
    let clock = before;
    const errors: {
      operation: 'reveal' | 'nonce-consumption';
      repo?: string;
    }[] = [];
    const srv = createServer({
      backend,
      now: () => clock,
      onError: (_error, context) => errors.push(context),
    });

    for (const name of ['a', 'b']) {
      const owner = Identity.create();
      const local = await committed(owner);
      await srv.fetch(
        signedPost('/repos', createRepoBody(name, owner), owner, clock)
      );
      await srv.fetch(
        signedPost(`/repos/${name}/push`, local.bundle, owner, clock)
      );
      await srv.fetch(
        signedPost(
          `/repos/${name}/land`,
          await landBody(srv.fetch, name, local.heads, owner),
          owner,
          clock
        )
      );
      const capability = await local.store.scheduleReveal(local.ref, at, owner);
      await srv.fetch(
        signedPost(
          `/repos/${name}/reveals`,
          {
            capability: encodeCapability(capability),
            object: local.store.current(local.ref.plaintext_id)!.id,
          },
          owner,
          clock
        )
      );
    }

    clock = at;
    armed = true;
    expect(await srv.revealDue()).toBe(1);
    expect(errors).toContainEqual({ operation: 'reveal', repo: 'a' });
    const pull = decodeBundle(
      (await (
        await srv.fetch(new Request('http://t/repos/b/pull?view=main'))
      ).json()) as Bundle
    );
    expect(pull.caps.some((cap) => cap.grantee === publicDid())).toBe(true);
  });

  test('content stays unreadable to outsiders before its reveal', async () => {
    const owner = Identity.create();
    const local = await committed(owner);
    await expectRejects(
      local.store.get(local.ref, Identity.create(), before),
      AccessDenied
    );
  });
});
