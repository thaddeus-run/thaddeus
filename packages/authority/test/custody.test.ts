import { MemoryBackend } from '@thaddeus.run/persist';
import { decodeRecord } from '@thaddeus.run/store';
import { describe, expect, test } from 'bun:test';
import sodium from 'libsodium-wrappers-sumo';

import { Authority, KeyCustody, LocalRootKey, proveRevoke } from '../src';
import {
  bytes,
  fileBackend,
  Identity,
  issue,
  member,
  policy,
  refused,
  tempDir,
  text,
  use,
  world,
} from './helpers';

const TENANT = 'acme';
const GRANTS = [
  { repo: 'app', scopes: ['read', 'edit'] as const, paths: ['src/**'] },
];

async function setup(options: Parameters<typeof world>[0] = {}) {
  const w = await world(options);
  const admin = Identity.create();
  const agent = Identity.create();
  await w.authority.createTenant(
    TENANT,
    policy([admin], [member(agent, 'agent', [...GRANTS])])
  );
  const token = await issue(w, agent, {
    tenant: TENANT,
    kind: 'agent',
    grants: [...GRANTS],
  });
  const as = (scope: 'read' | 'edit', path = 'src/a.ts') =>
    use(w, agent, token, { scope, tenant: TENANT, repo: 'app', paths: [path] });
  return { w, admin, agent, token, as };
}

// Every byte string the backend holds, decoded where it is a record, so a
// test can search storage for something that must not be there.
async function storedBytes(backend: MemoryBackend): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const key of await backend.list('')) {
    const raw = await backend.get(key);
    if (raw !== undefined) out.push(raw);
  }
  return out;
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

