import { AuthorityError, describeAttribution } from '@thaddeus.run/authority';
import { Client } from '@thaddeus.run/client';
import { Identity } from '@thaddeus.run/identity';
import { signHead } from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import { Platform } from '@thaddeus.run/platform';
import { encodeRecord, unwrapKey } from '@thaddeus.run/store';
import { describe, expect, test } from 'bun:test';

import {
  decodeConsent,
  type Evidence,
  Migrator,
  restoreArchive,
  signConsent,
  Source,
  transfer,
  verifyArchive,
} from '../src';
import {
  Author,
  bytes,
  contains,
  keyless,
  readSource,
  refused,
  service,
  type Service,
  steps,
  storedBytes,
  tempDir,
  tenant,
  text,
} from './helpers';

const HOUR = 60 * 60 * 1000;

// A keyless repository with a real history: two owner versions, a change a
// delegate uploaded and the owner landed, a deletion, and a second view.
async function world() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const owner = Identity.fromSeed(seed);
  const delegate = Identity.create();
  const server = keyless();
  const web = await Author.create(server, owner, 'acme/web');
  await web.publish({
    'README.md': 'hello readme',
    'src/main.rs': 'fn main() {}',
  });
  await web.publish({ 'src/main.rs': 'fn main() { println!("hi"); }' });
  await web.grant(delegate);
  const guest = await Author.join(server, delegate, 'acme/web');
  const guestHeads = await guest.commit(
    { 'src/auth.rs': 'fn login() { secret_login_body() }' },
    { shareWith: owner }
  );
  await web.land(guestHeads);
  await web.client.pull('acme/web', web.repo, new MemoryBackend());
  await web.publish({ 'README.md': null });
  await web.client.createView('acme/web', web.repo, 'release', [
    ...web.repo.log.heads('main'),
  ]);
  const s = await service();
  await tenant(s, 'acme', [
    { who: owner, repos: ['web'] },
    { who: delegate, repos: ['web'] },
  ]);
  return { seed, owner, delegate, server, web, guest, s };
}

async function migrate(
  s: Service,
  source: Source,
  owner: Identity,
  target: { tenant: string; repo: string }
) {
  const token = source.consent(owner, { service: s.authority.did, ...target });
  const st = await steps(s, owner, target.tenant, target.repo);
  await s.migrator.begin(st.edit, token, source.evidence);
  await transfer(source, owner, s.migrator, st.edit, token);
  const report = await s.migrator.verify(st.read);
  const cut = await s.migrator.cutover(st.integrate, await source.latest());
  return { token, st, report, cut };
}

// The files a keyless client checks out at a view, read with `who`'s keys.
async function checkout(
  repo: Awaited<ReturnType<typeof readSource>>,
  owner: Identity,
  view: string
) {
  const out: Record<string, string> = {};
  const tip = repo.views.find((v) => v.view === view)?.history.at(-1);
  for (const entry of tip?.entries ?? []) {
    out[entry.path] = text(await repo.plaintext(owner, entry));
  }
  return out;
}

