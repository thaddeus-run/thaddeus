import { blake3 } from '@noble/hashes/blake3';
import { Identity, ready } from '@thaddeus.run/identity';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BenchCase, CaseContext } from '../case';
import { COMPLETE, linkCopy } from '../fixtures/cache';
import { resolveFixture, FIXTURES as SPECS } from '../fixtures/spec';
import { cliCommand, timeCli, writeCliHome } from './home';
import { seededRoot } from './seed';
import { type RunningServe, startServe } from './serve';

// The end-to-end suite: the real `thaddeus` CLI against a real `thaddeus
// serve` over loopback, client and server on one host. Every case starts its
// own server in setup on a hard-link copy of the seeded data root and stops
// it in teardown. Setup does everything the timed command needs (clones,
// branches, change sets), so `run` is exactly one CLI invocation, or for
// repos per minute a fixed-duration burst of them.

const FIXTURES = ['tiny', 'small', 'medium', 'stress'] as const;

const ONE_GIB = '1073741824';

// The shipped serve limits a fixture is too big for. Every push uploads the
// whole history reachable from the pushed heads, so on medium (about 100 MB)
// and stress a push is over the 16 MiB default request body. Stress also
// holds more than the default 100,000 objects per owner. Decided from the
// resolved spec's history length, not the name, because suite runs pass the
// serial names (`medium-serial`), which share their base's sizes.
function fixtureLimits(fixture: string, pushes: boolean): string[] {
  const { ops } = resolveFixture(fixture);
  const body =
    pushes && ops >= SPECS.medium.ops
      ? ['--max-request-body-bytes', ONE_GIB]
      : [];
  if (ops >= SPECS.stress.ops) return ['--max-objects', '10000000', ...body];
  return body;
}

// Repository-count limits raised for repos per minute only: the default
// allows 20 creations per owner per hour and 100 repositories per owner.
const CREATION_LIMITS = [
  '--repository-creation-limit',
  '1000000',
  '--max-repositories',
  '1000000',
];

// Size of each change-set file: about the fixture generator's mean write.
const CHANGE_FILE_BYTES = 4_096;

// The i-th file of a change set: `bench-change/<i>.ts`, a path no fixture
// writes, so a change set never collides with fixture data. The content is
// fixed per i, so every sample pushes the same bytes.
function writeChangeSet(dir: string, files: number): void {
  mkdirSync(join(dir, 'bench-change'), { recursive: true });
  for (let i = 0; i < files; i++) {
    const path = `bench-change/${i}.ts`;
    const head = `// ${path}\nexport const change${i} = ${i};\n`;
    const pad = CHANGE_FILE_BYTES - head.length - 3;
    writeFileSync(join(dir, path), `${head}//${'.'.repeat(pad)}\n`);
  }
}

// A deterministic 32-byte identity seed for a bench-only identity (the
// second identity that pulls, the repos-per-minute clients). Distinct from
// every fixture author, whose seeds come from the fixture's PRNG.
function benchSeed(label: string): Uint8Array {
  return blake3(new TextEncoder().encode(`thaddeus-bench/e2e/${label}`));
}

// What every e2e case holds: the CLI command, the running server, the
// owner's identity home and the case's work directory.
interface E2eState {
  cli: string[];
  serve: RunningServe;
  ownerHome: string;
  workDir: string;
}

// Hard-link copies the cached seeded root into the work directory, starts
// `thaddeus serve` on it with `flags`, and writes the owner's (author 0's)
// identity home. The copy drops the cache's `.complete` marker, which is not
// server data. A server that writes into the copy never reaches the cache,
// because FileBackend replaces files by rename.
async function serveSeeded(
  ctx: CaseContext,
  flags: string[]
): Promise<E2eState> {
  await ready();
  const root = join(ctx.workDir, 'root');
  await linkCopy(await seededRoot(ctx.plan), root);
  rmSync(join(root, COMPLETE), { force: true });
  const cli = cliCommand();
  const serve = await startServe({ cli, root, flags });
  const ownerHome = join(ctx.workDir, 'owner');
  writeCliHome(ownerHome, ctx.plan.authorSeeds[0]);
  return { cli, serve, ownerHome, workDir: ctx.workDir };
}

// Runs a CLI command as the owner in `cwd`.
function asOwner(s: E2eState, args: string[], cwd = s.workDir) {
  return timeCli(s.cli, args, { home: s.ownerHome, cwd });
}

// Clones `bench` as the owner into `<workDir>/<name>` and returns the path.
async function ownerClone(s: E2eState, name: string): Promise<string> {
  const dir = join(s.workDir, name);
  await asOwner(s, ['clone', 'bench', dir, '--server', s.serve.url]);
  return dir;
}

// Opens a new branch as its own working copy: the owner creates `branch` at
// main's heads in the clone `from`, then `thaddeus workspace` opens it in a
// sibling directory, which is returned.
async function openBranch(
  s: E2eState,
  from: string,
  branch: string
): Promise<string> {
  const dir = join(s.workDir, branch);
  await asOwner(s, ['branch', branch], from);
  await asOwner(s, ['workspace', branch, dir], from);
  return dir;
}

