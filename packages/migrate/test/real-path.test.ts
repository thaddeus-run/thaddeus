import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The real user path: the compiled `thaddeus` CLI creates and shares a
// repository on a real `thaddeus serve`, then a migration process that is
// killed twice moves it into a trusted-service directory, while the same CLI
// keeps working against the keyless server.
const FIXTURE = join(import.meta.dir, 'fixtures', 'migrate-process.ts');
const root = mkdtempSync(join(tmpdir(), 'thaddeus-migrate-real-'));
const binary = join(root, 'thaddeus');
const servers = new Set<ReturnType<typeof Bun.spawn>>();

beforeAll(() => {
  const build = Bun.spawnSync({
    cmd: ['bun', 'build', '--compile', '--outfile', binary, 'src/bin.ts'],
    cwd: resolve(import.meta.dir, '..', '..', 'cli'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);
}, 120_000);

afterAll(async () => {
  for (const server of servers) {
    server.kill();
    await server.exited;
  }
  rmSync(root, { recursive: true, force: true });
});

// A free port, so a restarted server comes back where working copies expect it.
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = probe.port;
  void probe.stop(true);
  return port as number;
}

async function serve(data: string, port: number) {
  const server = Bun.spawn({
    cmd: [binary, 'serve', '--data', data, '--port', String(port)],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  servers.add(server);
  const reader = server.stdout.getReader();
  let out = '';
  const url = await Promise.race([
    (async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done)
          throw new Error(`server exited before listening: ${out}`);
        out += new TextDecoder().decode(chunk.value);
        const match = /http:\/\/localhost:\d+/.exec(out);
        if (match !== null) return match[0];
      }
    })(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('server startup timed out')), 15_000)
    ),
  ]);
  return {
    url,
    stop: async () => {
      server.kill('SIGINT');
      await server.exited;
      reader.releaseLock();
      servers.delete(server);
    },
  };
}

