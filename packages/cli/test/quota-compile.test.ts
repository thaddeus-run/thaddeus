import { Identity, ready } from '@thaddeus.run/identity';
import { encodeHeadRecord, signHead } from '@thaddeus.run/log';
import { FileBackend } from '@thaddeus.run/persist';
import { encodeBundle, signRequest } from '@thaddeus.run/server';
import { encodeRecord, MemoryStore } from '@thaddeus.run/store';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'thaddeus-compiled-quotas-'));
const binary = join(root, 'thaddeus');
const processes = new Set<ReturnType<typeof Bun.spawn>>();
beforeAll(async () => {
  await ready();
  const build = Bun.spawnSync({
    cmd: ['bun', 'build', '--compile', '--outfile', binary, 'src/bin.ts'],
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);
});
afterAll(async () => {
  for (const process of processes) {
    process.kill();
    await process.exited;
  }
  rmSync(root, { recursive: true, force: true });
});

/** Boots the actual standalone CLI with isolated durable data and a real listener. */
async function serve(data: string, flags: string[] = []) {
  const process = Bun.spawn({
    cmd: [binary, 'serve', '--data', data, '--port', '0', ...flags],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  processes.add(process);
  const reader = process.stdout.getReader();
  let text = '';
  const url = await Promise.race([
    (async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done)
          throw new Error(`server exited before listening: ${text}`);
        text += new TextDecoder().decode(chunk.value);
        const match = /http:\/\/localhost:\d+/.exec(text);
        if (match !== null) return match[0];
      }
    })(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('server startup timed out')), 15_000)
    ),
  ]);
  return {
    url,
    stop: async () => {
      process.kill();
      await process.exited;
      reader.releaseLock();
      processes.delete(process);
    },
  };
}

/** Signs fresh real HTTP requests, including a fresh nonce on every retry. */
async function send(
  url: string,
  signer: Identity,
  method: string,
  path: string,
  value?: unknown
): Promise<Response> {
  const body = new TextEncoder().encode(
    value === undefined ? '' : JSON.stringify(value)
  );
  const h = signRequest(method, path, body, signer, new Date().toISOString());
  return fetch(`${url}${path}`, {
    method,
    ...(method === 'DELETE' ? {} : { body }),
    headers: {
      'content-type': 'application/json',
      'x-thaddeus-did': h.did,
      'x-thaddeus-timestamp': h.timestamp,
      'x-thaddeus-nonce': h.nonce,
      'x-thaddeus-signature': h.signature,
    },
  });
}
const genesis = (name: string, owner: Identity) => ({
  name,
  head: encodeHeadRecord(
    signHead(
      { repo: name, view: 'main', version: 0, previous: null, heads: [] },
      owner
    )
  ),
});

/** Builds encrypted uploads without depending on a working-copy cache. */
async function upload(owner: Identity, content: string) {
  const store = new MemoryStore();
  const ref = await store.put(new TextEncoder().encode(content), owner);
  const object = store.current(ref.plaintext_id)!;
  return {
    object,
    bundle: encodeBundle([], [object], [...store.caps(ref.plaintext_id)]),
  };
}

