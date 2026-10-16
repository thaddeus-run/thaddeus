// Run the checkout's compiled CLI through real uploads, owner landings, and policy refusals.
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Actor = { label: string; home: string };
type CommandResult = { code: number; stdout: string; stderr: string };
type CommandExpectation = { code: number; reason?: string };
type Running = {
  child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  stdout: string;
  stderr: string;
  drained: Promise<void>;
};
type QueryOp = { id: string; author: string; path: string };
type Why = {
  op: QueryOp;
  verified: boolean;
  records: {
    actor: string;
    actor_kind: string;
    intent: string;
    status: string;
  }[];
};

const root = mkdtempSync(join(tmpdir(), 'thaddeus-agent-demo-'));
const transcript = join(root, 'transcript.log');
const executable = resolve(
  import.meta.dir,
  '../../../packages/cli/release/thaddeus'
);
const binary = process.platform === 'win32' ? `${executable}.exe` : executable;
const running = new Set<Running>();
const abort = new AbortController();
let stopping = false;
let cancellationCode = 1;
let successful = false;

// Keep the displayed transcript and retained evidence identical, without reading identity seeds.
function print(text: string): void {
  appendFileSync(transcript, text);
  process.stdout.write(text);
}
function line(text: string): void {
  print(`${text}\n`);
}
function checkAbort(): void {
  if (abort.signal.aborted) throw abort.signal.reason;
}
function interrupt(signal: 'SIGINT' | 'SIGTERM'): void {
  cancellationCode = signal === 'SIGINT' ? 130 : 143;
  abort.abort(new Error(`interrupted by ${signal}`));
}
const onSigint = () => interrupt('SIGINT');
const onSigterm = () => interrupt('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);
const deadline = setTimeout(
  () => abort.abort(new Error('demo exceeded 120 seconds')),
  120_000
);

// Register every process before reading its streams so all failure paths can reap it.
function spawn(
  actor: Actor,
  cwd: string,
  args: string[],
  onStdout?: (text: string) => void
): Running {
  checkAbort();
  mkdirSync(actor.home, { recursive: true });
  line(
    `\n$ [${actor.label}; ${cwd}] thaddeus ${args.map((arg) => JSON.stringify(arg)).join(' ')}`
  );
  const child = Bun.spawn({
    cmd: [binary, ...args],
    cwd,
    env: { ...process.env, HOME: actor.home, USERPROFILE: actor.home },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const task = { child, stdout: '', stderr: '', drained: Promise.resolve() };
  running.add(task);
  line(`Process PID: ${child.pid}`);
  const drain = async (
    stream: ReadableStream<Uint8Array>,
    channel: 'stdout' | 'stderr'
  ) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      task[channel] += text;
      print(text);
      if (channel === 'stdout') onStdout?.(task.stdout);
    }
  };
  task.drained = Promise.all([
    drain(child.stdout, 'stdout'),
    drain(child.stderr, 'stderr'),
  ]).then(() => {});
  // A stream failure must cancel the run, including when the server is idle.
  void task.drained.catch((error: unknown) => abort.abort(error));
  return task;
}

// A finite invocation owns its deadline and preserves raw stdout for JSON parsing.
async function invoke(
  actor: Actor,
  cwd: string,
  args: string[],
  expected: CommandExpectation = { code: 0 }
): Promise<CommandResult> {
  const task = spawn(actor, cwd, args);
  const cancel = () => task.child.kill('SIGKILL');
  abort.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(
    () =>
      abort.abort(new Error(`command exceeded 15 seconds: ${args.join(' ')}`)),
    15_000
  );
  try {
    const [code] = await Promise.all([task.child.exited, task.drained]);
    line(`Exit: ${code}`);
    checkAbort();
    assert.equal(
      code,
      expected.code,
      `${args.join(' ')}\n${task.stdout}\n${task.stderr}`
    );
    if (expected.reason)
      assert.ok(
        (task.stdout + task.stderr).includes(expected.reason),
        `missing rejection reason: ${expected.reason}`
      );
    return { code, stdout: task.stdout, stderr: task.stderr };
  } finally {
    clearTimeout(timer);
    abort.signal.removeEventListener('abort', cancel);
    if (task.child.exitCode !== null) running.delete(task);
  }
}

async function json<T>(actor: Actor, cwd: string, args: string[]): Promise<T> {
  return JSON.parse(
    (await invoke(actor, cwd, [...args, '--json'])).stdout
  ) as T;
}

// Read the actual ephemeral URL and check readiness; the server remains tracked until shutdown.
async function startServer(): Promise<string> {
  let announced = false;
  let resolveUrl: (url: string) => void = () => {};
  let rejectUrl: (error: unknown) => void = () => {};
  const urlReady = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  const cancel = () => rejectUrl(abort.signal.reason);
  abort.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(
    () => abort.abort(new Error('server startup exceeded 15 seconds')),
    15_000
  );
  try {
    const server = spawn(
      { label: 'server', home: join(root, 'server-home') },
      root,
      ['serve', '--data', join(root, 'server'), '--port', '0'],
      (output) => {
        const match = /http:\/\/localhost:\d+(?=\s)/.exec(output);
        if (match !== null) resolveUrl(match[0]);
      }
    );
    void server.child.exited.then((code) => {
      if (!stopping)
        abort.abort(new Error(`server exited unexpectedly with code ${code}`));
    });
    const url = await urlReady;
    const response = await fetch(`${url}/repos`, { signal: abort.signal });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      repos: [],
      owners: {},
      nextCursor: null,
    });
    line(`Demo server: ${JSON.stringify({ pid: server.child.pid, url })}`);
    announced = true;
    return url;
  } finally {
    clearTimeout(timer);
    abort.signal.removeEventListener('abort', cancel);
    if (!announced) line('Server startup did not complete.');
  }
}