function cli(home: string, cwd: string, ...args: string[]) {
  const run = Bun.spawnSync({
    cmd: [binary, ...args],
    cwd,
    env: { ...process.env, HOME: home, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: run.exitCode,
    out:
      new TextDecoder().decode(run.stdout) +
      new TextDecoder().decode(run.stderr),
  };
}

function ok(result: { code: number | null; out: string }): string {
  expect(result.code, result.out).toBe(0);
  return result.out;
}

function fixture(
  mode: string,
  dir: string,
  url: string,
  ownerHome: string,
  guestHome: string
) {
  return Bun.spawnSync({
    cmd: ['bun', FIXTURE, mode, dir, url, ownerHome, guestHome],
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

test('the CLI user path, two killed migration processes and a second identity', async () => {
  const ownerHome = join(root, 'owner-home');
  const guestHome = join(root, 'guest-home');
  const service = join(root, 'service');
  for (const dir of [ownerHome, guestHome, service]) mkdirSync(dir);
  const port = freePort();
  let keyless = await serve(join(root, 'keyless'), port);

  // The owner creates and publishes a repository with the shipped CLI.
  ok(cli(ownerHome, root, 'identity', 'init'));
  ok(cli(guestHome, root, 'identity', 'init'));
  const guestDid = ok(cli(guestHome, root, 'whoami')).trim();
  ok(cli(ownerHome, root, 'use', keyless.url));
  ok(cli(guestHome, root, 'use', keyless.url));
  const web = join(root, 'owner', 'web');
  mkdirSync(join(web, 'src'), { recursive: true });
  writeFileSync(join(web, 'README.md'), 'owner notes\n');
  writeFileSync(join(web, 'src', 'main.rs'), 'fn main() {}\n');
  ok(cli(ownerHome, web, 'init', 'acme/web'));
  expect(ok(cli(ownerHome, web, 'push', '-m', 'initial import'))).toContain(
    'published to main'
  );
  writeFileSync(join(web, 'src', 'main.rs'), 'fn main() { println!("hi"); }\n');
  ok(cli(ownerHome, web, 'push', '-m', 'print a greeting'));

  // A second identity contributes, and the owner lands it.
  ok(cli(ownerHome, web, 'grant', guestDid));
  const guestDir = join(root, 'guest');
  mkdirSync(guestDir);
  ok(cli(guestHome, guestDir, 'clone', 'acme/web', 'web'));
  writeFileSync(join(guestDir, 'web', 'src', 'auth.rs'), 'fn login() {}\n');
  const guestPush = cli(
    guestHome,
    join(guestDir, 'web'),
    'push',
    '-m',
    'add login'
  );
  expect(guestPush.code).toBe(1);
  expect(guestPush.out).toContain('owner signature required to publish');
  ok(cli(ownerHome, join(guestDir, 'web'), 'land'));
  ok(cli(ownerHome, web, 'pull'));
  expect(readFileSync(join(web, 'src', 'auth.rs'), 'utf8')).toBe(
    'fn login() {}\n'
  );

  // A repository that is never migrated.
  const api = join(root, 'owner', 'api');
  mkdirSync(api);
  writeFileSync(join(api, 'index.ts'), 'export {}\n');
  ok(cli(ownerHome, api, 'init', 'acme/api'));
  ok(cli(ownerHome, api, 'push', '-m', 'api'));

  // 1. The import dies after two files.
  const first = fixture(
    'import-crash',
    service,
    keyless.url,
    ownerHome,
    guestHome
  );
  expect(first.stderr.toString()).toBe('');
  expect(first.signalCode).toBe('SIGKILL');
  const imported = JSON.parse(
    readFileSync(join(service, 'import.json'), 'utf8')
  );
  expect(imported).toMatchObject({
    files: 4,
    missing: 4,
    stored: 2,
    remaining: 2,
  });

  // The keyless server restarts, and the shipped CLI keeps working on both
  // repositories while the migration is pending.
  await keyless.stop();
  keyless = await serve(join(root, 'keyless'), port);
  writeFileSync(join(api, 'index.ts'), 'export const api = 1;\n');
  ok(cli(ownerHome, api, 'push', '-m', 'api during migration'));
  ok(cli(guestHome, guestDir, 'clone', 'acme/web', 'during'));
  expect(readFileSync(join(guestDir, 'during', 'src', 'auth.rs'), 'utf8')).toBe(
    'fn login() {}\n'
  );

  // 2. A new process resumes the import, verifies, and dies mid-cutover.
  const second = fixture(
    'cutover-crash',
    service,
    keyless.url,
    ownerHome,
    guestHome
  );
  expect(second.stderr.toString()).toBe('');
  expect(second.signalCode).toBe('SIGKILL');
  const resumed = JSON.parse(
    readFileSync(join(service, 'resume.json'), 'utf8')
  );
  expect(resumed).toMatchObject({
    missingAtResume: 2,
    stored: 2,
    present: 0,
    remaining: 0,
  });
  expect(resumed.report.views[0].versions).toHaveLength(4);

  // 3. A third process finishes the cutover and reads the trusted format.
  const third = fixture('finish', service, keyless.url, ownerHome, guestHome);
  expect(third.stderr.toString()).toBe('');
  expect(third.exitCode).toBe(0);
  const result = JSON.parse(third.stdout.toString());
  expect(result).toMatchObject({
    stateBefore: 'verified',
    headVersionBefore: 1,
    stateAfter: 'cutover',
    versions: [['main', 3]],
    requestedBy: true,
    files: {
      'README.md': 'owner notes\n',
      'src/auth.rs': 'fn login() {}\n',
      'src/main.rs': 'fn main() { println!("hi"); }\n',
    },
    guestFiles: ['src/auth.rs', 'src/main.rs'],
    guestConsent: 'not_owner',
    guestBegin: 'not_owner',
    archiveFiles: 4,
    archiveSame: true,
    reportViews: [['main', 4]],
    seedLeak: false,
    keyLeak: false,
    plaintextLeak: false,
  });
  expect(result.keysChecked).toBeGreaterThan(0);
  expect(result.plaintextWrites).toBe(4);
  expect(result.plaintextReads).toBeGreaterThan(0);

  // The keyless source was never changed: the shipped CLI still pulls,
  // clones and publishes it, and the untouched repository too.
  ok(cli(ownerHome, web, 'pull'));
  ok(cli(guestHome, guestDir, 'clone', 'acme/web', 'after'));
  expect(readFileSync(join(guestDir, 'after', 'src', 'main.rs'), 'utf8')).toBe(
    'fn main() { println!("hi"); }\n'
  );
  ok(cli(ownerHome, root, 'clone', 'acme/api', 'api-after'));
  expect(readFileSync(join(root, 'api-after', 'index.ts'), 'utf8')).toBe(
    'export const api = 1;\n'
  );
  await keyless.stop();
}, 180_000);