const stopServe = (s: E2eState): Promise<void> => s.serve.stop();

// The skeleton of one e2e case on all fixtures, run on their serial
// variants (`<fixture>-serial`): the shipped server refuses every land into
// a main that holds a conflict, and the base plans land conflicts on
// purpose. `pushes` says whether the case uploads history, which decides the
// limits it raises.
function e2eCase<S extends E2eState>(
  c: Omit<BenchCase<S>, 'version' | 'suite' | 'fixtures' | 'serveFlags'> & {
    pushes: boolean;
    extraFlags?: string[];
  }
): BenchCase<S> {
  const { pushes, extraFlags = [], ...rest } = c;
  return {
    version: 1,
    suite: 'e2e',
    fixtures: FIXTURES,
    variant: 'serial',
    serveFlags: (fixture) => [...fixtureLimits(fixture, pushes), ...extraFlags],
    teardown: stopServe,
    ...rest,
  };
}

// Serves the seeded root with the flags `benchCase` records for this fixture.
function serveFor(
  benchCase: { serveFlags?(fixture: string): string[] },
  ctx: CaseContext
): Promise<E2eState> {
  return serveSeeded(ctx, benchCase.serveFlags?.(ctx.fixture) ?? []);
}

// Cold checkout: `thaddeus clone` of the seeded repository into an empty
// directory, in a fresh process per sample (and, in the dropped mode, after
// the page cache was dropped). The server opens a repository lazily on its
// first request, so the timed clone includes that open; setup does not warm
// it, because the page cache is dropped before setup. Setup's `cp -al` of
// the seeded root does run after the drop, so directory entries and inodes
// are warm again; file contents are not.
const checkoutCold: BenchCase<E2eState> = e2eCase({
  id: 'e2e.checkout.cold',
  isolation: 'per-sample',
  cold: true,
  pushes: false,
  note: "includes the server's cold open of the repository: serve opens it on the first request, which is the timed clone. In the dropped mode, setup's hard-link copy (cp -al) of the seeded root runs after the drop and re-warms its directory entries and inodes, but not file contents",
  setup: (ctx) => serveFor(checkoutCold, ctx),
  run: async (s) => {
    await ownerClone(s, 'checkout');
  },
});

interface PushState extends E2eState {
  branch: string;
}

// Push: the owner clones, opens a branch in its own working copy, writes a
// change set of `files` new files there, and the timed command is `thaddeus
// push --no-land` from that working copy (commit and upload, no land).
function pushCase(files: number): BenchCase<PushState> {
  const benchCase: BenchCase<PushState> = e2eCase({
    id: `e2e.push.${files}`,
    isolation: 'per-sample',
    writes: true,
    pushes: true,
    setup: async (ctx) => {
      const s = await serveFor(benchCase, ctx);
      const clone = await ownerClone(s, 'clone');
      const branch = await openBranch(s, clone, 'bench-push');
      writeChangeSet(branch, files);
      return { ...s, branch };
    },
    run: async (s) => {
      await asOwner(s, ['push', '--no-land'], s.branch);
    },
  });
  return benchCase;
}

// How many timed samples `e2e.pull` and `e2e.land` take, with no warm-up.
// Each sample's setup lands a push on the server, and every server land runs
// `conflicts()`, which is slow on today's op-log (THA-21); `e2e.land` then
// lands again in the timed command. Ten repeats plus two warm-ups do not fit
// `record`'s 600 s budget even on small, so the case would record a bare
// `exceeded`. Three samples give a median that fits, and the result records
// the capped counts.
const LAND_MAX_REPEATS = 3;

interface PullState extends E2eState {
  readerHome: string;
  readerClone: string;
}

// Pull with a second identity. The owner clones and runs `thaddeus grant
// <reader>`, which delegates write access and shares a key to every object,
// as a real owner invites a collaborator. The reader clones, then the owner
// pushes a 10-file change set to main. The timed command is the reader's
// `thaddeus pull` of that change. Capped at LAND_MAX_REPEATS samples and no
// warm-up, because each sample's setup lands on the server.
const pull: BenchCase<PullState> = e2eCase({
  id: 'e2e.pull',
  isolation: 'per-sample',
  pushes: true,
  maxRepeats: LAND_MAX_REPEATS,
  maxWarmup: 0,
  setup: async (ctx) => {
    const s = await serveFor(pull, ctx);
    const seed = benchSeed('reader');
    const readerHome = join(ctx.workDir, 'reader');
    writeCliHome(readerHome, seed);
    const clone = await ownerClone(s, 'clone');
    await asOwner(s, ['grant', Identity.fromSeed(seed).did], clone);
    const readerClone = join(ctx.workDir, 'reader-clone');
    await timeCli(
      s.cli,
      ['clone', 'bench', readerClone, '--server', s.serve.url],
      { home: readerHome, cwd: ctx.workDir }
    );
    writeChangeSet(clone, 10);
    await asOwner(s, ['push'], clone);
    return { ...s, readerHome, readerClone };
  },
  run: async (s) => {
    await timeCli(s.cli, ['pull'], { home: s.readerHome, cwd: s.readerClone });
  },
});

