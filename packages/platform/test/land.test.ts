import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { ReputationLog, signContribution } from '@thaddeus.run/reputation';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Platform, type Repo } from '../src/platform';
import { allowAll, requireReputationTier } from '../src/policy';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// Open a NAMED workspace over the repo, stage one write, and commit it onto a
// landable private view. Returns the view name to pass to land({ from }).
async function branch(
  repo: Repo,
  name: string,
  path: string,
  body: string,
  author: Identity
): Promise<string> {
  const ws = Workspace.open(repo.log, repo.store, {
    source: 'main',
    reader: author,
    name,
  });
  ws.write(path, enc(body));
  await ws.commit(author);
  return name;
}

describe('Repo.land — landing as policy', () => {
  test('a clean land re-points main and materializes the edit', async () => {
    const repo = new Platform().createRepo('acme/web');
    const dev = Identity.create();
    await branch(repo, 'feat/login', 'src/login.rs', 'fn login() {}', dev);

    const result = await repo.land({ from: 'feat/login', author: dev });
    expect(result.landed).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(repo.heads('main')).toEqual(result.heads);
    expect(repo.log.materialize('main').has('src/login.rs')).toBe(true);
  });

  test('blockOnConflict (default): the second same-path land is rejected, main untouched', async () => {
    const repo = new Platform().createRepo('acme/api');
    const alice = Identity.create();
    const bob = Identity.create();
    await branch(repo, 'alice/rate', 'src/rate.rs', 'fn rate() { 100 }', alice);
    await branch(repo, 'bob/rate', 'src/rate.rs', 'fn rate() { 200 }', bob);

    const first = await repo.land({ from: 'alice/rate', author: alice });
    expect(first.landed).toBe(true);
    const mainAfterFirst = repo.heads('main');

    const second = await repo.land({ from: 'bob/rate', author: bob });
    expect(second.landed).toBe(false);
    expect(second.reason).toContain('src/rate.rs');
    // Fail-closed: main's heads are exactly what they were before the reject.
    expect(repo.heads('main')).toEqual(mainAfterFirst);
    expect(dec((await readMain(repo, 'src/rate.rs', alice))!)).toBe(
      'fn rate() { 100 }'
    );
  });

  test('allowAll lands the conflicting second; conflicts() surfaces the LWW collision', async () => {
    const repo = new Platform().createRepo('acme/api2');
    const alice = Identity.create();
    const bob = Identity.create();
    await branch(repo, 'alice/rate', 'src/rate.rs', 'fn rate() { 100 }', alice);
    await branch(repo, 'bob/rate', 'src/rate.rs', 'fn rate() { 200 }', bob);

    await repo.land({ from: 'alice/rate', author: alice });
    const second = await repo.land({
      from: 'bob/rate',
      author: bob,
      policy: allowAll,
    });
    expect(second.landed).toBe(true);
    const collisions = repo.conflicts('main');
    expect(collisions.map((c) => c.path)).toContain('src/rate.rs');
  });

  test('incomingOps = from-closure minus into-closure; landed op is mirror-servable', async () => {
    const repo = new Platform().createRepo('acme/web2');
    const dev = Identity.create();
    const ws = Workspace.open(repo.log, repo.store, {
      source: 'main',
      reader: dev,
      name: 'feat/x',
    });
    ws.write('src/x.rs', enc('fn x() {}'));
    const [op] = await ws.commit(dev);

    // Capture the proposal via a custom policy, then allow.
    let seen = 0;
    const result = await repo.land({
      from: 'feat/x',
      author: dev,
      policy: (p) => {
        seen = p.incomingOps.length;
        expect(p.incomingOps[0]?.id).toBe(op?.id);
        return { allow: true };
      },
    });
    expect(seen).toBe(1); // exactly the one new op
    expect(result.landed).toBe(true);

    // Mirror property: the landed op is ciphertext a public mirror can serve.
    expect(op?.payload).not.toBeNull();
    if (op?.payload != null) {
      expect(repo.store.verify(op.payload.id)).toBe(true);
    }
    if (op != null) {
      expect(repo.log.publicView(op.id).kind).toBe('open');
    }
  });

  test('an unknown/empty from view lands nothing and reports it (no false success)', async () => {
    const repo = new Platform().createRepo('acme/typo');
    const dev = Identity.create();
    const before = repo.heads('main');

    const result = await repo.land({
      from: 'feat/does-not-exist',
      author: dev,
    });

    expect(result.landed).toBe(false);
    expect(result.reason).toContain('feat/does-not-exist');
    expect(repo.heads('main')).toEqual(before); // main untouched
  });
});

describe('Repo.land — reputation-tier gate (Pillar 10)', () => {
  test('a high-reputation author lands; a low-reputation author is gated, main untouched', async () => {
    const repo = new Platform().createRepo('acme/svc');
    const reps = new ReputationLog();
    const host = Identity.create();
    const senior = Identity.create();
    const junior = Identity.create();
    for (let i = 0; i < 3; i++) {
      reps.append(
        signContribution(
          {
            repo: 'acme/svc',
            ref: `m-${i}`,
            kind: 'merge',
            at: '2026-07-01T00:00:00Z',
          },
          senior,
          host
        )
      );
    }
    const gate = requireReputationTier(reps, 3);

    await branch(repo, 'senior/feat', 'src/a.rs', 'fn a() {}', senior);
    const ok = await repo.land({
      from: 'senior/feat',
      author: senior,
      policy: gate,
    });
    expect(ok.landed).toBe(true);
    expect(repo.heads('main')).toEqual(ok.heads);

    const mainBefore = repo.heads('main');
    await branch(repo, 'junior/feat', 'src/b.rs', 'fn b() {}', junior);
    const blocked = await repo.land({
      from: 'junior/feat',
      author: junior,
      policy: gate,
    });
    expect(blocked.landed).toBe(false);
    expect(blocked.reason).toContain('tier');
    expect(repo.heads('main')).toEqual(mainBefore);
  });
});

// Read a path from main as `who`, returning null on absent/undecryptable.
async function readMain(
  repo: Repo,
  path: string,
  who: Identity
): Promise<Uint8Array | null> {
  const entry = repo.log.materialize('main', who).get(path);
  if (entry === undefined || entry.ref === null) {
    return null;
  }
  return repo.store.get(entry.ref, who);
}
