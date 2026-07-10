import { ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/run';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-reveal-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('schedule-reveal / reveal', () => {
  test('schedules committed content and reports an early manual trigger', async () => {
    const server = createServer({ backend: new MemoryBackend() });
    const home = mkdtempSync(join(tmp, 'home-'));
    const work = mkdtempSync(join(tmp, 'work-'));
    const output: string[] = [];
    const env = (cwd: string) => ({
      cwd,
      home,
      fetchImpl: server.fetch.bind(server),
      out: (line: string) => output.push(line),
    });

    expect(await run(['init'], env(home))).toBe(0);
    expect(await run(['create', 'http://t', 'r'], env(home))).toBe(0);
    expect(await run(['clone', 'http://t', 'r', work], env(home))).toBe(0);
    writeFileSync(join(work, 'announcement.md'), 'not yet');
    expect(await run(['push'], env(work))).toBe(0);

    output.length = 0;
    const at = '2099-01-01T00:00:00.000Z';
    expect(
      await run(
        ['schedule-reveal', 'announcement.md', '--at', at, '--json'],
        env(work)
      )
    ).toBe(0);
    expect(JSON.parse(output[0])).toMatchObject({
      path: 'announcement.md',
      at,
      scheduled: true,
      released: false,
      public: false,
    });

    output.length = 0;
    expect(await run(['reveal', 'announcement.md', '--json'], env(work))).toBe(
      0
    );
    expect(JSON.parse(output[0])).toMatchObject({
      path: 'announcement.md',
      released: false,
      public: false,
    });
  });

  test('rejects an invalid timestamp before contacting the server', async () => {
    const output: string[] = [];
    const code = await run(['schedule-reveal', 'x', '--at', 'not-a-date'], {
      cwd: tmp,
      home: tmp,
      out: (line) => output.push(line),
    });
    expect(code).toBe(2);
    expect(output.join('\n')).toContain('invalid --at');
  });
});