interface LandState extends E2eState {
  clone: string;
}

// Land: the owner opens branch `bench-land`, pushes a 10-file change set to
// it (uploaded and landed on the branch), and the timed command is
// `thaddeus land bench-land` from the main clone, landing it into main.
// Capped at LAND_MAX_REPEATS samples and no warm-up: setup lands the branch
// push and the timed command lands again, each running `conflicts()`.
const land: BenchCase<LandState> = e2eCase({
  id: 'e2e.land',
  isolation: 'per-sample',
  writes: true,
  pushes: true,
  maxRepeats: LAND_MAX_REPEATS,
  maxWarmup: 0,
  setup: async (ctx) => {
    const s = await serveFor(land, ctx);
    const clone = await ownerClone(s, 'clone');
    const branch = await openBranch(s, clone, 'bench-land');
    writeChangeSet(branch, 10);
    await asOwner(s, ['push'], branch);
    return { ...s, clone };
  },
  run: async (s) => {
    await asOwner(s, ['land', 'bench-land'], s.clone);
  },
});

// At most this many timed `create`s: the shipped limit is 20 creations per
// owner per hour, and the warm-ups create repositories too.
const CREATE_MAX_REPEATS = 15;

interface CreateState extends E2eState {
  created: number;
}

// Repository creation: `thaddeus create bench-new-<k>` by the owner, one
// after another against one server with the shipped limits.
const repoCreate: BenchCase<CreateState> = e2eCase({
  id: 'e2e.repo.create',
  isolation: 'per-case',
  writes: true,
  pushes: false,
  maxRepeats: CREATE_MAX_REPEATS,
  setup: async (ctx) => ({ ...(await serveFor(repoCreate, ctx)), created: 0 }),
  run: async (s) => {
    const name = `bench-new-${s.created++}`;
    await asOwner(s, ['create', name, '--server', s.serve.url]);
  },
});

// Concurrent CLI clients in repos per minute, each with its own identity.
const RPM_CLIENTS = 8;

// How long each repos-per-minute sample creates repositories when the run
// does not set `durationMs`.
const RPM_DEFAULT_DURATION_MS = 30_000;

// At most this many bursts. `bench run` cannot set `durationMs`, so its ten
// default repeats would be ten 30 s bursts, past the 120 s `run` budget.
// Three bursts (90 s) fit it with room for setup.
const RPM_MAX_REPEATS = 3;

interface RpmState extends E2eState {
  homes: string[];
  durationMs: number;
  /** Repositories created so far, for unique names across samples. */
  serial: number;
}

// Repositories per minute: RPM_CLIENTS concurrent clients, each a distinct
// identity, run `thaddeus create` back to back until the duration is up.
// A sample's time is the whole burst including the last command to finish,
// and it reports every repository created, so the runner's throughput is
// repositories per minute. It raises only the repository-count limits.
const reposPerMinute: BenchCase<RpmState> = e2eCase({
  id: 'e2e.repos-per-minute',
  isolation: 'per-case',
  writes: true,
  pushes: false,
  extraFlags: CREATION_LIMITS,
  // Each sample is a fixed-duration burst; warming up would only spend
  // budget (four 30 s bursts are the whole `bench run` budget).
  maxRepeats: RPM_MAX_REPEATS,
  maxWarmup: 0,
  setup: async (ctx) => {
    const s = await serveFor(reposPerMinute, ctx);
    const homes = Array.from({ length: RPM_CLIENTS }, (_, i) => {
      const home = join(ctx.workDir, `client-${i}`);
      writeCliHome(home, benchSeed(`client-${i}`));
      return home;
    });
    return {
      ...s,
      homes,
      durationMs: ctx.durationMs ?? RPM_DEFAULT_DURATION_MS,
      serial: 0,
    };
  },
  run: async (s) => {
    const deadline = performance.now() + s.durationMs;
    let created = 0;
    await Promise.all(
      s.homes.map(async (home, i) => {
        while (performance.now() < deadline) {
          const name = `rpm-${i}-${s.serial++}`;
          await timeCli(s.cli, ['create', name, '--server', s.serve.url], {
            home,
            cwd: s.workDir,
          });
          created += 1;
        }
      })
    );
    return { repos: created };
  },
});

// The e2e suite's registry, imported by the runner in the parent and in each
// case child.
const e2eCases: readonly BenchCase[] = [
  checkoutCold,
  pushCase(10),
  pushCase(100),
  pull,
  land,
  repoCreate,
  reposPerMinute,
];

export default e2eCases;
