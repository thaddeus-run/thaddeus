import { signDelegation } from '@thaddeus.run/agent';
import { Client, reachablePids, reshareObjects } from '@thaddeus.run/client';
import { type Identity, ready } from '@thaddeus.run/identity';
import type { Op } from '@thaddeus.run/log';
import { FileBackend } from '@thaddeus.run/persist';
import { allowAll, Platform, type Repo } from '@thaddeus.run/platform';
import { createServer, signRequest } from '@thaddeus.run/server';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  cachedBuild,
  fixtureDir,
  linkCopy,
  WORK_ROOT,
} from '../fixtures/cache';
import { authorsOf } from '../fixtures/materialize';
import { type FixturePlan, manifestHash } from '../fixtures/plan';

// Seeding, untimed: writes a fixture's repository into a server data root
// through the server's own HTTP handler, run in-process, so `thaddeus serve`
// later starts on exactly what a server that received these pushes would
// hold. The CLI cannot do this itself: it has one signing identity, stamps
// ops with the wall clock and cannot replay a plan.

const REPO = 'bench';

// The largest value the server accepts for each quota. The seeding server
// takes a whole history in one go; `thaddeus serve` later runs with its
// defaults (or the flags a case raises).
const UNLIMITED = Math.floor(Number.MAX_SAFE_INTEGER / 4);
const UNLIMITED_QUOTAS = {
  maxRepositories: UNLIMITED,
  maxObjects: UNLIMITED,
  maxObjectBytes: UNLIMITED,
  repositoryCreationLimit: UNLIMITED,
  objectCreationLimit: UNLIMITED,
  creationWindowMs: UNLIMITED,
};

// The seeding server's clock, fixed at the fixture epoch. Quota accounting
// persists its creation windows in the data root, anchored at the first
// creation. With a wall clock, a fresh seed would leave the owner's hourly
// object-creation window full, and a case run within the hour would be
// refused for a reason that has nothing to do with the case. Anchored at
// 2026-01-01, every window is long closed when serve starts, whatever the
// age of the cache.
const SEED_NOW = '2026-01-01T00:00:00.000Z';

// Wraps the in-process server's handler so every signed request is re-signed
// at SEED_NOW by the identity it names. The client signs with the wall clock,
// which the server would reject as skewed against SEED_NOW.
function atSeedClock(
  handler: (req: Request) => Promise<Response>,
  identities: readonly Identity[]
): (req: Request) => Promise<Response> {
  const byDid = new Map(identities.map((id) => [id.did, id]));
  return async (req) => {
    const did = req.headers.get('x-thaddeus-did');
    const signer = did === null ? undefined : byDid.get(did);
    if (signer === undefined) return handler(req);
    const body = new Uint8Array(await req.arrayBuffer());
    const url = new URL(req.url);
    const signed = signRequest(
      req.method,
      `${url.pathname}${url.search}`,
      body,
      signer,
      SEED_NOW
    );
    const headers = new Headers(req.headers);
    headers.set('x-thaddeus-timestamp', signed.timestamp);
    headers.set('x-thaddeus-nonce', signed.nonce);
    headers.set('x-thaddeus-signature', signed.signature);
    return handler(
      new Request(req.url, {
        method: req.method,
        headers,
        ...(body.length > 0 && { body }),
      })
    );
  };
}

// A stand-in repository whose log holds only `ops`, for `Client.push`, which
// uploads everything reachable from the heads it is given. Pushing a slice of
// the history this way sends that slice's ops with their objects and caps,
// and nothing older. Only `log.ops` and `store` are read by the push.
function sliceOf(repo: Repo, ops: readonly Op[]): Repo {
  return { log: { ops: () => ops }, store: repo.store } as unknown as Repo;
}

// Seeds `root` (an empty or missing directory) with the plan's repository as
// a server data root:
//   1. the owner (author 0) creates `bench` and grants every other author a
//      delegation over all paths;
//   2. every member is given a capability for every object, which is what the
//      CLI leaves behind, since each push reshares to all members first;
//   3. the history is pushed in slices of one land interval (`landEvery` ops,
//      in (lamport, id) order, so each slice's parents are already there);
//   4. every fixture view other than main is registered as a branch at its
//      heads, and the owner lands main's heads into main.
// The server uses `allowAll`, because the fixture's main holds the conflicts
// the generator lands on purpose. The plan is replayed by `fixtureDir` and
// read from a hard-link copy, so the fixture cache is never written.
export async function seedServerRoot(
  plan: FixturePlan,
  root: string
): Promise<void> {
  await ready();
  const authors = authorsOf(plan);
  const [owner, ...others] = authors;
  // Under WORK_ROOT: a hard link cannot cross into another filesystem.
  await mkdir(WORK_ROOT, { recursive: true });
  const scratch = join(await mkdtemp(join(WORK_ROOT, 'seed-')), 'repo');
  await linkCopy(await fixtureDir(plan), scratch);
  const srv = createServer({
    backend: new FileBackend(root),
    policy: allowAll,
    maxRequestBodyBytes: 1 << 30,
    quotas: UNLIMITED_QUOTAS,
    now: () => SEED_NOW,
  });
  try {
    const repo = await new Platform().openDurable(
      REPO,
      new FileBackend(scratch)
    );
    const client = new Client(
      'http://seed',
      owner,
      atSeedClock(srv.fetch.bind(srv), authors)
    );
    await client.createRepo(REPO);
    for (const author of others) {
      await client.grant(
        REPO,
        signDelegation(
          { agent: author.did, paths: ['**'], maxChanges: 1e9, maxSpend: 1e9 },
          owner
        )
      );
    }
    await reshareObjects(
      repo,
      reachablePids(repo, repo.heads()),
      others.map((author) => author.toPublic()),
      owner
    );

    const ops = [...repo.log.ops()].sort((x, y) =>
      x.lamport !== y.lamport ? x.lamport - y.lamport : x.id < y.id ? -1 : 1
    );
    const step = plan.spec.landEvery;
    for (let at = 0; at < ops.length; at += step) {
      const slice = ops.slice(at, at + step);
      const pushed = await client.push(
        REPO,
        sliceOf(repo, slice),
        slice.map((op) => op.id)
      );
      if (pushed.rejected.length > 0) {
        const first = pushed.rejected[0];
        throw new Error(
          `seeding push rejected ${pushed.rejected.length} item(s), first ${first.kind} ${first.id}: ${first.reason}`
        );
      }
    }

    for (const view of repo.branches()) {
      if (view === 'main') continue;
      await client.createView(REPO, repo, view, repo.heads(view));
    }
    const landed = await client.land(REPO, repo, repo.heads('main'));
    if (!landed.landed) {
      throw new Error(
        `seeding land of main failed: ${landed.reason ?? 'refused'}`
      );
    }
  } finally {
    await srv.close();
    await rm(dirname(scratch), { recursive: true, force: true });
  }
}

// The cached server data root of `plan`: `bench/.cache/<hash>-server/`,
// built by `seedServerRoot` with the same temporary directory, `.complete`
// marker and publish rule as the fixture cache.
export function seededRoot(
  plan: FixturePlan,
  opts: { cacheRoot?: string } = {}
): Promise<string> {
  const hash = manifestHash(plan);
  return cachedBuild(
    `${hash}-server`,
    hash,
    (tmp) => seedServerRoot(plan, tmp),
    opts
  );
}