test('compiled serve enforces durable quotas, rate state, concurrency and two identities over HTTP', async () => {
  const data = mkdtempSync(join(root, 'quota-data-'));
  const flags = [
    '--max-repositories',
    '2',
    '--max-objects',
    '2',
    '--repository-creation-limit',
    '3',
    '--object-creation-limit',
    '2',
  ];
  let server = await serve(data, flags);
  const owner = Identity.create();
  const other = Identity.create();
  try {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        send(server.url, owner, 'POST', '/repos', genesis(`r${i}`, owner))
      )
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(2);
    expect(responses.filter((r) => r.status === 403)).toHaveLength(4);
    const names: string[] = [];
    for (const response of responses)
      if (response.status === 201)
        names.push(((await response.json()) as { name: string }).name);
    expect(
      (
        await send(
          server.url,
          other,
          'POST',
          '/repos',
          genesis('independent', other)
        )
      ).status
    ).toBe(201);
    const one = await upload(owner, 'one');
    const two = await upload(owner, 'two');
    const three = await upload(owner, 'three');
    const uploads = await Promise.all([
      send(server.url, owner, 'POST', `/repos/${names[0]}/push`, one.bundle),
      send(server.url, owner, 'POST', `/repos/${names[1]}/push`, two.bundle),
    ]);
    expect(uploads.map((r) => r.status)).toEqual([200, 200]);
    expect(
      (
        await send(
          server.url,
          owner,
          'POST',
          `/repos/${names[0]}/push`,
          one.bundle
        )
      ).status
    ).toBe(200);
    const b = new FileBackend(data);
    const before = [...(await b.list('repo/'))].sort();
    const over = await send(
      server.url,
      owner,
      'POST',
      `/repos/${names[0]}/push`,
      three.bundle
    );
    expect(over.status).toBe(403);
    expect(await over.json()).toMatchObject({ code: 'object_quota_exceeded' });
    expect([...(await b.list('repo/'))].sort()).toEqual(before);
    await server.stop();
    server = await serve(data, flags);
    expect(
      (
        await send(
          server.url,
          owner,
          'POST',
          '/repos',
          genesis('restart-over', owner)
        )
      ).status
    ).toBe(403);
    expect(
      (
        await send(
          server.url,
          owner,
          'POST',
          `/repos/${names[0]}/push`,
          three.bundle
        )
      ).status
    ).toBe(403);
    expect(
      (await send(server.url, owner, 'DELETE', `/repos/${names[0]}`)).status
    ).toBe(200);
    const rate = await send(
      server.url,
      owner,
      'POST',
      `/repos/${names[1]}/push`,
      three.bundle
    );
    expect(rate.status).toBe(429);
    expect(rate.headers.get('retry-after')).not.toBeNull();
    expect(await rate.json()).toMatchObject({
      code: 'object_creation_rate_limited',
    });
    expect(
      (
        await send(
          server.url,
          other,
          'POST',
          '/repos/independent/push',
          three.bundle
        )
      ).status
    ).toBe(200);
    expect(
      (
        await send(
          server.url,
          owner,
          'POST',
          '/repos',
          genesis('replacement', owner)
        )
      ).status
    ).toBe(201);
    expect(
      (await send(server.url, owner, 'DELETE', '/repos/replacement')).status
    ).toBe(200);
    const repoRate = await send(
      server.url,
      owner,
      'POST',
      '/repos',
      genesis('rate-over', owner)
    );
    expect(repoRate.status).toBe(429);
    expect(repoRate.headers.get('retry-after')).not.toBeNull();
    await server.stop();
    server = await serve(data, flags);
    expect(
      (
        await send(
          server.url,
          owner,
          'POST',
          '/repos',
          genesis('still-rate-over', owner)
        )
      ).status
    ).toBe(429);
  } finally {
    await server.stop();
  }
}, 120_000);

test('compiled server rejects competing object allocations and reclaims deleted capacity', async () => {
  const data = mkdtempSync(join(root, 'object-race-'));
  const owner = Identity.create();
  const flags = ['--max-repositories', '2', '--max-objects', '2'];
  let server = await serve(data, flags);
  try {
    for (const name of ['a', 'b'])
      expect(
        (await send(server.url, owner, 'POST', '/repos', genesis(name, owner)))
          .status
      ).toBe(201);
    const items = await Promise.all(
      Array.from({ length: 8 }, (_, i) => upload(owner, `concurrent-${i}`))
    );
    const responses = await Promise.all(
      items.map((item, i) =>
        send(
          server.url,
          owner,
          'POST',
          `/repos/${i % 2 === 0 ? 'a' : 'b'}/push`,
          item.bundle
        )
      )
    );
    expect(
      responses.filter((response) => response.status === 200)
    ).toHaveLength(2);
    expect(
      responses.filter((response) => response.status === 403)
    ).toHaveLength(6);
    const backend = new FileBackend(data);
    const expectedKeys: string[] = [];
    for (const [i, response] of responses.entries()) {
      const key = `repo/${i % 2 === 0 ? 'a' : 'b'}/obj/${items[i].object.id}`;
      if (response.status === 200) expectedKeys.push(key);
      else {
        expect(await response.json()).toEqual({
          error: 'object_quota_exceeded',
          code: 'object_quota_exceeded',
        });
        expect(response.headers.get('retry-after')).toBeNull();
        expect(await backend.get(key)).toBeUndefined();
      }
    }
    expect(
      (await backend.list('repo/'))
        .filter((key) => /\/obj\/[^/]+$/.test(key))
        .sort()
    ).toEqual(expectedKeys.sort());
    await server.stop();
    server = await serve(data, flags);
    const extra = await upload(owner, 'after restart');
    expect(
      (await send(server.url, owner, 'POST', '/repos/a/push', extra.bundle))
        .status
    ).toBe(403);
    for (const name of ['a', 'b'])
      expect(
        (await send(server.url, owner, 'DELETE', `/repos/${name}`)).status
      ).toBe(200);
    expect(await backend.list('repo/')).toEqual([]);
    expect(
      (
        await send(
          server.url,
          owner,
          'POST',
          '/repos',
          genesis('reclaimed', owner)
        )
      ).status
    ).toBe(201);
    expect(
      (
        await send(
          server.url,
          owner,
          'POST',
          '/repos/reclaimed/push',
          extra.bundle
        )
      ).status
    ).toBe(200);
  } finally {
    await server.stop();
  }
}, 120_000);

