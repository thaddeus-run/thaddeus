import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { ReleaseChannel } from './config';

// The GitHub repository whose releases carry the CLI binaries, as in install.sh.
const REPO = 'thaddeus-run/thaddeus';
export const RELEASES_API: string = `https://api.github.com/repos/${REPO}/releases`;
export const RELEASES_DOWNLOAD: string = `https://github.com/${REPO}/releases/download`;

/** Everything `thaddeus update` reads from the outside world, injectable for tests. */
export interface UpdateDeps {
  fetchImpl: (req: Request) => Promise<Response>;
  execPath: string;
  platform: NodeJS.Platform;
  arch: string;
  version: string;
  out: (line: string) => void;
}

/** How this CLI was installed, which decides whether it can replace itself. */
export type InstallKind = 'binary' | 'npm' | 'source';

// The channel a build came from. Nightly versions look like
// `0.1.12-nightly.20261018.42`; every other version is a release.
export function channelOf(version: string): ReleaseChannel {
  return version.includes('-nightly.') ? 'nightly' : 'release';
}

// The `<os>-<arch>` suffix and file extension of release assets, matching
// install.sh and the npm launcher. Null on a platform no release is built for.
export function assetTarget(
  platform: NodeJS.Platform,
  arch: string
): { suffix: string; ext: string } | null {
  const os =
    platform === 'darwin'
      ? 'darwin'
      : platform === 'linux'
        ? 'linux'
        : platform === 'win32'
          ? 'windows'
          : null;
  if (os === null || (arch !== 'x64' && arch !== 'arm64')) return null;
  return { suffix: `${os}-${arch}`, ext: os === 'windows' ? '.exe' : '' };
}

// Classify the running executable by its resolved path. Only a standalone
// binary (from install.sh, or copied by hand) may replace itself: the npm
// launcher's binary lives in node_modules and the next npm install restores it,
// and a source run executes bun or node, which must never be overwritten.
export function installKind(execPath: string): InstallKind {
  // Split on both separators so a Windows path classifies the same on any host.
  const parts = execPath.split(/[\\/]/);
  const name = (parts.at(-1) ?? '').replace(/\.exe$/i, '');
  if (name !== 'thaddeus' && name !== 'thad') return 'source';
  return parts.includes('node_modules') ? 'npm' : 'binary';
}

// Read `tag_name` from one GitHub release object, if it has one.
function tagName(release: unknown): string | undefined {
  if (typeof release !== 'object' || release === null) return undefined;
  const tag = (release as { tag_name?: unknown }).tag_name;
  return typeof tag === 'string' ? tag : undefined;
}

// GET a URL with the headers GitHub expects (it rejects requests without a
// User-Agent). A 404 resolves to null so callers can treat it as "absent".
async function get(deps: UpdateDeps, url: string): Promise<Response | null> {
  const res = await deps.fetchImpl(
    new Request(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `thaddeus-cli/${deps.version}`,
      },
    })
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${url}`);
  return res;
}

// The newest release tag on a channel. Nightlies are prereleases, so
// releases/latest never returns one; like install.sh, take the first
// `-nightly.` tag from the newest-first release list instead.
export async function latestTag(
  deps: UpdateDeps,
  channel: ReleaseChannel
): Promise<string> {
  if (channel === 'release') {
    const res = await get(deps, `${RELEASES_API}/latest`);
    const tag = res === null ? undefined : tagName(await res.json());
    if (tag === undefined) throw new Error('could not find the latest release');
    return tag;
  }
  const res = await get(deps, `${RELEASES_API}?per_page=30`);
  const list: unknown = res === null ? [] : await res.json();
  const tag = Array.isArray(list)
    ? list.map(tagName).find((t) => t?.includes('-nightly.') === true)
    : undefined;
  if (tag === undefined) {
    throw new Error('no nightly release among the 30 newest releases');
  }
  return tag;
}

// The SHA-256 a SHA256SUMS manifest lists for `asset`, or null when the
// manifest has no line for it. Accepts the `<hash>  name` and `<hash> *name` forms.
function expectedHash(sums: string, asset: string): string | null {
  for (const line of sums.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m !== null && m[2] === asset) return m[1].toLowerCase();
  }
  return null;
}

// Write `bytes` beside `dest`, then rename over it, so an interrupted update
// never leaves a half-written binary. The temp name is unique to this run, so
// two updates of one install never delete or install each other's download.
// Windows refuses to overwrite a running .exe but lets it be renamed, so there
// the old file moves to `<dest>.old` first, and back again if the new file
// can't take its place; the next update removes `.old`. `rename` is swappable
// so tests can make the final rename fail.
export function replaceFile(
  dest: string,
  bytes: Uint8Array,
  windows: boolean,
  rename: (from: string, to: string) => void = renameSync
): void {
  const tmp = `${dest}.update-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o755 });
    if (!windows) {
      rename(tmp, dest);
      return;
    }
    const old = `${dest}.old`;
    try {
      rmSync(old, { force: true });
    } catch {
      // A process started before the last update may still run from it.
    }
    const moved = existsSync(dest);
    if (moved) rename(dest, old);
    try {
      rename(tmp, dest);
    } catch (error) {
      if (moved) rename(old, dest);
      throw error;
    }
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** What `thaddeus update` should do, after flags and config are resolved. */
export interface UpdateOptions {
  channel: ReleaseChannel;
  check: boolean;
}

