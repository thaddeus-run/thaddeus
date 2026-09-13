import { ready } from '@thaddeus.run/identity';
import { FileBackend, MemoryBackend } from '@thaddeus.run/persist';
import { ReviewLog, signVeto, VetoLog } from '@thaddeus.run/review';
import { createServer } from '@thaddeus.run/server';
import { scoped } from '@thaddeus.run/store';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadIdentity } from '../src/identity';
import { run } from '../src/run';
import { loadConfig, storePath } from '../src/workcopy';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-veto-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// init an identity in `home` against a shared server fetch.
async function clientHome(
  fetchImpl: (req: Request) => Promise<Response>,
  label: string
): Promise<string> {
  const home = mkdtempSync(join(tmp, `${label}-`));
  await run(['identity', 'init'], {
    cwd: home,
    home,
    fetchImpl,
    out: () => {},
  });
  return home;
}

describe('thaddeus veto', () => {
  test('a pushed veto blocks a land; log marks it ⛔; vetoes lists it', async () => {
    const srv = createServer({ backend: new MemoryBackend() });
    const fetchImpl = srv.fetch.bind(srv);
    const home = await clientHome(fetchImpl, 'home');
    const out: string[] = [];
    const e = (cwd: string) => ({
      cwd,
      home,
      fetchImpl,
      out: (l: string) => out.push(l),
    });

    await run(['create', 'http://t', 'proj'], e(home));
    const a = mkdtempSync(join(tmp, 'a-'));
    await run(['clone', 'http://t', 'proj', a], e(a));
    writeFileSync(join(a, 'auth.rs'), 'fn refresh() {}');

    // Upload without landing so there's a landable op to veto.
    expect(await run(['push', '--no-land'], e(a))).toBe(0);

    // Read the op id from `log` (the 10-char prefix it prints).
    out.length = 0;
    await run(['log'], e(a));
    const opId = out
      .join('\n')
      .split('\n')
      .find((l) => /^[0-9a-f]{10}/.test(l))
      ?.slice(0, 10);
    expect(opId).toBeDefined();

    // Lodge a veto on that op.
    out.length = 0;
    expect(await run(['veto', opId!, '-m', 'ships a secret'], e(a))).toBe(0);
    expect(out.join('\n')).toContain('vetoed');

    // The verified veto blocks the land.
    out.length = 0;
    expect(await run(['land'], e(a))).toBe(1);
    expect(out.join('\n').toLowerCase()).toContain('not landed');
    expect(out.join('\n').toLowerCase()).toContain('veto');

    // `log` marks the op ⛔; `vetoes <op>` lists the verified reason.
    out.length = 0;
    await run(['log'], e(a));
    expect(out.join('\n')).toContain('⛔');

    out.length = 0;
    expect(await run(['vetoes', opId!], e(a))).toBe(0);
    expect(out.join('\n')).toContain('ships a secret');
    expect(out.join('\n')).toContain('[verified]');
  });
});