test('compiled server adopts flat legacy data and preserves quotas through sharded writes', async () => {
  const data = mkdtempSync(join(root, 'legacy-data-'));
  const owner = Identity.create();
  const other = Identity.create();
  const flags = ['--max-repositories', '1', '--max-objects', '1'];
  let server = await serve(data, flags);
  try {
    const item = await upload(owner, 'legacy ciphertext');
    expect(
      (
        await send(
          server.url,
          owner,
          'POST',
          '/repos',
          genesis('legacy', owner)
        )
      ).status
    ).toBe(201);
    expect(
      (await send(server.url, owner, 'POST', '/repos/legacy/push', item.bundle))
        .status
    ).toBe(200);
    await server.stop();
    const backend = new FileBackend(data);
    // Reconstruct the supported pre-upgrade disk layout while the server is stopped.
    const legacyKeys = [...(await backend.list('repo/'))];
    for (const key of legacyKeys) {
      const bytes = (await backend.get(key))!;
      await backend.delete(key);
      writeFileSync(join(data, encodeURIComponent(key)), bytes);
    }
    for (const key of await backend.list('quota/v1/'))
      await backend.delete(key);
    expect(await backend.list('quota/v1/')).toEqual([]);
    const objectKey = `repo/legacy/obj/${item.object.id}`;
    expect(existsSync(join(data, encodeURIComponent(objectKey)))).toBe(true);
    server = await serve(data, flags);
    expect((await fetch(`${server.url}/repos/legacy/views/main`)).status).toBe(
      200
    );
    expect(
      (await send(server.url, owner, 'POST', '/repos/legacy/push', item.bundle))
        .status
    ).toBe(200);
    const extra = await upload(other, 'new sharded ciphertext');
    const over = await send(
      server.url,
      owner,
      'POST',
      '/repos/legacy/push',
      extra.bundle
    );
    expect(over.status).toBe(403);
    expect(await over.json()).toMatchObject({ code: 'object_quota_exceeded' });
    const repoOver = await send(
      server.url,
      owner,
      'POST',
      '/repos',
      genesis('over', owner)
    );
    expect(repoOver.status).toBe(403);
    expect(await repoOver.json()).toMatchObject({
      code: 'repository_quota_exceeded',
    });
    expect([...(await backend.list('repo/'))].sort()).toEqual(
      legacyKeys.sort()
    );
    expect(
      (
        await send(
          server.url,
          other,
          'POST',
          '/repos',
          genesis('independent', other)
        )
      ).status
    ).toBe(201);
    expect(
      (
        await send(
          server.url,
          other,
          'POST',
          '/repos/independent/push',
          extra.bundle
        )
      ).status
    ).toBe(200);
    const newKey = `repo/independent/obj/${extra.object.id}`;
    const shard = createHash('sha256').update(newKey).digest('hex').slice(0, 2);
    expect(
      existsSync(join(data, '.records-v1', shard, encodeURIComponent(newKey)))
    ).toBe(true);
    expect(existsSync(join(data, encodeURIComponent(newKey)))).toBe(false);
    expect(
      (await send(server.url, owner, 'DELETE', '/repos/legacy')).status
    ).toBe(200);
    for (const key of legacyKeys)
      expect(existsSync(join(data, encodeURIComponent(key)))).toBe(false);
    expect(await backend.list('repo/legacy/')).toEqual([]);
    expect(
      (
        await send(
          server.url,
          owner,
          'POST',
          '/repos',
          genesis('replacement', owner)
        )
      ).status
    ).toBe(201);
    expect(
      (
        await send(
          server.url,
          owner,
          'POST',
          '/repos/replacement/push',
          item.bundle
        )
      ).status
    ).toBe(200);
  } finally {
    await server.stop();
  }
}, 120_000);