describe('key custody', () => {
  test('edit seals and read opens, and both are audited', async () => {
    const { w, agent, as } = await setup();
    const sealed = await w.custody.seal(
      await as('edit'),
      'src/a.ts',
      bytes('hello')
    );
    expect(
      text(await w.custody.open(await as('read'), 'src/a.ts', sealed))
    ).toBe('hello');
    const log = await w.authority.audit(TENANT);
    const plaintext = log.filter((r) => r.event.startsWith('plaintext.'));
    expect(
      plaintext.map((r) => [r.event, r.outcome, r.subject, r.paths])
    ).toEqual([
      ['plaintext.write', 'allow', agent.did, ['src/a.ts']],
      ['plaintext.read', 'allow', agent.did, ['src/a.ts']],
    ]);
    expect(plaintext.every((r) => typeof r.credential === 'string')).toBe(true);
  });

  test('the wrong scope or an unauthorized path is refused and audited', async () => {
    const { w, as } = await setup();
    const sealed = await w.custody.seal(
      await as('edit'),
      'src/a.ts',
      bytes('x')
    );
    await refused(
      w.custody.open(await as('edit'), 'src/a.ts', sealed),
      'scope_denied'
    );
    await refused(
      w.custody.seal(await as('read'), 'src/a.ts', bytes('y')),
      'scope_denied'
    );
    await refused(
      w.custody.open(await as('read'), 'src/b.ts', sealed),
      'scope_denied'
    );
    const denials = (await w.authority.audit(TENANT)).filter(
      (r) => r.event.startsWith('plaintext.') && r.outcome === 'deny'
    );
    expect(denials.map((r) => r.code)).toEqual([
      'scope_denied',
      'scope_denied',
      'scope_denied',
    ]);
  });

  test('content sealed for one path does not open as another', async () => {
    const { w, agent, token } = await setup();
    const edit = await use(w, agent, token, {
      scope: 'edit',
      tenant: TENANT,
      repo: 'app',
      paths: ['src/**'],
    });
    const sealed = await w.custody.seal(edit, 'src/a.ts', bytes('a'));
    const read = await use(w, agent, token, {
      scope: 'read',
      tenant: TENANT,
      repo: 'app',
      paths: ['src/**'],
    });
    await refused(w.custody.open(read, 'src/b.ts', sealed), 'decrypt_failed');
  });

  test('storage holds the data key only wrapped, and never the plaintext', async () => {
    const backend = new MemoryBackend();
    const { w, as } = await setup({ backend });
    const secret = bytes('the plaintext nobody should find on disk');
    await w.custody.seal(await as('edit'), 'src/a.ts', secret);

    // Recover the data key the way only the root key holder can.
    const [keyName] = await backend.list('authority/key/');
    const record = decodeRecord(
      (await backend.get(keyName ?? '')) ?? new Uint8Array()
    ) as {
      wrapped: Uint8Array;
    };
    await sodium.ready;
    const n = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    const dataKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      record.wrapped.subarray(n),
      new TextEncoder().encode(
        JSON.stringify(['thaddeus.authority.data-key.v1', TENANT, 'app', 1])
      ),
      record.wrapped.subarray(0, n),
      w.rootBytes
    );
    expect(dataKey).toHaveLength(32);
    for (const stored of await storedBytes(backend)) {
      expect(contains(stored, dataKey)).toBe(false);
      expect(contains(stored, secret)).toBe(false);
      expect(contains(stored, w.rootBytes)).toBe(false);
    }
    // Nothing on the custody or root key objects shows key bytes either.
    expect(JSON.stringify(w.custody)).toBe('{}');
    expect(Object.keys(w.root)).toEqual(['id']);
  });

  test('another root key cannot open content after a restart', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const { w, as } = await setup({ backend: fileBackend(dir) });
      const sealed = await w.custody.seal(
        await as('edit'),
        'src/a.ts',
        bytes('kept')
      );
      const read = await as('read');

      const same = new KeyCustody({
        authority: w.authority,
        backend: fileBackend(dir),
        root: LocalRootKey.fromBytes(w.rootBytes),
      });
      expect(text(await same.open(read, 'src/a.ts', sealed))).toBe('kept');

      const wrong = new KeyCustody({
        authority: w.authority,
        backend: fileBackend(dir),
        root: LocalRootKey.fromBytes(
          crypto.getRandomValues(new Uint8Array(32))
        ),
      });
      await refused(
        wrong.open(await as('read'), 'src/a.ts', sealed),
        'decrypt_failed'
      );
    } finally {
      cleanup();
    }
  });

  test('a wrapped data key copied to another repository does not unwrap there', async () => {
    const backend = new MemoryBackend();
    const w = await world({ backend });
    const admin = Identity.create();
    const agent = Identity.create();
    const both = [
      { repo: 'app', scopes: ['read', 'edit'] as const, paths: ['**'] },
      { repo: 'lib', scopes: ['read', 'edit'] as const, paths: ['**'] },
    ];
    await w.authority.createTenant(
      TENANT,
      policy([admin], [member(agent, 'agent', both)])
    );
    const token = await issue(w, agent, {
      tenant: TENANT,
      kind: 'agent',
      grants: both,
    });
    const act = (scope: 'read' | 'edit', repo: string) =>
      use(w, agent, token, { scope, tenant: TENANT, repo, paths: ['a.ts'] });
    await w.custody.seal(await act('edit', 'app'), 'a.ts', bytes('app'));

    const [appKey = ''] = await backend.list('authority/key/');
    const probe = await w.custody.seal(
      await act('edit', 'lib'),
      'a.ts',
      bytes('lib')
    );
    const libKey =
      (await backend.list('authority/key/')).find((k) => k !== appKey) ?? '';
    // Overwrite lib's wrapped key with app's.
    await backend.put(libKey, (await backend.get(appKey)) ?? new Uint8Array());

    const reopened = new KeyCustody({
      authority: w.authority,
      backend,
      root: w.root,
    });
    await refused(
      reopened.open(await act('read', 'lib'), 'a.ts', probe),
      'decrypt_failed'
    );
  });

  test('if the audit record cannot be written, the plaintext is withheld', async () => {
    const backend = new MemoryBackend();
    const { w, as } = await setup({ backend });
    const sealed = await w.custody.seal(
      await as('edit'),
      'src/a.ts',
      bytes('secret')
    );
    const read = await as('read');
    const put = backend.put.bind(backend);
    backend.put = async (key, value) => {
      if (key.startsWith('authority/audit/'))
        throw new Error('audit disk full');
      return put(key, value);
    };
    let caught: unknown;
    try {
      await w.custody.open(read, 'src/a.ts', sealed);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe('audit disk full');
  });

  test('a revocation that lands while the read is audited withholds the plaintext', async () => {
    const backend = new MemoryBackend();
    const { w, admin, agent, as } = await setup({ backend });
    const sealed = await w.custody.seal(
      await as('edit'),
      'src/a.ts',
      bytes('secret')
    );
    const read = await as('read');
    const put = backend.put.bind(backend);
    let revoking = false;
    backend.put = async (key, value) => {
      const record = key.startsWith('authority/audit/')
        ? (decodeRecord(value) as { event: string; outcome: string })
        : undefined;
      if (
        !revoking &&
        record?.event === 'plaintext.read' &&
        record.outcome === 'allow'
      ) {
        revoking = true;
        const request = {
          tenant: TENANT,
          actor: admin.did,
          target: { did: agent.did },
        };
        await w.authority.revoke(
          request,
          proveRevoke(admin, request, { now: w.clock.now() })
        );
      }
      return put(key, value);
    };
    await refused(w.custody.open(read, 'src/a.ts', sealed), 'revoked');
  });

  test('authorizations from another authority are refused', async () => {
    const { w, as } = await setup();
    const sealed = await w.custody.seal(
      await as('edit'),
      'src/a.ts',
      bytes('x')
    );
    const other = await Authority.open({
      backend: new MemoryBackend(),
      signer: Identity.create(),
    });
    const foreign = new KeyCustody({
      authority: other,
      backend: w.backend,
      root: w.root,
    });
    await refused(
      foreign.open(await as('read'), 'src/a.ts', sealed),
      'bad_credential'
    );
    // Nor does a look-alike object pass for an authorization.
    const fake = Object.fromEntries(
      Object.entries(await as('read'))
    ) as unknown as Parameters<typeof w.custody.open>[0];
    await refused(w.custody.open(fake, 'src/a.ts', sealed), 'bad_credential');
  });
});