// A zero upload exit code alone can hide rejected bundle records.
function assertUpload(
  result: CommandResult,
  expectedOps: number,
  expectedWhy = 1
): void {
  assert.doesNotMatch(result.stdout + result.stderr, /rejected \d+ item\(s\)/);
  const counts = /uploaded (\d+) op\(s\), (\d+) object\(s\), (\d+) why/.exec(
    result.stdout
  );
  assert.ok(
    counts !== null,
    'upload must include operations, content, and signed explanations'
  );
  // Every fixture operation writes one distinct payload; the bundle includes its ancestry.
  assert.deepEqual(counts.slice(1).map(Number), [
    expectedOps,
    expectedOps,
    expectedWhy,
  ]);
}

function assertWhy(
  answer: Why,
  op: QueryOp,
  did: string,
  kind: string,
  intent: string
): void {
  assert.equal(answer.op.id, op.id);
  assert.equal(answer.op.author, did);
  assert.equal(answer.verified, true);
  assert.ok(
    answer.records.some(
      (record) =>
        record.actor === did &&
        record.actor_kind === kind &&
        record.intent === intent &&
        record.status === 'verified'
    )
  );
}

// Each rejected candidate starts from remote main, keeping earlier rejected ancestry out.
async function clone(
  actor: Actor,
  url: string,
  repo: string,
  label: string
): Promise<string> {
  const cwd = join(root, label);
  await invoke(actor, root, ['clone', repo, cwd, '--server', url]);
  return cwd;
}
async function ids(actor: Actor, cwd: string): Promise<string[]> {
  return (await json<QueryOp[]>(actor, cwd, ['log'])).map((op) => op.id).sort();
}

// Check accepted history through a new clone, never through a rejected candidate's local state.
async function unchanged(
  owner: Actor,
  url: string,
  repo: string,
  label: string,
  expected: string[],
  files: Record<string, string>
): Promise<string> {
  const cwd = await clone(owner, url, repo, label);
  assert.deepEqual(await ids(owner, cwd), expected);
  for (const [path, bytes] of Object.entries(files))
    assert.equal(readFileSync(join(cwd, path), 'utf8'), bytes);
  return cwd;
}

