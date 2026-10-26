import { ready } from '@thaddeus.run/identity';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { BenchCase, CaseContext } from '../case';
import { cliCommand, timeCli, writeCliHome } from '../e2e/home';
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
// agent on a shared host waits when the others are busy too.
async function together(
  dirs: readonly string[],
  one: (dir: string) => Promise<number>
): Promise<void> {
  await Promise.all(dirs.map(one));
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
    copies: agents ? AGENTS : 1,
    note: agents
      ? `git ${command} in each of ${AGENTS} clones with a ten-file edit; ${AGENT_NOTE}`
      : `git ${command} in a clone with a ten-file edit, a fresh process per run`,
    setup: gitSetup,
    command: git([command]),
  });
}

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
];

export default everydayCases;
