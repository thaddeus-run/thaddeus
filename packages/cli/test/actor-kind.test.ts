import { ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { parseCliActorKind } from '../src/actor-kind';
import { loadIdentity } from '../src/identity';
import { run } from '../src/run';

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-actor-kind-'));
beforeAll(ready);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('attribution accepts explicit declarations and preserves the human default', () => {
  expect(parseCliActorKind(undefined, undefined)).toEqual({ kind: 'human' });
  expect(parseCliActorKind('human', 'explain')).toEqual({ kind: 'human' });
  expect(parseCliActorKind('agent:demo@0.1.10-alpha', 'explain')).toEqual({
    kind: 'agent:demo@0.1.10-alpha',
  });
  for (const raw of [
    '',
    ' ',
    'ci',
    'proof',
    'agent',
    'agent:x',
    'agent:@1',
    'agent:x@',
    'agent:x@y@z',
    'human ',
    'agent:x y@1',
    'agent:x@1\n',
  ]) {
    expect(parseCliActorKind(raw, 'explain')).toHaveProperty('error');
  }
  for (const kind of ['human', 'agent:demo@1']) {
    for (const message of [undefined, '', '   ']) {
      expect(parseCliActorKind(kind, message)).toHaveProperty('error');
    }
  }
});

type Why = {
  verified: boolean;
  records: {
    actor: string;
    actor_kind: string;
    intent: string;
    status: string;
    sig: unknown;
  }[];
};

// Use the actual server and durable checkout; only count requests at its boundary.
async function fixture() {
  const root = mkdtempSync(join(tmp, 'case-'));
  const home = join(root, 'home');
  const wc = join(root, 'wc');
  const server = createServer({ backend: new MemoryBackend() });
  let requests = 0;
  const fetchImpl = async (request: Request) => {
    requests++;
    return server.fetch(request);
  };
  const invoke = async (
    args: string[],
    cwd = wc,
    expected = 0,
    actorHome = home
  ) => {
    const lines: string[] = [];
    const code = await run(args, {
      cwd,
      home: actorHome,
      fetchImpl,
      out: (line) => lines.push(line),
    });
    expect(code, lines.join('\n')).toBe(expected);
    return lines.join('\n');
  };
  await invoke(['identity', 'init'], root);
  await invoke(['create', 'http://t', 'proj'], root);
  await invoke(['clone', 'http://t', 'proj', wc], root);
  writeFileSync(
    join(wc, 'auth.rs'),
    'fn refresh() {}\nfn login() { refresh(); }\n'
  );
  await invoke(['push', '-m', 'initial']);
  return { root, home, wc, invoke, requests: () => requests };
}

// Byte comparisons catch configuration/store changes as well as rewritten source.
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(root, path)] = readFileSync(path).toString('base64');
  }
  return files;
}

