import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadCliConfig, saveCliConfig } from '../src/config';
import { run } from '../src/run';
import {
  assetTarget,
  channelOf,
  installKind,
  RELEASES_API,
  RELEASES_DOWNLOAD,
  replaceFile,
} from '../src/update';
import { VERSION } from '../src/version';

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-update-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const host = assetTarget(process.platform, process.arch);
if (host === null) throw new Error('no release target for this test host');
const { suffix, ext } = host;

interface FakeRelease {
  tag: string;
  prerelease: boolean;
  assets: Record<string, string>;
}

// A release with the given binaries and a SHA256SUMS that lists each of them.
function release(
  tag: string,
  files: Record<string, string>,
  prerelease = false
): FakeRelease {
  const sums = Object.entries(files)
    .map(([name, body]) => {
      const hash = createHash('sha256').update(body).digest('hex');
      return `${hash}  ${name}`;
    })
    .join('\n');
  return { tag, prerelease, assets: { ...files, SHA256SUMS: sums } };
}

// A fake of the GitHub endpoints update reads: releases/latest, the
// newest-first release list, and asset downloads. Records every URL requested.
function fakeGitHub(releases: FakeRelease[]) {
  const requested: string[] = [];
  const fetchImpl = async (req: Request): Promise<Response> => {
    requested.push(req.url);
    if (req.url === `${RELEASES_API}/latest`) {
      const latest = releases.find((r) => !r.prerelease);
      return latest === undefined
        ? new Response('not found', { status: 404 })
        : Response.json({ tag_name: latest.tag });
    }
    if (req.url === `${RELEASES_API}?per_page=30`) {
      return Response.json(releases.map((r) => ({ tag_name: r.tag })));
    }
    const prefix = `${RELEASES_DOWNLOAD}/`;
    const [tag, asset] = req.url.slice(prefix.length).split('/');
    const body = req.url.startsWith(prefix)
      ? releases.find((r) => r.tag === tag)?.assets[asset]
      : undefined;
    return body === undefined
      ? new Response('not found', { status: 404 })
      : new Response(body);
  };
  return { fetchImpl, requested };
}

// A fresh home and an install dir holding an "old" thaddeus binary (with a
// `thad` alias) and lazythad, laid out the way install.sh leaves them.
function harness(releases: FakeRelease[]) {
  const root = mkdtempSync(join(tmp, 'case-'));
  const home = join(root, 'home');
  const bin = join(root, '.thaddeus', 'bin');
  mkdirSync(home);
  mkdirSync(bin, { recursive: true });
  const cli = join(bin, `thaddeus${ext}`);
  const tui = join(bin, `lazythad${ext}`);
  writeFileSync(cli, 'old cli');
  writeFileSync(tui, 'old tui');
  if (ext === '') symlinkSync(`thaddeus${ext}`, join(bin, 'thad'));
  const out: string[] = [];
  const github = fakeGitHub(releases);
  const env = {
    cwd: home,
    home,
    execPath: cli,
    fetchImpl: github.fetchImpl,
    out: (l: string) => out.push(l),
  };
  return { home, bin, cli, tui, out, env, requested: github.requested };
}

const NEXT_RELEASE = release('v9.0.0-alpha', {
  [`thaddeus-${suffix}${ext}`]: 'release cli',
  [`lazythad-${suffix}${ext}`]: 'release tui',
});
const NEXT_NIGHTLY = release(
  'v9.0.1-nightly.20261018.7',
  {
    [`thaddeus-${suffix}${ext}`]: 'nightly cli',
    [`lazythad-${suffix}${ext}`]: 'nightly tui',
  },
  true
);