// Bring this binary to the newest build on `channel`, along with a lazythad
// installed beside it. Any version other than the installed one is installed,
// even an older one, so switching from nightly back to release takes effect.
// Every binary is downloaded and checked against SHA256SUMS before any file is
// replaced. Returns the process exit code.
export async function runUpdate(
  deps: UpdateDeps,
  opts: UpdateOptions
): Promise<number> {
  const { out } = deps;
  const current = `v${deps.version}`;
  const tag = await latestTag(deps, opts.channel);
  out(`channel ${opts.channel}: installed ${current}, newest ${tag}`);
  if (tag === current) {
    out('already up to date');
    return 0;
  }
  if (opts.check) {
    out(`run 'thaddeus update' to install ${tag}`);
    return 0;
  }

  const execPath = realpathSync(deps.execPath);
  const kind = installKind(execPath);
  if (kind === 'npm') {
    const distTag = opts.channel === 'nightly' ? 'nightly' : 'latest';
    out('this thaddeus was installed with npm; update it with:');
    out(
      `  npm install -g @thaddeus.run/cli@${distTag} @thaddeus.run/lazythad@${distTag}`
    );
    return 1;
  }
  if (kind === 'source') {
    out(
      `this thaddeus runs from source (${execPath}), not an installed binary; nothing was replaced`
    );
    return 1;
  }
  const target = assetTarget(deps.platform, deps.arch);
  if (target === null) {
    throw new Error(`no release binaries for ${deps.platform}-${deps.arch}`);
  }

  const base = `${RELEASES_DOWNLOAD}/${tag}`;
  const sumsRes = await get(deps, `${base}/SHA256SUMS`);
  if (sumsRes === null) throw new Error(`${tag} has no SHA256SUMS`);
  const sums = await sumsRes.text();
  const dir = dirname(execPath);
  // The CLI's paths in this directory. On Unix `thad` is a symlink to
  // `thaddeus` and resolves to the same file; on Windows install.sh copies it,
  // so both copies are replaced.
  const cliPaths = [
    ...new Set(
      [
        execPath,
        join(dir, `thaddeus${target.ext}`),
        join(dir, `thad${target.ext}`),
      ]
        .filter((p) => existsSync(p))
        .map((p) => realpathSync(p))
    ),
  ];
  const lazythad = join(dir, `lazythad${target.ext}`);
  const tools = [
    { tool: 'thaddeus', dests: cliPaths },
    ...(existsSync(lazythad) ? [{ tool: 'lazythad', dests: [lazythad] }] : []),
  ];

  const verified: { dests: string[]; bytes: Uint8Array }[] = [];
  for (const { tool, dests } of tools) {
    const asset = `${tool}-${target.suffix}${target.ext}`;
    const res = await get(deps, `${base}/${asset}`);
    if (res === null) {
      if (tool === 'thaddeus') throw new Error(`${tag} has no ${asset}`);
      out(`${tag} has no ${asset}; lazythad was left as it is`);
      continue;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const expected = expectedHash(sums, asset);
    if (expected === null)
      throw new Error(`no checksum for ${asset} in SHA256SUMS`);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) {
      throw new Error(
        `checksum mismatch for ${asset} (expected ${expected}, got ${actual}); nothing was replaced`
      );
    }
    verified.push({ dests, bytes });
  }
  for (const { dests, bytes } of verified) {
    for (const dest of dests) replaceFile(dest, bytes, target.ext === '.exe');
  }
  out(`updated ${current} → ${tag}`);
  return 0;
}