describe('the owner migrates a keyless repository', () => {
  test('every version is verified before cutover and served from the trusted format after', async () => {
    const { owner, server, s } = await world();
    const source = await readSource(server, owner, 'acme/web');
    expect(source.views.map((v) => v.view)).toEqual(['main', 'release']);
    const main = source.views[0];
    expect(main?.chain.map((h) => h.version)).toEqual([0, 1, 2, 3, 4]);

    const token = source.consent(owner, {
      service: s.authority.did,
      tenant: 'acme',
      repo: 'web',
    });
    expect(decodeConsent(token).transfer).toBe('owner-decrypts');
    const st = await steps(s, owner, 'acme', 'web');
    const progress = await s.migrator.begin(st.edit, token, source.evidence);
    expect(progress.files).toBe(source.files().length);
    expect(progress.missing).toBe(progress.files);
    expect((await s.migrator.status('acme', 'web'))?.state).toBe('importing');

    const sent = await transfer(source, owner, s.migrator, st.edit, token);
    expect(sent).toEqual({ stored: progress.files, present: 0, remaining: 0 });
    expect(await s.migrator.missing(st.edit)).toEqual([]);

    const report = await s.migrator.verify(st.read);
    expect(report.views.map((v) => v.view)).toEqual(['main', 'release']);
    expect(report.views[0]?.versions.map((v) => v.head)).toEqual(
      main?.chain.map((h) => h.id)
    );
    expect(report.views[0]?.versions.map((v) => v.revision)).toEqual(
      main?.history.map((h) => h.revision)
    );
    expect(report.views[0]?.versions.map((v) => v.files)).toEqual([
      0, 2, 2, 3, 2,
    ]);
    expect((await s.migrator.status('acme', 'web'))?.state).toBe('verified');

    const cut = await s.migrator.cutover(st.integrate, await source.latest());
    expect(cut.views.map((v) => [v.view, v.head.version])).toEqual([
      ['main', 4],
      ['release', 0],
    ]);
    // The service recorded the advancement for the owner's credential; it
    // is not presented as anyone's signature.
    const head = await s.authority.head('acme', 'web', 'main');
    expect(head?.revision).toBe(main?.history.at(-1)?.revision);
    const attribution = describeAttribution(head!);
    expect(attribution.recordedBy).toBe(s.authority.did);
    expect(attribution.requestedBy.principal).toBe(owner.did);
    expect(attribution.signedBy).toEqual([]);
    expect((await s.migrator.status('acme', 'web'))?.state).toBe('cutover');

    // A reader of the trusted format sees the same files as a keyless clone.
    const tree = await s.migrator.tree(st.read, 'main');
    const served: Record<string, string> = {};
    for (const entry of tree) {
      served[entry.path] = text(
        await s.migrator.read(st.read, 'main', entry.path)
      );
    }
    expect(served).toEqual(await checkout(source, owner, 'main'));
    expect(served).toEqual({
      'src/auth.rs': 'fn login() { secret_login_body() }',
      'src/main.rs': 'fn main() { println!("hi"); }',
    });
  });

  test('the original signed records are kept unchanged and the export is deterministic', async () => {
    const { owner, server, s } = await world();
    const source = await readSource(server, owner, 'acme/web');
    const { st, report } = await migrate(s, source, owner, {
      tenant: 'acme',
      repo: 'web',
    });
    const archive = await s.migrator.export(st.read);
    expect(await s.migrator.export(st.read)).toBe(archive);
    const checked = verifyArchive(archive, { service: s.authority.did });
    expect(checked.report).toEqual(report);

    // An archive that was edited after export does not verify.
    const parsed = JSON.parse(archive);
    await refused(
      () =>
        verifyArchive(
          JSON.stringify({ ...parsed, report: { ...parsed.report, bytes: 0 } })
        ),
      'mismatch'
    );
    const [firstFile, ...otherFiles] = parsed.files;
    await refused(
      () =>
        verifyArchive(
          JSON.stringify({
            ...parsed,
            files: [
              {
                ...firstFile,
                data: Buffer.from('edited').toString('base64url'),
              },
              ...otherFiles,
            ],
          })
        ),
      'content_mismatch'
    );
    await refused(
      () => verifyArchive(JSON.stringify({ ...parsed, files: otherFiles })),
      'incomplete'
    );
    await refused(
      () => verifyArchive(archive, { service: Identity.create().did }),
      'wrong_service'
    );

    // Same ids, same signature bytes, for every kind of record.
    const sigs = (e: Evidence) =>
      [
        ...e.heads.map((h) => `${h.id}:${Buffer.from(h.sig).toString('hex')}`),
        ...e.ops.map((o) => `${o.id}:${Buffer.from(o.sig).toString('hex')}`),
        ...e.caps.map((c) => Buffer.from(c.sig).toString('hex')),
        ...e.objects.map((o) => o.id),
      ].sort();
    expect(sigs(checked.evidence)).toEqual(sigs(source.evidence));
    expect(checked.evidence.ops.length).toBeGreaterThan(0);
    expect(checked.evidence.caps.length).toBeGreaterThan(0);

    // Rollback path: the archive's original records restore a keyless
    // repository that the owner reads with its own keys.
    const restoredBackend = new MemoryBackend();
    await restoreArchive(archive, restoredBackend);
    const restored = await new Platform().openDurable(
      'acme/web',
      restoredBackend
    );
    expect(restored.headRecords.history('main').map((h) => h.id)).toEqual(
      source.views[0]?.chain.map((h) => h.id)
    );
    const files: Record<string, string> = {};
    for (const [path, { ref }] of restored.log.materialize('main', owner)) {
      if (ref !== null)
        files[path] = text(await restored.store.get(ref, owner));
    }
    expect(files).toEqual(await checkout(source, owner, 'main'));
  });

  test('no client key and no plaintext reaches the service', async () => {
    const { seed, owner, server, s } = await world();
    const source = await readSource(server, owner, 'acme/web');
    await migrate(s, source, owner, { tenant: 'acme', repo: 'web' });
    const stored = await storedBytes(s.backend as MemoryBackend);
    expect(stored.length).toBeGreaterThan(0);
    expect(contains(stored, seed)).toBe(false);
    for (const cap of source.evidence.caps) {
      if (cap.grantee !== owner.did) continue;
      expect(contains(stored, unwrapKey(cap, owner))).toBe(false);
    }
    for (const plain of [
      'secret_login_body',
      'println!("hi")',
      'hello readme',
    ]) {
      expect(contains(stored, bytes(plain))).toBe(false);
    }
  });
});