describe('thaddeus update', () => {
  test('installs the newest release over thaddeus and lazythad', async () => {
    const h = harness([NEXT_NIGHTLY, NEXT_RELEASE]);
    expect(await run(['update', '--channel', 'release'], h.env)).toBe(0);
    expect(readFileSync(h.cli, 'utf8')).toBe('release cli');
    expect(readFileSync(h.tui, 'utf8')).toBe('release tui');
    if (ext === '') {
      expect(readFileSync(join(h.bin, 'thad'), 'utf8')).toBe('release cli');
    }
    expect(h.out.at(-1)).toBe(`updated v${VERSION} → v9.0.0-alpha`);
  });

  test('--channel nightly is saved and picks the newest nightly', async () => {
    const h = harness([NEXT_NIGHTLY, NEXT_RELEASE]);
    saveCliConfig(h.home, { defaultServer: 'https://example.test' });
    expect(await run(['update', '--channel', 'nightly'], h.env)).toBe(0);
    expect(readFileSync(h.cli, 'utf8')).toBe('nightly cli');
    expect(loadCliConfig(h.home)).toEqual({
      defaultServer: 'https://example.test',
      channel: 'nightly',
    });
    // A bare update now follows the saved channel.
    h.out.length = 0;
    expect(await run(['update', '--check'], h.env)).toBe(0);
    expect(h.out[0]).toContain('channel nightly');
  });

  test('a checksum mismatch replaces nothing', async () => {
    const bad = release('v9.0.0-alpha', {
      [`thaddeus-${suffix}${ext}`]: 'release cli',
      [`lazythad-${suffix}${ext}`]: 'release tui',
    });
    bad.assets[`lazythad-${suffix}${ext}`] = 'tampered tui';
    const h = harness([bad]);
    expect(await run(['update', '--channel', 'release'], h.env)).toBe(1);
    expect(h.out.at(-1)).toContain('error: checksum mismatch');
    expect(readFileSync(h.cli, 'utf8')).toBe('old cli');
    expect(readFileSync(h.tui, 'utf8')).toBe('old tui');
  });

  test('the installed version downloads nothing', async () => {
    const h = harness([release(`v${VERSION}`, {})]);
    expect(await run(['update', '--channel', 'release'], h.env)).toBe(0);
    expect(h.out.at(-1)).toBe('already up to date');
    expect(h.requested.some((u) => u.startsWith(RELEASES_DOWNLOAD))).toBe(
      false
    );
  });

  test('--check reports without installing', async () => {
    const h = harness([NEXT_RELEASE]);
    expect(
      await run(['update', '--channel', 'release', '--check'], h.env)
    ).toBe(0);
    expect(readFileSync(h.cli, 'utf8')).toBe('old cli');
    expect(h.out.at(-1)).toBe("run 'thaddeus update' to install v9.0.0-alpha");
  });

  test('an npm install prints the npm command instead', async () => {
    const h = harness([NEXT_NIGHTLY, NEXT_RELEASE]);
    const npmBin = join(h.home, 'node_modules', '@thaddeus.run', 'cli', 'bin');
    mkdirSync(npmBin, { recursive: true });
    const npmCli = join(npmBin, `thaddeus${ext}`);
    writeFileSync(npmCli, 'npm cli');
    const env = { ...h.env, execPath: npmCli };
    expect(await run(['update', '--channel', 'nightly', '--check'], env)).toBe(
      0
    );
    expect(await run(['update'], env)).toBe(1);
    expect(h.out).toContain(
      '  npm install -g @thaddeus.run/cli@nightly @thaddeus.run/lazythad@nightly'
    );
    expect(readFileSync(npmCli, 'utf8')).toBe('npm cli');
  });

  test('rejects an unknown channel', async () => {
    const h = harness([NEXT_RELEASE]);
    expect(await run(['update', '--channel', 'beta'], h.env)).toBe(2);
    expect(loadCliConfig(h.home).channel).toBeUndefined();
  });
});

describe('update helpers', () => {
  test('channelOf reads the channel from the version', () => {
    expect(channelOf('0.1.12-nightly.20261018.42')).toBe('nightly');
    expect(channelOf('0.1.11-alpha')).toBe('release');
  });

  test('installKind tells binary, npm and source runs apart', () => {
    expect(installKind('/home/u/.thaddeus/bin/thaddeus')).toBe('binary');
    expect(installKind('C:\\Users\\u\\.thaddeus\\bin\\thad.exe')).toBe(
      'binary'
    );
    expect(
      installKind('/usr/lib/node_modules/@thaddeus.run/cli/bin/thaddeus')
    ).toBe('npm');
    expect(installKind('/home/u/.proto/tools/bun/1.3.14/bin/bun')).toBe(
      'source'
    );
  });
});

describe('replaceFile', () => {
  test('a failed rename leaves no temp file behind', () => {
    const dir = mkdtempSync(join(tmp, 'replace-'));
    // A non-empty directory at the target makes the final rename fail.
    const dest = join(dir, 'thaddeus');
    mkdirSync(dest);
    writeFileSync(join(dest, 'keep'), '');
    expect(() =>
      replaceFile(dest, new TextEncoder().encode('new'), false)
    ).toThrow();
    expect(readdirSync(dir)).toEqual(['thaddeus']);
  });

  test('on Windows, a failed final rename puts the old binary back', () => {
    const dir = mkdtempSync(join(tmp, 'replace-'));
    const dest = join(dir, 'thaddeus.exe');
    writeFileSync(dest, 'old');
    // Let the move to .old through, then fail the temp file's rename.
    const rename = (from: string, to: string): void => {
      if (from.includes('.update-')) throw new Error('EBUSY');
      renameSync(from, to);
    };
    expect(() =>
      replaceFile(dest, new TextEncoder().encode('new'), true, rename)
    ).toThrow('EBUSY');
    expect(readFileSync(dest, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['thaddeus.exe']);
  });

  test('on Windows, a successful swap keeps the old binary as .old', () => {
    const dir = mkdtempSync(join(tmp, 'replace-'));
    const dest = join(dir, 'thaddeus.exe');
    writeFileSync(dest, 'old');
    replaceFile(dest, new TextEncoder().encode('new'), true);
    expect(readFileSync(dest, 'utf8')).toBe('new');
    expect(readFileSync(`${dest}.old`, 'utf8')).toBe('old');
    expect(readdirSync(dir).sort()).toEqual([
      'thaddeus.exe',
      'thaddeus.exe.old',
    ]);
  });
});
