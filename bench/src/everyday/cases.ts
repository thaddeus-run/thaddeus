import { ready } from '@thaddeus.run/identity';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { BenchCase, CaseContext } from '../case';
import { writeChangeSet } from '../e2e/cases';
import { cliCommand, timeCli, writeCliHome } from '../e2e/home';
import { linkCopy } from '../fixtures/cache';
import { gitFixture, timeGit } from './git';
import { applyEdit, editPaths } from './tree';
import { thadWorkingCopy } from './workcopy';

// The everyday suite: the commands a developer or an agent runs all day,
// timed against git on the same files. These cases need no server. Each
// working copy holds the fixture's main plus the same ten-file edit, so
// `status` and `diff` have changes to report, and `git` and `thaddeus` see
// the same bytes. The commands only read, so a case sets up once
// (`per-case`) and the warm-ups absorb first-run effects such as git
// refreshing its index.

const FIXTURES = ['tiny', 'small', 'medium', 'stress'] as const;

// How many agents share the host in the agent cases, each in its own working
// copy.
const AGENTS = 8;

// The working copies of one case, and the identity home the commands run as.
interface CopyState {
  dirs: string[];
  home: string;
}

// One sample of an agent case: AGENTS copies of the command at once, one
// per working copy, timed until the last one exits. That is how long an
// agent on a shared host waits when the others are busy too. It waits for
// every command to finish even when one fails, and then rethrows the first
// failure, so no child is still running when the sample ends.
export async function together(
  dirs: readonly string[],
  one: (dir: string) => Promise<number>
): Promise<void> {
  const settled = await Promise.allSettled(dirs.map(one));
  for (const result of settled) {
    if (result.status === 'rejected') throw result.reason;
  }
}

// Builds `copies` working copies named `wc-0`, `wc-1`, ... under the case's
// work directory, one at a time so a large fixture does not hold several
// builds in memory at once, and applies the edit to each. `build` makes one.
async function buildCopies(
  ctx: CaseContext,
  copies: number,
  build: (dir: string) => Promise<void>
): Promise<string[]> {
  const paths = editPaths(ctx.plan);
  const dirs: string[] = [];
  for (let i = 0; i < copies; i++) {
    const dir = join(ctx.workDir, `wc-${i}`);
    await build(dir);
    applyEdit(dir, paths);
    dirs.push(dir);
  }
  return dirs;
}

// The command a case times, run in one working copy.
type Command = (state: CopyState, dir: string) => Promise<number>;

// The skeleton of one everyday case on all fixtures, on their serial
// variants (the git side replays a serial plan, and the working copy is
// built from the same one). `copies` is 1 for a developer case and AGENTS for
// an agent case, where one sample runs `command` in every copy at once.
function everydayCase(c: {
  id: string;
  needs: 'fixture' | 'git';
  minRepeats?: number;
  copies: number;
  note: string;
  setup: (ctx: CaseContext, copies: number) => Promise<CopyState>;
  command: Command;
}): BenchCase<CopyState> {
  return {
    id: c.id,
    version: 1,
    suite: 'everyday',
    fixtures: FIXTURES,
    variant: 'serial',
    isolation: 'per-case',
    needs: [c.needs],
    ...(c.minRepeats !== undefined && { minRepeats: c.minRepeats }),
    note: c.note,
    setup: (ctx) => c.setup(ctx, c.copies),
    run: (s) =>
      together(s.dirs, (dir) => c.command(s, dir)).then(() => undefined),
  };
}

// Setup of a thaddeus case: working copies built from the fixture cache
// without a server, and the owner's identity home (author 0's, whose store
// the copies hold).
async function thadSetup(ctx: CaseContext, copies: number): Promise<CopyState> {
  await ready();
  const home = join(ctx.workDir, 'owner');
  writeCliHome(home, ctx.plan.authorSeeds[0]);
  const dirs = await buildCopies(ctx, copies, (dir) =>
    thadWorkingCopy(ctx.plan, dir)
  );
  return { dirs, home };
}

// Setup of a git case: `git clone` of the plan's bare repository, the same
// way a developer or an agent gets a working copy.
async function gitSetup(ctx: CaseContext, copies: number): Promise<CopyState> {
  const home = join(ctx.workDir, 'git-home');
  mkdirSync(home, { recursive: true });
  const bare = await gitFixture(ctx.plan);
  const dirs = await buildCopies(ctx, copies, async (dir) => {
    await timeGit(['clone', '-q', bare, dir], { home, cwd: ctx.workDir });
  });
  return { dirs, home };
}

