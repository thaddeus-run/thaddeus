import { ready } from '@thaddeus.run/identity';
import { type HeadRecordWire, signOp } from '@thaddeus.run/log';
import { FileBackend, MemoryBackend } from '@thaddeus.run/persist';
import { Platform } from '@thaddeus.run/platform';
import { createServer } from '@thaddeus.run/server';
import { encodeRecord } from '@thaddeus.run/store';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadIdentity } from '../src/identity';
import { run } from '../src/run';
import { saveConfig } from '../src/workcopy';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-heads-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('CLI signed heads', () => {
  test('pull --bootstrap-head signs the saved base, not the legacy server pointer', async () => {
    const home = mkdtempSync(join(tmp, 'owner-'));
    const work = mkdtempSync(join(tmp, 'work-'));
    await run(['init'], { cwd: work, home, out: () => {} });
    const owner = loadIdentity(home);
    const op = signOp(
      {
        path: 'retired.txt',
        parents: [],
        lamport: 0,
        at: '2026-07-13T00:00:00.000Z',
        payload: null,
      },
      owner
    );

    // The legacy server pointer is deliberately empty while the clean working
    // copy's saved base names an operation that exists at both ends.
    const serverBackend = new MemoryBackend();
    await serverBackend.put(
      'repo/legacy/meta/repo',
      encodeRecord({ owner: owner.did })
    );
    await serverBackend.put(`repo/legacy/op/${op.id}`, encodeRecord(op));
    await serverBackend.put('repo/legacy/view/main', encodeRecord([]));
    const server = createServer({ backend: serverBackend });

    const storePath = join(work, '.thaddeus', 'store');
    const localBackend = new FileBackend(storePath);
    await localBackend.put(`repo/legacy/op/${op.id}`, encodeRecord(op));
    await localBackend.put('repo/legacy/view/main', encodeRecord([op.id]));
    saveConfig(work, {
      server: 'http://t',
      repo: 'legacy',
      view: 'main',
      base: [op.id],
    });
    const output: string[] = [];
    const env = {
      cwd: work,
      home,
      fetchImpl: server.fetch.bind(server),
      out: (line: string) => output.push(line),
    };

    expect(await run(['pull'], env)).toBe(1);
    expect(output.join('\n')).toContain('requires owner head bootstrap');

    output.length = 0;
    expect(await run(['pull', '--bootstrap-head'], env)).toBe(0);
    expect(output.join('\n')).toContain('pulled legacy@main');
    const view = (await (
      await server.fetch(new Request('http://t/repos/legacy/views/main'))
    ).json()) as { head: HeadRecordWire };
    expect(view.head.heads).toEqual([op.id]);

    const reopened = await new Platform().openDurable(
      'legacy',
      new FileBackend(storePath)
    );
    expect(reopened.headRecords.current('main')?.heads).toEqual([op.id]);

    output.length = 0;
    expect(await run(['pull', '--bootstrap-head'], env)).toBe(2);
    expect(output.join('\n')).toContain('signed head history already exists');
  });
});