test('outside reviewer grant, scoped veto, withdrawal, and revocation persist offline', async () => {
  const srv = createServer({ backend: new MemoryBackend() });
  const fetchImpl = srv.fetch.bind(srv);
  const owner = await clientHome(fetchImpl, 'owner');
  const reviewer = await clientHome(fetchImpl, 'reviewer');
  const wc = mkdtempSync(join(tmp, 'review-wc-'));
  const output: string[] = [];
  const env = (home = owner) => ({
    cwd: wc,
    home,
    fetchImpl,
    out: (line: string) => output.push(line),
  });
  expect(await run(['create', 'http://t', 'review-project'], env())).toBe(0);
  expect(await run(['clone', 'http://t', 'review-project', wc], env())).toBe(0);
  writeFileSync(join(wc, 'auth.rs'), 'fn refresh() {}');
  expect(await run(['push', '--no-land'], env())).toBe(0);
  output.length = 0;
  expect(await run(['log', '--json'], env())).toBe(0);
  const op = JSON.parse(output[0])[0].id as string;
  expect(await run(['veto', op], env(reviewer))).toBe(1);
  expect(
    await run(
      [
        'reviewer',
        'grant',
        loadIdentity(reviewer).did,
        '--paths',
        'auth.rs',
        '--max-active-vetoes',
        '2',
      ],
      env()
    )
  ).toBe(0);
  output.length = 0;
  expect(await run(['reviewer', 'list', '--json'], env())).toBe(0);
  const grant = JSON.parse(output[0])[0].id as string;
  expect(await run(['veto', op, '--grant', 'wrong'], env(reviewer))).toBe(1);
  expect(
    await run(
      ['veto', op, '--grant', grant, '-m', 'review required'],
      env(reviewer)
    )
  ).toBe(0);
  output.length = 0;
  expect(await run(['vetoes', op, '--json'], env(reviewer))).toBe(0);
  const veto = JSON.parse(output[0]).vetoes[0];
  expect(veto.lifecycle).toBe('active');
  expect(veto.status).toBe('verified');
  expect(await run(['land'], env())).toBe(1);
  expect(await run(['veto', 'withdraw', veto.id], env(reviewer))).toBe(0);
  output.length = 0;
  const offline = {
    ...env(reviewer),
    fetchImpl: () => Promise.reject(new Error('offline')),
  };
  expect(await run(['vetoes', op, '--json'], offline)).toBe(0);
  expect(JSON.parse(output[0]).vetoes[0].lifecycle).toBe('withdrawn');
  output.length = 0;
  expect(await run(['log', '--json'], offline)).toBe(0);
  expect(JSON.parse(output[0])[0].vetoed).toBe(false);
  // A valid legacy outsider signature has no authority to block an operation.
  const cfg = loadConfig(wc);
  const legacy = new VetoLog(
    scoped(new FileBackend(storePath(wc, cfg)), `repo/${cfg.repo}/`)
  );
  await legacy.ingest(
    signVeto(
      { op, reason: 'legacy outsider', at: new Date().toISOString() },
      loadIdentity(reviewer)
    )
  );
  output.length = 0;
  expect(await run(['log', '--json'], offline)).toBe(0);
  expect(JSON.parse(output[0])[0].vetoed).toBe(false);
  output.length = 0;
  expect(await run(['vetoes', op, '--json'], offline)).toBe(0);
  expect(
    JSON.parse(output[0]).vetoes.find(
      (v: { reason: string }) => v.reason === 'legacy outsider'
    )
  ).toMatchObject({ status: 'verified', lifecycle: 'legacy' });
  expect(await run(['reviewer', 'revoke', grant], env())).toBe(0);
  expect(await run(['veto', op, '--grant', grant], env(reviewer))).toBe(1);
  output.length = 0;
  expect(await run(['reviewer', 'list', '--json'], env())).toBe(0);
  expect(JSON.parse(output[0])).toEqual([]);
});

