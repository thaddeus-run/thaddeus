import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'thaddeus-init-compiled-'));
const binary = join(sandbox, 'thaddeus');
const processes = new Set<ReturnType<typeof Bun.spawn>>();
beforeAll(() => {
  const build = Bun.spawnSync({
    cmd: ['bun', 'build', '--compile', '--outfile', binary, 'src/bin.ts'],
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);
}, 120_000);
afterAll(async () => {
  for (const child of processes) {
    child.kill();
    await child.exited;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

// Run the executable in separate homes, including the real OS home lookup.
async function cli(args: string[], cwd: string, home: string, expected = 0) {
  const child = Bun.spawn({
    cmd: [binary, ...args],
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  processes.add(child);
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  processes.delete(child);
  expect(exit, `${args.join(' ')}\n${stdout}\n${stderr}`).toBe(expected);
  return stdout;
}

// A separate executable owns the durable backend and the HTTP socket.
async function serve(data: string, port = 0) {
  const child = Bun.spawn({
    cmd: [binary, 'serve', '--data', data, '--port', String(port)],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  processes.add(child);
  const reader = child.stdout.getReader();
  let output = '';
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done)
        throw new Error(
          `server did not start: ${output}\n${await new Response(child.stderr).text()}`
        );
      output += new TextDecoder().decode(chunk.value);
      const match = /http:\/\/localhost:\d+/.exec(output);
      if (match !== null)
        return {
          url: match[0],
          stop: async () => {
            child.kill();
            await child.exited;
            processes.delete(child);
          },
        };
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

function directory(label: string) {
  return mkdtempSync(join(sandbox, `${label}-`));
}

test('documented first run, second push, clone and server restart through the compiled CLI', async () => {
  const home = directory('home');
  const source = directory('source');
  const data = directory('data');
  let server = await serve(data);
  try {
    mkdirSync(join(source, 'src'));
    writeFileSync(join(source, 'src', 'main.ts'), 'export const value = 1;\n');
    writeFileSync(join(source, 'binary'), new Uint8Array([0, 255, 13, 10]));
    writeFileSync(join(source, 'executable'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    const mode = statSync(join(source, 'executable')).mode;
    writeFileSync(join(source, '.env'), 'secret');
    writeFileSync(join(source, '.gitignore'), '.env\ndist/\n');
    writeFileSync(join(source, '.git'), 'gitdir: elsewhere');
    for (const dir of ['dist', 'node_modules']) {
      mkdirSync(join(source, dir));
      writeFileSync(join(source, dir, 'ignored'), 'ignored');
    }
    expect(await cli(['init'], source, home, 2)).toContain('identity init');
    await cli(['init', 'acme/web', '--server', server.url], source, home, 2);
    expect(existsSync(join(home, '.config'))).toBe(false);
    expect(await cli(['identity', 'init'], source, home)).toContain('did:key:');
    const seed = readFileSync(
      join(home, '.config', 'thaddeus', 'identity.json')
    );
    await cli(['use', server.url], source, home);
    const initialized = await cli(['init', 'acme/web'], source, home);
    expect(initialized).toContain('No file contents were uploaded');
    expect(
      readFileSync(join(home, '.config', 'thaddeus', 'identity.json'))
    ).toEqual(seed);
    expect(readFileSync(join(source, 'binary'))).toEqual(
      Buffer.from([0, 255, 13, 10])
    );
    expect(statSync(join(source, 'executable')).mode).toBe(mode);
    const initial = JSON.parse(await cli(['status', '--json'], source, home));
    expect(initial.ahead).toBe(0);
    expect(initial.added).toContain('src/main.ts');
    expect(initial.added).not.toContain('.env');
    const before = join(sandbox, 'before-push');
    await cli(
      ['clone', 'acme/web', before, '--server', server.url],
      sandbox,
      home
    );
    expect(existsSync(join(before, 'src', 'main.ts'))).toBe(false);
    await cli(['diff'], source, home);
    await cli(['push', '-m', 'initial import'], source, home);
    const clone = join(sandbox, 'after-push');
    await cli(
      ['clone', 'acme/web', clone, '--server', server.url],
      sandbox,
      home
    );
    expect(readFileSync(join(clone, 'src', 'main.ts'), 'utf8')).toBe(
      'export const value = 1;\n'
    );
    expect(readFileSync(join(clone, 'binary'))).toEqual(
      Buffer.from([0, 255, 13, 10])
    );
    expect(existsSync(join(clone, '.env'))).toBe(false);
    expect(existsSync(join(clone, 'dist'))).toBe(false);
    expect(existsSync(join(clone, 'node_modules'))).toBe(false);
    writeFileSync(join(source, 'src', 'main.ts'), 'export const value = 2;\n');
    await cli(['push', '-m', 'second change'], source, home);
    await cli(['pull'], clone, home);
    expect(readFileSync(join(clone, 'src', 'main.ts'), 'utf8')).toBe(
      'export const value = 2;\n'
    );
    expect(await cli(['init', 'acme/web'], source, home)).toContain(
      'already initialized'
    );
    const empty = directory('empty');
    await cli(['init', 'empty'], empty, home);
    expect(JSON.parse(await cli(['status', '--json'], empty, home)).clean).toBe(
      true
    );
    // Existing create/clone remains usable after the identity command migration.
    await cli(['create', 'legacy'], source, home);
    await cli(['clone', 'legacy', join(sandbox, 'legacy')], source, home);
    const otherHome = directory('other-home');
    await cli(['identity', 'init'], empty, otherHome);
    await cli(
      ['init', 'acme/web', '--server', server.url],
      directory('collision'),
      otherHome,
      1
    );
    const port = Number(new URL(server.url).port);
    await server.stop();
    server = await serve(data, port);
    await cli(
      ['clone', 'acme/web', join(sandbox, 'after-restart')],
      sandbox,
      home
    );
    expect(
      readFileSync(join(sandbox, 'after-restart', 'src', 'main.ts'), 'utf8')
    ).toBe('export const value = 2;\n');
    console.log(
      'Observed compiled first run: identity init -> init -> status/diff -> two pushes -> clone/pull -> server restart -> fresh clone.'
    );
  } finally {
    await server.stop();
  }
}, 120_000);

test('a killed init recovers a remote create through real HTTP', async () => {
  const home = directory('crash-home');
  const source = directory('crash-source');
  const server = await serve(directory('crash-data'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let killed = false;
  let creates = 0;
  const proxy = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const response = await fetch(
        new Request(server.url + url.pathname + url.search, request)
      );
      if (
        request.method === 'POST' &&
        url.pathname === '/repos' &&
        response.ok
      ) {
        creates++;
        if (!killed && child !== undefined) {
          killed = true;
          child.kill('SIGKILL');
        }
      }
      return response;
    },
  });
  const url = `http://localhost:${proxy.port}`;
  try {
    await cli(['identity', 'init'], source, home);
    writeFileSync(join(source, 'keep.txt'), 'untouched');
    child = Bun.spawn({
      cmd: [binary, 'init', 'recover', '--server', url],
      cwd: source,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    processes.add(child);
    const timeout = setTimeout(() => child?.kill(), 15_000);
    try {
      expect(await child.exited).not.toBe(0);
    } finally {
      clearTimeout(timeout);
    }
    processes.delete(child);
    expect(killed).toBe(true);
    expect(existsSync(join(source, '.thaddeus', 'config.json'))).toBe(false);
    await cli(['init', 'recover', '--server', url], source, home);
    expect(creates).toBe(1);
    expect(readFileSync(join(source, 'keep.txt'), 'utf8')).toBe('untouched');
    expect(
      JSON.parse(await cli(['status', '--json'], source, home)).added
    ).toEqual(['keep.txt']);
  } finally {
    await proxy.stop(true);
    await server.stop();
  }
}, 120_000);