describe('ownership and explicit authorization', () => {
  test('only the owner the chains name can consent or run a step', async () => {
    const { owner, delegate, server, s } = await world();
    const source = await readSource(server, owner, 'acme/web');
    const target = { service: s.authority.did, tenant: 'acme', repo: 'web' };

    // The delegate can read the source, but cannot consent for it.
    expect(() => source.consent(delegate, target)).toThrow(/owned by/);
    const forged = signConsent(delegate, {
      ...target,
      source: { server: server.url, repo: 'acme/web' },
      views: source.pinned(),
    });
    const theirs = await steps(s, delegate, 'acme', 'web');
    await refused(
      s.migrator.begin(theirs.edit, forged, source.evidence),
      'not_owner'
    );

    // The owner's consent does not let someone else run the migration.
    const token = source.consent(owner, target);
    await refused(
      s.migrator.begin(theirs.edit, token, source.evidence),
      'not_owner'
    );
    const mine = await steps(s, owner, 'acme', 'web');
    await s.migrator.begin(mine.edit, token, source.evidence);
    await refused(s.migrator.missing(theirs.edit), 'not_owner');
    await refused(
      transfer(source, owner, s.migrator, theirs.edit, token),
      'not_owner'
    );
    await refused(s.migrator.rollback(theirs.integrate), 'not_owner');

    // A member who owns another source cannot take over the pending target.
    const tools = await Author.create(server, delegate, 'guest/tools');
    await tools.publish({ 'tool.sh': 'echo tool' });
    const theirSource = await readSource(server, delegate, 'guest/tools');
    const takeover = theirSource.consent(delegate, target);
    await refused(
      s.migrator.begin(theirs.edit, takeover, theirSource.evidence),
      'wrong_state'
    );
    expect((await s.migrator.status('acme', 'web'))?.consent).toBe(
      decodeConsent(token).id
    );
  });

  test('a consent names one service and one target, and expires', async () => {
    const { owner, server, s } = await world();
    const source = await readSource(server, owner, 'acme/web');
    const st = await steps(s, owner, 'acme', 'web');
    const elsewhere = source.consent(owner, {
      service: Identity.create().did,
      tenant: 'acme',
      repo: 'web',
    });
    await refused(
      s.migrator.begin(st.edit, elsewhere, source.evidence),
      'wrong_service'
    );
    const otherRepo = source.consent(owner, {
      service: s.authority.did,
      tenant: 'acme',
      repo: 'api',
    });
    await refused(
      s.migrator.begin(st.edit, otherRepo, source.evidence),
      'wrong_target'
    );

    const token = source.consent(
      owner,
      {
        service: s.authority.did,
        tenant: 'acme',
        repo: 'web',
      },
      { now: s.clock.now(), lifetimeMs: HOUR }
    );
    await s.migrator.begin(st.edit, token, source.evidence);
    s.clock.advance(HOUR);
    // Plaintext stops moving the moment the consent lapses.
    const [first] = await s.migrator.missing(st.edit);
    await refused(
      s.migrator.put(st.edit, {
        ...first,
        bytes: await source.plaintext(owner, first),
      }),
      'expired'
    );
  });

  test('the owner client sends plaintext only to the service its consent names', async () => {
    const { owner, server, s } = await world();
    const source = await readSource(server, owner, 'acme/web');
    const other = await service();
    await tenant(other, 'acme', [{ who: owner, repos: ['web'] }]);
    const token = source.consent(owner, {
      service: s.authority.did,
      tenant: 'acme',
      repo: 'web',
    });
    const there = await steps(other, owner, 'acme', 'web');
    await refused(
      transfer(source, owner, other.migrator, there.edit, token),
      'wrong_service'
    );
    expect(await other.backend.list('trusted/')).toEqual([]);
  });

  test('every step needs its own scope over the whole repository', async () => {
    const { owner, server, s } = await world();
    const source = await readSource(server, owner, 'acme/web');
    const token = source.consent(owner, {
      service: s.authority.did,
      tenant: 'acme',
      repo: 'web',
    });
    const st = await steps(s, owner, 'acme', 'web');
    await refused(
      s.migrator.begin(st.read, token, source.evidence),
      'scope_denied'
    );
    await refused(s.migrator.verify(st.edit), 'scope_denied');
    await refused(s.migrator.cutover(st.read, []), 'scope_denied');

    // A tenant member with only read cannot get an edit authorization at all.
    const reader = Identity.create();
    const t = await service();
    await tenant(t, 'acme', [
      { who: reader, repos: ['web'], scopes: ['read'] },
    ]);
    let caught: unknown;
    try {
      await steps(t, reader, 'acme', 'web', ['read', 'edit']);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AuthorityError);
    expect((caught as AuthorityError).code).toBe('policy_denied');

    // A narrower path authorization is refused for repository-wide steps.
    const narrow = {
      scope: 'edit' as const,
      tenant: 'acme',
      repo: 'web',
      paths: ['src/**'],
    };
    const request = {
      service: s.authority.did,
      tenant: 'acme',
      principal: owner.did,
      subject: owner.did,
      kind: 'human' as const,
      grants: [{ repo: 'web', scopes: ['edit' as const], paths: ['src/**'] }],
    };
    const { proveAction, proveIssue } = await import('@thaddeus.run/authority');
    const issued = await s.authority.issue(
      request,
      proveIssue(owner, request, { now: s.clock.now() })
    );
    const auth = await s.authority.authorize(
      issued.token,
      narrow,
      proveAction(owner, issued.token, narrow, { now: s.clock.now() })
    );
    await refused(
      s.migrator.begin(auth, token, source.evidence),
      'scope_denied'
    );
  });
});