test('compiled serve accepts the exact object byte boundary and rejects one byte over it', async () => {
  const owner = Identity.create();
  const item = await upload(owner, 'byte boundary');
  for (const delta of [0, -1]) {
    const data = mkdtempSync(join(root, 'byte-data-'));
    const server = await serve(data, [
      '--max-object-bytes',
      String(encodeRecord(item.object).byteLength + delta),
    ]);
    try {
      expect(
        (
          await send(
            server.url,
            owner,
            'POST',
            '/repos',
            genesis('bytes', owner)
          )
        ).status
      ).toBe(201);
      const response = await send(
        server.url,
        owner,
        'POST',
        '/repos/bytes/push',
        item.bundle
      );
      expect(response.status).toBe(delta === 0 ? 200 : 403);
      if (delta < 0) {
        expect(await response.json()).toMatchObject({
          code: 'object_bytes_quota_exceeded',
        });
        expect(await new FileBackend(data).list('repo/bytes/obj/')).toEqual([]);
      }
    } finally {
      await server.stop();
    }
  }
}, 120_000);

test('compiled CLI clone, push, second upload, pull and repository pagination still work', async () => {
  const data = mkdtempSync(join(root, 'workflow-data-'));
  const identityHome = mkdtempSync(join(root, 'identity-'));
  const first = mkdtempSync(join(root, 'first-'));
  const second = mkdtempSync(join(root, 'second-'));
  const server = await serve(data, [
    '--default-page-size',
    '1',
    '--max-page-size',
    '1',
  ]);
  // Only child processes receive the isolated config home; the test runner and
  // developer's identity/config are never modified.
  const cli = async (args: string[], cwd = identityHome): Promise<string> => {
    const child = Bun.spawn({
      cmd: [binary, ...args],
      cwd,
      env: { ...process.env, HOME: identityHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${args.join(' ')}: ${stdout} ${stderr}`);
    expect(stderr).toBe('');
    return stdout;
  };
  try {
    await cli(['identity', 'init']);
    for (const name of ['workflow', 'second', 'third'])
      await cli(['create', name, '--server', server.url]);
    const repos = await cli(['repos', '--server', server.url, '--json']);
    expect(repos).toContain('workflow');
    expect(repos).toContain('second');
    expect(repos).toContain('third');
    await cli(['clone', 'workflow', first, '--server', server.url]);
    writeFileSync(join(first, 'hello.txt'), 'first upload\n');
    expect(await cli(['push'], first)).toContain('published');
    await cli(['clone', 'workflow', second, '--server', server.url]);
    expect(readFileSync(join(second, 'hello.txt'), 'utf8')).toBe(
      'first upload\n'
    );
    writeFileSync(join(first, 'hello.txt'), 'second upload\n');
    expect(await cli(['push'], first)).toContain('published');
    await cli(['pull'], second);
    expect(readFileSync(join(second, 'hello.txt'), 'utf8')).toBe(
      'second upload\n'
    );
  } finally {
    await server.stop();
  }
}, 120_000);

test('compiled server reclaims a failed journal write after filesystem repair and restart', async () => {
  const data = mkdtempSync(join(root, 'failed-data-'));
  const owner = Identity.create();
  const item = await upload(owner, 'retry after failure');
  const flags = ['--max-objects', '1', '--object-creation-limit', '1'];
  let server = await serve(data, flags);
  try {
    expect(
      (
        await send(
          server.url,
          owner,
          'POST',
          '/repos',
          genesis('failure', owner)
        )
      ).status
    ).toBe(201);
    const key = `repo/failure/obj/${item.object.id}`;
    const backend = new FileBackend(data);
    const before = [...(await backend.list('repo/'))].sort();
    // Reads and nonce consumption remain available, but the journal's first
    // generic backend write cannot create its staging directory.
    const blocked = join(data, '.staging');
    rmSync(blocked, { recursive: true });
    writeFileSync(blocked, 'injected staging-directory fault');
    const failure = await send(
      server.url,
      owner,
      'POST',
      '/repos/failure/push',
      item.bundle
    );
    expect(failure.status).toBe(503);
    expect(await failure.json()).toMatchObject({
      code: 'quota_storage_unavailable',
    });
    expect([...(await backend.list('repo/'))].sort()).toEqual(before);
    expect(await backend.get('quota/v1/journal')).toBeUndefined();
    await server.stop();
    rmSync(blocked, { recursive: true });
    server = await serve(data, flags);
    expect(
      (
        await send(
          server.url,
          owner,
          'POST',
          '/repos/failure/push',
          item.bundle
        )
      ).status
    ).toBe(200);
    expect(await new FileBackend(data).list('repo/failure/obj/')).toEqual([
      key,
    ]);
  } finally {
    await server.stop();
  }
}, 120_000);