const thaddeus =
  (args: string[]): Command =>
  (s, dir) =>
    timeCli(cliCommand(), args, { home: s.home, cwd: dir });

const git =
  (args: string[]): Command =>
  (s, dir) =>
    timeGit(args, { home: s.home, cwd: dir });

// Every git case takes at least this many timed samples. A git command takes
// a few milliseconds, and the median of the run's usual 3 samples moves by
// tens of percent between runs. The gate holds only the thaddeus p50 to a
// ceiling, but `bench budget` and the gate output report the multiple of git,
// and 25 samples steady that denominator. At milliseconds per sample, they
// cost little.
const GIT_MIN_REPEATS = 25;

const AGENT_NOTE = '8 concurrent copies on one host; the sample is the slowest';

// One working-copy case: `thaddeus <command>` in a clone-shaped working copy
// with the ten-file edit.
function wcCase(command: 'status' | 'diff', agents: boolean) {
  return everydayCase({
    id: `wc.${command}${agents ? `.agents${AGENTS}` : ''}`,
    needs: 'fixture',
    copies: agents ? AGENTS : 1,
    note: agents
      ? `thaddeus ${command} in each of ${AGENTS} working copies with a ten-file edit; ${AGENT_NOTE}`
      : `thaddeus ${command} in a working copy with a ten-file edit, a fresh process per run`,
    setup: thadSetup,
    command: thaddeus([command]),
  });
}

// One git case: `git <command>` in a clone of the plan's bare repository with
// the same ten-file edit.
function gitCase(command: 'status' | 'diff', agents: boolean) {
  return everydayCase({
    id: `git.${command}${agents ? `.agents${AGENTS}` : ''}`,
    needs: 'git',
    minRepeats: GIT_MIN_REPEATS,
    copies: agents ? AGENTS : 1,
    note: agents
      ? `git ${command} in each of ${AGENTS} clones with a ten-file edit; ${AGENT_NOTE}`
      : `git ${command} in a clone with a ten-file edit, a fresh process per run`,
    setup: gitSetup,
    command: git([command]),
  });
}

// What a git baseline of a server command holds: the git home, the hard-link
// copy of the cached bare repository that plays the server, and the case's
// work directory.
interface RemoteState {
  home: string;
  remote: string;
  workDir: string;
}

// Hard-link copies the cached bare repository to `<workDir>/remote.git`, the
// repository a sample pushes to and pulls from. That is safe for the same
// reason it is for FileBackend: git writes new objects as new files and moves
// refs into place by rename, so nothing reaches the cache.
async function gitRemote(ctx: CaseContext): Promise<RemoteState> {
  const home = join(ctx.workDir, 'git-home');
  mkdirSync(home, { recursive: true });
  const remote = join(ctx.workDir, 'remote.git');
  await linkCopy(await gitFixture(ctx.plan), remote);
  return { home, remote, workDir: ctx.workDir };
}

// Clones the remote into `<workDir>/<name>` (setup, not timed) and returns
// the path.
async function cloneRemote(s: RemoteState, name: string): Promise<string> {
  const dir = join(s.workDir, name);
  await timeGit(['clone', '-q', s.remote, dir], {
    home: s.home,
    cwd: s.workDir,
  });
  return dir;
}

// The skeleton of one git baseline of a server command. Each sample is a
// fresh process on a fresh copy of the remote (`per-sample`), because the
// timed command changes the remote or the clone. Git's transport here is the
// local one, so these cases carry no loopback HTTP, which the thaddeus side
// pays; the note says so.
function gitServerCase<S extends RemoteState>(c: {
  id: string;
  cold?: boolean;
  note: string;
  setup: (s: RemoteState) => Promise<S>;
  run: (s: S) => Promise<void>;
}): BenchCase<S> {
  return {
    id: c.id,
    version: 1,
    suite: 'everyday',
    fixtures: FIXTURES,
    variant: 'serial',
    isolation: 'per-sample',
    needs: ['git'],
    minRepeats: GIT_MIN_REPEATS,
    ...(c.cold === true && { cold: true }),
    note: c.note,
    setup: async (ctx) => c.setup(await gitRemote(ctx)),
    run: (s) => c.run(s),
  };
}

interface CloneState extends RemoteState {
  clone: string;
}