describe('evidence and content are checked, not trusted', () => {
  test('missing, extra, forged or relabelled records are refused', async () => {
    const { owner, delegate, server, s } = await world();
    const source = await readSource(server, owner, 'acme/web');
    const token = source.consent(owner, {
      service: s.authority.did,
      tenant: 'acme',
      repo: 'web',
    });
    const st = await steps(s, owner, 'acme', 'web');
    const e = source.evidence;

    await refused(
      s.migrator.begin(st.edit, token, { ...e, ops: e.ops.slice(1) }),
      'invalid_evidence'
    );
    const stray = await Author.create(keyless(), owner, 'acme/stray');
    // A deletion carries no content, so only the closure check can refuse it.
    const strayOps = await stray.commit({ 'x.txt': null });
    const extra = stray.repo.log.ops().filter((o) => strayOps.includes(o.id));
    await refused(
      s.migrator.begin(st.edit, token, { ...e, ops: [...e.ops, ...extra] }),
      'invalid_evidence'
    );
    const [first, ...rest] = e.ops;
    const tampered = { ...first, sig: new Uint8Array(64) };
    await refused(
      s.migrator.begin(st.edit, token, { ...e, ops: [tampered, ...rest] }),
      'invalid_evidence'
    );
    await refused(
      s.migrator.begin(st.edit, token, {
        ...e,
        caps: [...e.caps, { ...e.caps[0], sig: new Uint8Array(64) }],
      }),
      'invalid_evidence'
    );
    // A chain re-signed by someone else has other ids, so it is not the
    // history the owner pinned.
    const resigned = e.heads.map((h) =>
      signHead(
        {
          repo: h.repo,
          view: h.view,
          version: h.version,
          previous: h.previous,
          heads: h.heads,
        },
        delegate
      )
    );
    await refused(
      s.migrator.begin(st.edit, token, { ...e, heads: resigned }),
      'invalid_evidence'
    );

    // A consent whose revisions differ from what the evidence rebuilds.
    const wrong = signConsent(owner, {
      service: s.authority.did,
      tenant: 'acme',
      repo: 'web',
      source: { server: server.url, repo: 'acme/web' },
      views: source.pinned().map((v) => ({
        ...v,
        revisions: v.revisions.map((r, i) => (i === 1 ? '0'.repeat(64) : r)),
      })),
    });
    await refused(s.migrator.begin(st.edit, wrong, e), 'mismatch');
    expect(await s.migrator.status('acme', 'web')).toBeNull();
  });

  test('a file must hash to the content the owner signed, at a path that holds it', async () => {
    const { owner, server, s } = await world();
    const source = await readSource(server, owner, 'acme/web');
    const token = source.consent(owner, {
      service: s.authority.did,
      tenant: 'acme',
      repo: 'web',
    });
    const st = await steps(s, owner, 'acme', 'web');
    await s.migrator.begin(st.edit, token, source.evidence);
    const [file] = await s.migrator.missing(st.edit);
    await refused(
      s.migrator.put(st.edit, {
        ...file,
        bytes: bytes('not the signed content'),
      }),
      'content_mismatch'
    );
    const right = await source.plaintext(owner, file);
    await refused(
      s.migrator.put(st.edit, {
        ...file,
        path: 'elsewhere.txt',
        bytes: right,
      }),
      'not_in_evidence'
    );
    expect(await s.migrator.put(st.edit, { ...file, bytes: right })).toBe(
      'stored'
    );
    expect(await s.migrator.put(st.edit, { ...file, bytes: right })).toBe(
      'present'
    );

    await refused(s.migrator.verify(st.read), 'incomplete');
    await refused(
      s.migrator.cutover(st.integrate, await source.latest()),
      'wrong_state'
    );
    await refused(s.migrator.export(st.read), 'wrong_state');
  });

  test('stored evidence that was changed after begin fails verification', async () => {
    const { owner, server, s } = await world();
    const source = await readSource(server, owner, 'acme/web');
    const token = source.consent(owner, {
      service: s.authority.did,
      tenant: 'acme',
      repo: 'web',
    });
    const st = await steps(s, owner, 'acme', 'web');
    await s.migrator.begin(st.edit, token, source.evidence);
    await transfer(source, owner, s.migrator, st.edit, token);
    const opKey = (await s.backend.list('migrate/acme/')).find((k) =>
      k.includes('/evidence/op/')
    );
    await s.backend.delete(opKey!);
    const fresh = await s.reopen();
    const again = await steps(fresh, owner, 'acme', 'web');
    await refused(fresh.migrator.verify(again.read), 'invalid_evidence');
  });
});