async function story(): Promise<void> {
  assert.ok(
    existsSync(binary),
    `compile the checkout first: CI= moon run cli:compile (${binary})`
  );
  const url = await startServer();
  const owner = { label: 'owner', home: join(root, 'owner-home') };
  const agent = { label: 'agent', home: join(root, 'agent-home') };
  const reviewer = { label: 'reviewer', home: join(root, 'reviewer-home') };
  const version = (await invoke(owner, root, ['--version'])).stdout.trim();
  const kind = `agent:thaddeus-demo@${version}`;
  line('\nAct 1: seed main with an owner identity.');
  const dids = new Map<string, string>();
  for (const actor of [owner, agent, reviewer]) {
    await invoke(actor, root, ['identity', 'init']);
    dids.set(
      actor.label,
      (await json<{ did: string }>(actor, root, ['whoami'])).did
    );
  }
  const ownerDid = dids.get('owner')!;
  const agentDid = dids.get('agent')!;
  const reviewerDid = dids.get('reviewer')!;
  const project = join(root, 'owner-project');
  mkdirSync(join(project, 'src/auth'), { recursive: true });
  const greeting = 'export const greeting = "hello";\n';
  const auth = 'export const requireLogin = true;\n';
  writeFileSync(join(project, 'src/greeting.ts'), greeting);
  writeFileSync(join(project, 'src/auth/session.ts'), auth);
  await invoke(owner, project, ['init', 'acme/web', '--server', url]);
  assert.equal(
    readFileSync(join(project, 'src/greeting.ts'), 'utf8'),
    greeting
  );
  assert.equal(
    readFileSync(join(project, 'src/auth/session.ts'), 'utf8'),
    auth
  );
  assertUpload(await invoke(owner, project, ['push', '-m', 'seed demo']), 2, 2);
  const seeded = await clone(owner, url, 'acme/web', 'seed-readback');
  assert.equal(readFileSync(join(seeded, 'src/greeting.ts'), 'utf8'), greeting);
  assert.equal(readFileSync(join(seeded, 'src/auth/session.ts'), 'utf8'), auth);
  for (const op of await json<QueryOp[]>(owner, seeded, ['log'])) {
    assertWhy(
      await json<Why>(owner, seeded, ['query', 'why', op.id]),
      op,
      ownerDid,
      'human',
      'seed demo'
    );
  }

  line(
    '\nAct 2: delegate src/** with a two-operation budget and protect auth.'
  );
  await invoke(owner, project, [
    'grant',
    agentDid,
    '--paths',
    'src/**',
    '--max-changes',
    '2',
  ]);
  const grants = await json<
    { agent: string; paths: string[]; maxChanges: number }[]
  >(owner, project, ['grants']);
  assert.ok(
    grants.some(
      (g) =>
        g.agent === agentDid &&
        g.maxChanges === 2 &&
        g.paths.length === 1 &&
        g.paths[0] === 'src/**'
    )
  );
  await invoke(owner, project, [
    'policy',
    'set',
    '--protect',
    'src/auth/**',
    '--allow',
    ownerDid,
    '--require-provenance',
  ]);
  const policy = await json<{
    restrictPaths: { protect: string[]; allow: string[] }[];
    requireVerifiedProvenance: boolean;
  }>(owner, project, ['policy']);
  assert.equal(policy.requireVerifiedProvenance, true);
  assert.deepEqual(policy.restrictPaths[0]?.protect, ['src/auth/**']);
  assert.deepEqual(policy.restrictPaths[0]?.allow, [ownerDid]);

  line('\nAct 3: the agent uploads a signed why; the owner signs the landing.');
  await invoke(agent, root, ['use', url]);
  const parent = join(root, 'agent-allowed');
  mkdirSync(parent);
  await invoke(agent, parent, ['clone', 'acme/web']);
  const candidate = join(parent, 'web');
  assert.ok(existsSync(candidate));
  assert.equal(existsSync(join(parent, 'acme/web')), false);
  const welcome = 'export const greeting = "welcome";\n';
  writeFileSync(join(candidate, 'src/greeting.ts'), welcome);
  assertUpload(
    await invoke(
      agent,
      candidate,
      ['push', '-m', 'make greeting welcoming', '--actor-kind', kind],
      { code: 1, reason: 'owner signature required' }
    ),
    3
  );
  await invoke(owner, candidate, ['land']);
  const accepted = await clone(owner, url, 'acme/web', 'accepted-readback');
  const acceptedIds = await ids(owner, accepted);
  assert.equal(
    readFileSync(join(accepted, 'src/greeting.ts'), 'utf8'),
    welcome
  );
  const acceptedFiles = {
    'src/greeting.ts': welcome,
    'src/auth/session.ts': auth,
  };

  line('\nAct 4: an uploaded protected-path change is rejected at owner land.');
  const protectedCopy = await clone(
    agent,
    url,
    'acme/web',
    'protected-candidate'
  );
  writeFileSync(
    join(protectedCopy, 'src/auth/session.ts'),
    'export const requireLogin = false;\n'
  );
  assertUpload(
    await invoke(agent, protectedCopy, [
      'push',
      '--no-land',
      '-m',
      'attempt to disable login',
      '--actor-kind',
      kind,
    ]),
    4
  );
  const protectedResult = await invoke(owner, protectedCopy, ['land'], {
    code: 1,
    reason: 'protected paths',
  });
  assert.ok(protectedResult.stdout.includes('not landed'));
  await unchanged(
    owner,
    url,
    'acme/web',
    'protected-readback',
    acceptedIds,
    acceptedFiles
  );
  line('Verified: protected-path rejection');

  line(
    "\nAct 5: query the agent's accepted work and verify its signed explanation."
  );
  const byAgent = await json<QueryOp[]>(owner, accepted, [
    'query',
    'by',
    agentDid,
  ]);
  assert.equal(byAgent.length, 1);
  assert.equal(byAgent[0].path, 'src/greeting.ts');
  assertWhy(
    await json<Why>(owner, accepted, ['query', 'why', byAgent[0].id]),
    byAgent[0],
    agentDid,
    kind,
    'make greeting welcoming'
  );
  line('Verified: accepted agent history');

  line(
    '\nAct 6: exhaust a separate one-operation budget, without protection or veto rules.'
  );
  const budgetProject = join(root, 'budget-project');
  mkdirSync(join(budgetProject, 'src'), { recursive: true });
  writeFileSync(
    join(budgetProject, 'src/value.ts'),
    'export const value = 0;\n'
  );
  await invoke(owner, budgetProject, [
    'init',
    'acme/budget-demo',
    '--server',
    url,
  ]);
  assertUpload(
    await invoke(owner, budgetProject, ['push', '-m', 'seed budget example']),
    1
  );
  await invoke(owner, budgetProject, [
    'grant',
    agentDid,
    '--paths',
    'src/**',
    '--max-changes',
    '1',
  ]);
  const budgetFirst = await clone(
    agent,
    url,
    'acme/budget-demo',
    'budget-first'
  );
  writeFileSync(join(budgetFirst, 'src/value.ts'), 'export const value = 1;\n');
  assertUpload(
    await invoke(agent, budgetFirst, [
      'push',
      '--no-land',
      '-m',
      'spend one operation',
      '--actor-kind',
      kind,
    ]),
    2
  );
  await invoke(owner, budgetFirst, ['land']);
  const budgetIds = await ids(owner, budgetFirst);
  const budgetSecond = await clone(
    agent,
    url,
    'acme/budget-demo',
    'budget-second'
  );
  writeFileSync(
    join(budgetSecond, 'src/value.ts'),
    'export const value = 2;\n'
  );
  assertUpload(
    await invoke(agent, budgetSecond, [
      'push',
      '--no-land',
      '-m',
      'exceed the budget',
      '--actor-kind',
      kind,
    ]),
    3
  );
  const exhausted = await invoke(owner, budgetSecond, ['land'], {
    code: 1,
    reason: 'over its change budget',
  });
  assert.ok(exhausted.stdout.includes('not landed'));
  await unchanged(
    owner,
    url,
    'acme/budget-demo',
    'budget-readback',
    budgetIds,
    { 'src/value.ts': 'export const value = 1;\n' }
  );
  line('Verified: independent budget exhaustion');

  line(
    '\nAct 7: hand the local candidate checkout to an independently authorized reviewer.'
  );
  const reviewCopy = await clone(agent, url, 'acme/web', 'review-candidate');
  writeFileSync(
    join(reviewCopy, 'src/greeting.ts'),
    'export const greeting = "welcome back";\n'
  );
  assertUpload(
    await invoke(agent, reviewCopy, [
      'push',
      '--no-land',
      '-m',
      'propose a returning-user greeting',
      '--actor-kind',
      kind,
    ]),
    4
  );
  const pending = (
    await json<QueryOp[]>(agent, reviewCopy, ['query', 'by', agentDid])
  ).filter((op) => !acceptedIds.includes(op.id));
  assert.equal(pending.length, 1);
  const op = pending[0];
  assertWhy(
    await json<Why>(agent, reviewCopy, ['query', 'why', op.id]),
    op,
    agentDid,
    kind,
    'propose a returning-user greeting'
  );
  await invoke(owner, project, [
    'reviewer',
    'grant',
    reviewerDid,
    '--paths',
    'src/**',
  ]);
  const reviewers = await json<
    { id: string; reviewer: string; paths: string[] }[]
  >(owner, project, ['reviewer', 'list']);
  const grant = reviewers.find((g) => g.reviewer === reviewerDid);
  assert.ok(grant !== undefined);
  assert.deepEqual(grant.paths, ['src/**']);
  line(
    'Local handoff supplies the checkout; the reviewer grant supplies veto authority, not decryption rights.'
  );
  await invoke(reviewer, reviewCopy, [
    'veto',
    op.id,
    '--grant',
    grant.id,
    '-m',
    'needs a focused review',
  ]);
  const vetoes = await json<{
    vetoes: {
      reviewer: string;
      reason: string;
      status: string;
      lifecycle: string;
    }[];
  }>(reviewer, reviewCopy, ['vetoes', op.id]);
  assert.ok(
    vetoes.vetoes.some(
      (veto) =>
        veto.reviewer === reviewerDid &&
        veto.reason === 'needs a focused review' &&
        veto.status === 'verified' &&
        veto.lifecycle === 'active'
    )
  );
  const vetoed = await invoke(owner, reviewCopy, ['land'], {
    code: 1,
    reason: 'veto',
  });
  assert.ok(vetoed.stdout.includes('not landed'));
  await unchanged(
    owner,
    url,
    'acme/web',
    'veto-readback',
    acceptedIds,
    acceptedFiles
  );
  line('Verified: reviewer veto');
}