// Commit: clone, switch to a new branch and write the 10-file change set that
// `e2e.push.10` pushes. The timed commands are `git add -A`, `git commit` and
// `git push` of the branch to the remote; thaddeus has no local-only commit,
// so its push stands against all three, and the sample is their sum.
const gitCommit: BenchCase<CloneState> = gitServerCase({
  id: 'git.commit',
  note: "git add -A, git commit and git push of a 10-file change set, summed; git's transport is local (a path to a hard-link copy of the bare repository), not loopback HTTP; git applies its own fsync settings, so the pair is not durability-matched",
  setup: async (s) => {
    const clone = await cloneRemote(s, 'clone');
    const at = { home: s.home, cwd: clone };
    await timeGit(['switch', '-q', '-c', 'bench-push'], at);
    writeChangeSet(clone, 10);
    return { ...s, clone };
  },
  run: async (s) => {
    const at = { home: s.home, cwd: s.clone };
    await timeGit(['add', '-A'], at);
    await timeGit(['commit', '-q', '-m', 'bench'], at);
    await timeGit(['push', '-q', 'origin', 'bench-push'], at);
  },
});

// Checkout: clone and create a branch; the timed command opens it in a new
// directory with `git worktree add`, which is what `thaddeus workspace` does.
const gitWorktree: BenchCase<CloneState> = gitServerCase({
  id: 'git.worktree',
  note: 'git worktree add of a branch into a new directory; warm, because setup read everything it needs',
  setup: async (s) => {
    const clone = await cloneRemote(s, 'clone');
    await timeGit(['branch', 'bench-ws'], { home: s.home, cwd: clone });
    return { ...s, clone };
  },
  run: async (s) => {
    await timeGit(
      ['worktree', 'add', '-q', join(s.workDir, 'ws'), 'bench-ws'],
      {
        home: s.home,
        cwd: s.clone,
      }
    );
  },
});

interface ReaderState extends RemoteState {
  reader: string;
}

// Pull: an owner clone and a reader clone, then the owner commits the same
// 10-file change set to main and pushes it. The timed command is the reader's
// fast-forward `git pull`.
const gitPull: BenchCase<ReaderState> = gitServerCase({
  id: 'git.pull',
  note: "git pull --ff-only of a 10-file commit in a second clone; git's transport is local (a path to a hard-link copy of the bare repository), not loopback HTTP",
  setup: async (s) => {
    const owner = await cloneRemote(s, 'owner-clone');
    const reader = await cloneRemote(s, 'reader-clone');
    const at = { home: s.home, cwd: owner };
    writeChangeSet(owner, 10);
    await timeGit(['add', '-A'], at);
    await timeGit(['commit', '-q', '-m', 'bench'], at);
    await timeGit(['push', '-q', 'origin', 'main'], at);
    return { ...s, reader };
  },
  run: async (s) => {
    await timeGit(['pull', '-q', '--ff-only'], {
      home: s.home,
      cwd: s.reader,
    });
  },
});

// CI checkout: a depth-1 clone, which is what `actions/checkout` does by
// default, over a file:// URL (a plain path would ignore the depth). Cold like
// `e2e.checkout.cold`: in the dropped mode the page cache is dropped before
// setup, and setup's hard-link copy re-warms only directory entries and
// inodes, not file contents.
const gitClone: BenchCase<RemoteState> = gitServerCase({
  id: 'git.clone',
  cold: true,
  note: "git clone --depth 1 of a file:// URL into an empty directory, in a fresh home; cold like e2e.checkout.cold: in the dropped mode, setup's hard-link copy (cp -al) re-warms directory entries and inodes but not file contents. git's transport is local, not loopback HTTP",
  setup: (s) => Promise.resolve(s),
  run: async (s) => {
    await timeGit(
      [
        'clone',
        '-q',
        '--depth',
        '1',
        `file://${s.remote}`,
        join(s.workDir, 'checkout'),
      ],
      { home: s.home, cwd: s.workDir }
    );
  },
});

// The everyday suite's registry, imported by the runner in the parent and in
// each case child.
const everydayCases: readonly BenchCase[] = [
  wcCase('status', false),
  wcCase('diff', false),
  wcCase('status', true),
  wcCase('diff', true),
  gitCase('status', false),
  gitCase('diff', false),
  gitCase('status', true),
  gitCase('diff', true),
  gitCommit,
  gitWorktree,
  gitPull,
  gitClone,
];

export default everydayCases;