describe('old clients, a moving source and restarts', () => {
  test('a source that moves after the consent blocks cutover until the owner migrates again', async () => {
    const { owner, server, web, s } = await world();
    const api = await Author.create(server, owner, 'acme/api');
    await api.publish({ 'index.ts': 'export {}' });
    const source = await readSource(server, owner, 'acme/web');
    const token = source.consent(owner, {
      service: s.authority.did,
      tenant: 'acme',
      repo: 'web',
    });
    const st = await steps(s, owner, 'acme', 'web');
    await s.migrator.begin(st.edit, token, source.evidence);
    await transfer(source, owner, s.migrator, st.edit, token);
    await s.migrator.verify(st.read);

    // The shipped client keeps publishing to the keyless source mid-migration.
    await web.publish({ 'src/late.rs': 'fn late() {}' });
    await refused(
      s.migrator.cutover(st.integrate, await source.latest()),
      'source_moved'
    );

    // Old clients still clone and read both repositories from the keyless server.
    const oldClient = new Client(server.url, owner, server.fetch);
    const { repo } = await oldClient.clone('acme/web', new MemoryBackend());
    expect(repo.log.materialize('main', owner).has('src/late.rs')).toBe(true);
    const { repo: apiRepo } = await oldClient.clone(
      'acme/api',
      new MemoryBackend()
    );
    expect(apiRepo.headRecords.history('main')).toHaveLength(2);

    // A new consent pins the newer history; only the new file is sent.
    const newer = await readSource(server, owner, 'acme/web');
    const token2 = newer.consent(owner, {
      service: s.authority.did,
      tenant: 'acme',
      repo: 'web',
    });
    const progress = await s.migrator.begin(st.edit, token2, newer.evidence);
    expect(progress.missing).toBe(1);
    expect(await transfer(newer, owner, s.migrator, st.edit, token2)).toEqual({
      stored: 1,
      present: 0,
      remaining: 0,
    });
    await s.migrator.verify(st.read);
    const cut = await s.migrator.cutover(st.integrate, await newer.latest());
    expect(cut.views.find((v) => v.view === 'main')?.head.version).toBe(5);
    expect(await s.migrator.read(st.read, 'main', 'src/late.rs')).toEqual(
      bytes('fn late() {}')
    );
  });

  test('an interrupted import and an interrupted cutover resume after a restart', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const { FileBackend } = await import('@thaddeus.run/persist');
      const { owner, server } = await world();
      const s = await service({ backend: new FileBackend(dir) });
      await tenant(s, 'acme', [{ who: owner, repos: ['web'] }]);
      const source = await readSource(server, owner, 'acme/web');
      const token = source.consent(owner, {
        service: s.authority.did,
        tenant: 'acme',
        repo: 'web',
      });
      const st = await steps(s, owner, 'acme', 'web');
      const total = (await s.migrator.begin(st.edit, token, source.evidence))
        .files;
      expect(
        await transfer(source, owner, s.migrator, st.edit, token, { limit: 2 })
      ).toEqual({
        stored: 2,
        present: 0,
        remaining: total - 2,
      });

      // A new process: begin again with the same consent resumes, and only
      // the files that never arrived are sent.
      const after = await s.reopen();
      const st2 = await steps(after, owner, 'acme', 'web');
      expect(
        (await after.migrator.begin(st2.edit, token, source.evidence)).missing
      ).toBe(total - 2);
      expect((await after.migrator.status('acme', 'web'))?.seq).toBe(0);
      expect(
        await transfer(source, owner, after.migrator, st2.edit, token)
      ).toEqual({
        stored: total - 2,
        present: 0,
        remaining: 0,
      });
      await after.migrator.verify(st2.read);

      // Cutover stopped after two versions of main.
      const main = source.views.find((v) => v.view === 'main')!;
      for (const version of main.history.slice(0, 2)) {
        await after.authority.advance(st2.integrate, {
          view: 'main',
          expectedVersion: version.version === 0 ? null : version.version - 1,
          revision: version.revision,
          changedPaths: version.entries.map((e) => e.path),
        });
      }
      const third = await after.reopen();
      const st3 = await steps(third, owner, 'acme', 'web');
      const cut = await third.migrator.cutover(
        st3.integrate,
        await source.latest()
      );
      expect(cut.views.find((v) => v.view === 'main')?.head.version).toBe(4);
      // Running it again after it finished changes nothing.
      const again = await third.migrator.cutover(st3.integrate, []);
      expect(again.views.map((v) => v.head.id)).toEqual(
        cut.views.map((v) => v.head.id)
      );
    } finally {
      cleanup();
    }
  });
});