test.each(['grant', 'veto', 'withdraw', 'revoke'] as const)(
  'successful %s retains its local record when history refresh fails',
  async (action) => {
    const backend = new MemoryBackend();
    const srv = createServer({ backend });
    const ownerHome = await clientHome(srv.fetch, 'sync-owner');
    const reviewerHome = await clientHome(srv.fetch, 'sync-reviewer');
    const wc = mkdtempSync(join(tmp, 'sync-wc-'));
    const reviewerWc = mkdtempSync(join(tmp, 'sync-review-wc-'));
    const output: string[] = [];
    let failHistory = false;
    const env = (reviewer = false) => ({
      cwd: reviewer ? reviewerWc : wc,
      home: reviewer ? reviewerHome : ownerHome,
      out: (line: string) => output.push(line),
      fetchImpl: (req: Request) => {
        if (
          failHistory &&
          req.method === 'GET' &&
          new URL(req.url).pathname.endsWith('/vetoes')
        )
          return Promise.reject(new Error('history connection lost'));
        return srv.fetch(req);
      },
    });
    expect(await run(['create', 'http://t', 'sync'], env())).toBe(0);
    expect(await run(['clone', 'http://t', 'sync', wc], env())).toBe(0);
    writeFileSync(join(wc, 'auth.rs'), 'fn refresh() {}');
    expect(await run(['push'], env())).toBe(0);
    expect(
      await run(['clone', 'http://t', 'sync', reviewerWc], env(true))
    ).toBe(0);
    output.length = 0;
    expect(await run(['log', '--json'], env())).toBe(0);
    const op = JSON.parse(output[0])[0].id as string;
    const grantArgs = [
      'reviewer',
      'grant',
      loadIdentity(reviewerHome).did,
      '--paths',
      'auth.rs',
    ];
    const serverReviews = () =>
      ReviewLog.load(
        scoped(backend, 'repo/sync/'),
        'sync',
        loadIdentity(ownerHome).did
      );
    let grant = '';
    let veto = '';
    if (action !== 'grant') {
      expect(await run(grantArgs, env())).toBe(0);
      output.length = 0;
      expect(await run(['reviewer', 'list', '--json'], env())).toBe(0);
      grant = JSON.parse(output[0])[0].id;
    }
    if (action === 'withdraw') {
      expect(await run(['veto', op], env(true))).toBe(0);
      output.length = 0;
      expect(await run(['vetoes', op, '--json'], env(true))).toBe(0);
      veto = JSON.parse(output[0]).vetoes[0].id;
    }
    const args =
      action === 'grant'
        ? grantArgs
        : action === 'veto'
          ? ['veto', op]
          : action === 'withdraw'
            ? ['veto', 'withdraw', veto]
            : ['reviewer', 'revoke', grant];
    failHistory = true;
    output.length = 0;
    const reviewer = action === 'veto' || action === 'withdraw';
    const exit = await run(args, env(reviewer));
    const remote = await serverReviews();
    // The mutation reached the real server even though its following read failed.
    if (action === 'grant') expect(remote.grants()).toHaveLength(1);
    if (action === 'veto') expect(remote.vetoes()).toHaveLength(1);
    if (action === 'withdraw')
      expect(
        remote.status(remote.vetoes()[0], { id: op, path: 'auth.rs' })
      ).toBe('withdrawn');
    if (action === 'revoke') expect(remote.grants()).toHaveLength(0);
    expect(exit).toBe(0);
    expect(output.join('\n')).toContain('warning:');
    expect(output.join('\n')).toContain('pull');
    const root = reviewer ? reviewerWc : wc;
    const cfg = loadConfig(root);
    const local = await ReviewLog.load(
      scoped(new FileBackend(storePath(root, cfg)), 'repo/sync/'),
      'sync',
      loadIdentity(ownerHome).did
    );
    if (action === 'grant') expect(local.grants()).toHaveLength(1);
    if (action === 'revoke') expect(local.grants()).toHaveLength(0);
    if (reviewer) {
      output.length = 0;
      expect(await run(['vetoes', op, '--json'], env(true))).toBe(0);
      expect(JSON.parse(output[0]).vetoes[0].lifecycle).toBe(
        action === 'withdraw' ? 'withdrawn' : 'active'
      );
    }
  }
);

test('invalid reviewer grant options exit with usage status without granting authority', async () => {
  const backend = new MemoryBackend();
  const srv = createServer({ backend });
  const home = await clientHome(srv.fetch, 'invalid-grant');
  const wc = mkdtempSync(join(tmp, 'invalid-grant-wc-'));
  const env = { cwd: wc, home, fetchImpl: srv.fetch, out: () => {} };
  expect(await run(['create', 'http://t', 'invalid'], env)).toBe(0);
  expect(await run(['clone', 'http://t', 'invalid', wc], env)).toBe(0);
  for (const options of [
    [],
    ['--paths', ''],
    ['--paths', 'a/../b'],
    ['--paths', '**', '--max-vetoes-per-hour', 'NaN'],
    ['--paths', '**', '--max-active-vetoes', '0'],
  ]) {
    expect(
      await run(['reviewer', 'grant', loadIdentity(home).did, ...options], env)
    ).toBe(2);
  }
  const reviews = await ReviewLog.load(
    scoped(backend, 'repo/invalid/'),
    'invalid',
    loadIdentity(home).did
  );
  expect(reviews.grants()).toHaveLength(0);
});