// Stop and reap every owned child before removing any successful run's evidence.
async function shutdown(): Promise<void> {
  stopping = true;
  for (const task of running) {
    if (task.child.exitCode === null) task.child.kill('SIGINT');
  }
  const escalation = setTimeout(() => {
    for (const task of running) {
      if (task.child.exitCode === null) task.child.kill('SIGKILL');
    }
  }, 5000);
  try {
    await Promise.all(
      [...running].map(async (task) => {
        await task.child.exited;
        await task.drained;
        running.delete(task);
      })
    );
  } finally {
    clearTimeout(escalation);
  }
}

line(`Demo run: ${JSON.stringify({ root })}`);
try {
  await story();
  checkAbort();
  successful = true;
} catch (error) {
  line(
    `Demo failed: ${error instanceof Error ? error.message : String(error)}`
  );
} finally {
  clearTimeout(deadline);
  try {
    await shutdown();
  } catch (error) {
    successful = false;
    line(
      `Demo failed: shutdown: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);
  if (abort.signal.aborted) successful = false;
  if (successful) {
    try {
      rmSync(root, { recursive: true });
    } catch (error) {
      successful = false;
      console.error(`Demo failed: cleanup: ${String(error)}`);
    }
  }
  if (successful)
    console.log(
      'Demo complete: all assertions passed; child processes stopped and temporary state removed.'
    );
  else console.log(`Demo evidence retained: ${root}`);
  process.exitCode = successful ? 0 : cancellationCode;
}