describe('rollback', () => {
  test('before cutover the trusted copy is withdrawn and the source is untouched', async () => {
    const { owner, server, s } = await world();
    const source = await readSource(server, owner, 'acme/web');
    const token = source.consent(owner, {
      service: s.authority.did,
      tenant: 'acme',
      repo: 'web',
    });
    const st = await steps(s, owner, 'acme', 'web');
    await s.migrator.begin(st.edit, token, source.evidence);
    await transfer(source, owner, s.migrator, st.edit, token);
    expect((await s.backend.list('trusted/acme/')).length).toBeGreaterThan(0);
    expect((await s.migrator.rollback(st.integrate)).state).toBe('rolled_back');
    expect(await s.backend.list('trusted/acme/')).toEqual([]);
    // The evidence and the record of what happened stay.
    expect((await s.backend.list('migrate/acme/')).length).toBeGreaterThan(0);
    await refused(s.migrator.tree(st.read, 'main'), 'wrong_state');
    const again = await readSource(server, owner, 'acme/web');
    expect(await checkout(again, owner, 'main')).toEqual(
      await checkout(source, owner, 'main')
    );
  });

  test('after cutover it is allowed until trusted history goes further', async () => {
    const { owner, server, web, s } = await world();
    const source = await readSource(server, owner, 'acme/web');
    const { st } = await migrate(s, source, owner, {
      tenant: 'acme',
      repo: 'web',
    });
    await s.migrator.rollback(st.integrate);
    expect((await s.migrator.status('acme', 'web'))?.state).toBe('rolled_back');

    // Migrating again later continues the same service history.
    await web.publish({ 'src/next.rs': 'fn next() {}' });
    const newer = await readSource(server, owner, 'acme/web');
    const { cut, st: st2 } = await migrate(s, newer, owner, {
      tenant: 'acme',
      repo: 'web',
    });
    expect(cut.views.find((v) => v.view === 'main')?.head.version).toBe(5);

    // Once the trusted copy has history of its own, rollback would lose it.
    await s.authority.advance(st2.integrate, {
      view: 'main',
      expectedVersion: 5,
      revision: 'f'.repeat(64),
      changedPaths: ['src/next.rs'],
    });
    await refused(s.migrator.rollback(st2.integrate), 'diverged');
  });
});