for (const command of ['push', 'rename'] as const) {
  test(`${command} keeps the human default for a delegated collaborator`, async () => {
    const f = await fixture();
    const delegateHome = join(f.root, 'delegate-home');
    await f.invoke(['identity', 'init'], f.root, 0, delegateHome);
    const did = loadIdentity(delegateHome).did;
    await f.invoke(['grant', did, '--paths', '**']);
    const wc = join(f.root, 'delegate-wc');
    await f.invoke(['clone', 'http://t', 'proj', wc], f.root, 0, delegateHome);
    if (command === 'push')
      writeFileSync(join(wc, 'auth.rs'), 'fn refresh() { /* delegate */ }\n');
    const args =
      command === 'push' ? ['push'] : ['rename', 'refresh', 'refreshToken'];
    await f.invoke(
      [...args, '--no-land', '-m', 'delegated edit'],
      wc,
      0,
      delegateHome
    );
    const [op] = JSON.parse(
      await f.invoke(['query', 'by', did, '--json'], wc, 0, delegateHome)
    ) as { id: string }[];
    expect(op).toBeDefined();
    const answer = JSON.parse(
      await f.invoke(['query', 'why', op.id, '--json'], wc, 0, delegateHome)
    ) as Why;
    expect(answer.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_kind: 'human',
          actor: did,
          intent: 'delegated edit',
          status: 'verified',
        }),
      ])
    );
    await f.invoke(['land'], wc);
  });

  test(`${command} preserves declared agent provenance through a fresh clone`, async () => {
    const f = await fixture();
    const args =
      command === 'push' ? ['push'] : ['rename', 'refresh', 'refreshToken'];
    if (command === 'push')
      writeFileSync(join(f.wc, 'auth.rs'), 'fn refresh() { /* changed */ }\n');
    await f.invoke([
      ...args,
      '-m',
      'explain agent edit',
      '--actor-kind',
      'agent:demo@1',
    ]);
    const copy = join(f.root, 'readback');
    await f.invoke(['clone', 'http://t', 'proj', copy], f.root);
    const ops = JSON.parse(
      await f.invoke(['query', 'by', loadIdentity(f.home).did, '--json'], copy)
    ) as { id: string }[];
    const answers = await Promise.all(
      ops.map(
        async (op) =>
          JSON.parse(
            await f.invoke(['query', 'why', op.id, '--json'], copy)
          ) as Why
      )
    );
    expect(
      answers.some(
        (answer) =>
          answer.verified &&
          answer.records.some(
            (record) =>
              record.actor_kind === 'agent:demo@1' &&
              record.actor === loadIdentity(f.home).did &&
              record.intent === 'explain agent edit' &&
              record.status === 'verified'
          )
      )
    ).toBe(true);
    expect(
      answers.some((answer) =>
        answer.records.some(
          (record) =>
            record.actor_kind === 'human' && record.intent === 'initial'
        )
      )
    ).toBe(true);
    expect(readFileSync(join(copy, 'auth.rs'), 'utf8')).toBe(
      readFileSync(join(f.wc, 'auth.rs'), 'utf8')
    );
  });

  test(`${command} rejects invalid attribution before touching a dirty checkout or server`, async () => {
    const f = await fixture();
    writeFileSync(join(f.wc, 'auth.rs'), 'fn refresh() { /* dirty */ }\n');
    const args =
      command === 'push' ? ['push'] : ['rename', 'refresh', 'refreshToken'];
    const before = snapshot(f.wc);
    for (const flags of [
      ['--actor-kind', 'ci', '-m', 'explain'],
      ['--actor-kind', 'agent:demo@1'],
      ['--actor-kind', 'human', '-m', ' '],
      ['--actor-kind', 'agent:demo@1', '-m', ''],
    ]) {
      const requests = f.requests();
      expect(await f.invoke([...args, ...flags], f.wc, 2)).toContain(
        '--actor-kind'
      );
      expect(f.requests()).toBe(requests);
      expect(snapshot(f.wc)).toEqual(before);
    }
    const copy = join(f.root, 'unchanged-main');
    await f.invoke(['clone', 'http://t', 'proj', copy], f.root);
    expect(readFileSync(join(copy, 'auth.rs'), 'utf8')).toBe(
      'fn refresh() {}\nfn login() { refresh(); }\n'
    );
    expect(JSON.parse(await f.invoke(['log', '--json'], copy))).toHaveLength(1);
  });
}

test('retrying an ahead operation preserves agent claims and appends the default human explanation', async () => {
  const f = await fixture();
  writeFileSync(join(f.wc, 'auth.rs'), 'fn refresh() { /* agent */ }\n');
  const firstArgs = [
    'push',
    '--no-land',
    '-m',
    'first',
    '--actor-kind',
    'agent:demo@1',
  ];
  await f.invoke(firstArgs);
  const ops = JSON.parse(await f.invoke(['log', '--json'])) as { id: string }[];
  const op = ops[0];
  const first = JSON.parse(
    await f.invoke(['query', 'why', op.id, '--json'])
  ) as Why;
  await f.invoke(firstArgs);
  const repeated = JSON.parse(
    await f.invoke(['query', 'why', op.id, '--json'])
  ) as Why;
  expect(repeated.records).toEqual(first.records);
  await f.invoke(['push', '-m', 'human follow-up']);
  const copy = join(f.root, 'retry-readback');
  await f.invoke(['clone', 'http://t', 'proj', copy], f.root);
  const answer = JSON.parse(
    await f.invoke(['query', 'why', op.id, '--json'], copy)
  ) as Why;
  expect(answer.verified).toBe(true);
  expect(answer.records).toEqual(expect.arrayContaining(first.records));
  expect(answer.records).toHaveLength(2);
  expect(answer.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        actor_kind: 'human',
        intent: 'human follow-up',
        status: 'verified',
      }),
    ])
  );
});