describe('independent repositories', () => {
  test('two owners, two tenants and one repository name migrate without touching each other', async () => {
    const { owner, server, s } = await world();
    const other = Identity.create();
    const lib = await Author.create(server, other, 'beta/web');
    await lib.publish({ 'lib.rs': 'pub fn beta() {}' });
    await tenant(s, 'beta', [{ who: other, repos: ['web'] }]);

    const a = await readSource(server, owner, 'acme/web');
    const b = await readSource(server, other, 'beta/web');
    const ta = a.consent(owner, {
      service: s.authority.did,
      tenant: 'acme',
      repo: 'web',
    });
    const tb = b.consent(other, {
      service: s.authority.did,
      tenant: 'beta',
      repo: 'web',
    });
    const sa = await steps(s, owner, 'acme', 'web');
    const sb = await steps(s, other, 'beta', 'web');
    await refused(s.migrator.begin(sb.edit, ta, a.evidence), 'wrong_target');
    await refused(
      s.migrator.begin(sb.edit, tb, a.evidence),
      'invalid_evidence'
    );

    // Interleaved steps.
    await s.migrator.begin(sa.edit, ta, a.evidence);
    await s.migrator.begin(sb.edit, tb, b.evidence);
    await transfer(b, other, s.migrator, sb.edit, tb);
    await transfer(a, owner, s.migrator, sa.edit, ta, { limit: 1 });
    await s.migrator.verify(sb.read);
    await refused(s.migrator.verify(sa.read), 'incomplete');
    await s.migrator.cutover(sb.integrate, await b.latest());
    await transfer(a, owner, s.migrator, sa.edit, ta);
    await s.migrator.verify(sa.read);
    await s.migrator.cutover(sa.integrate, await a.latest());

    expect((await s.migrator.tree(sb.read, 'main')).map((e) => e.path)).toEqual(
      ['lib.rs']
    );
    expect((await s.migrator.tree(sa.read, 'main')).map((e) => e.path)).toEqual(
      ['src/auth.rs', 'src/main.rs']
    );
    // Rolling one back leaves the other served.
    await s.migrator.rollback(sa.integrate);
    expect(text(await s.migrator.read(sb.read, 'main', 'lib.rs'))).toBe(
      'pub fn beta() {}'
    );
    // The rolled-back one is no longer served.
    await refused(s.migrator.tree(sa.read, 'main'), 'wrong_state');
  });
});

describe('format versions', () => {
  test('records from a newer format are refused rather than misread', async () => {
    const { owner, server, s } = await world();
    const source = await readSource(server, owner, 'acme/web');
    const token = source.consent(owner, {
      service: s.authority.did,
      tenant: 'acme',
      repo: 'web',
    });
    const st = await steps(s, owner, 'acme', 'web');
    await s.migrator.begin(st.edit, token, source.evidence);

    const stateKey = (await s.backend.list('migrate/acme/')).find((k) =>
      k.includes('/state/')
    )!;
    const state = await s.migrator.status('acme', 'web');
    await s.backend.put(stateKey, encodeRecord({ ...state, v: 2 }));
    await refused(s.migrator.status('acme', 'web'), 'unsupported_format');
    await s.backend.put(stateKey, encodeRecord(state));

    const formatKey = (await s.backend.list('trusted/acme/')).find((k) =>
      k.endsWith('/format')
    )!;
    await s.backend.put(
      formatKey,
      encodeRecord({ format: 'thaddeus.trusted-repo.v2' })
    );
    await s.migrator.rollback(st.integrate);
    const fresh = await readSource(server, owner, 'acme/web');
    const token2 = fresh.consent(owner, {
      service: s.authority.did,
      tenant: 'acme',
      repo: 'web',
    });
    await s.backend.put(
      formatKey,
      encodeRecord({ format: 'thaddeus.trusted-repo.v2' })
    );
    await refused(
      s.migrator.begin(st.edit, token2, fresh.evidence),
      'unsupported_format'
    );

    await refused(
      () =>
        verifyArchive(
          JSON.stringify({ format: 'thaddeus.migration-archive.v2' })
        ),
      'unsupported_format'
    );
  });

  test('a migrator built over the same backend reads what an earlier one wrote', async () => {
    const { owner, server, s } = await world();
    const source = await readSource(server, owner, 'acme/web');
    await migrate(s, source, owner, { tenant: 'acme', repo: 'web' });
    const second = new Migrator({
      authority: s.authority,
      custody: s.custody,
      backend: s.backend,
      now: s.clock.now,
    });
    const st = await steps(s, owner, 'acme', 'web');
    expect((await second.tree(st.read, 'main')).length).toBe(2);
    expect(verifyArchive(await second.export(st.read)).report.files).toBe(
      source.files().length
    );
  });
});
