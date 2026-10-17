// Rewrite the shared release version in every file check-release-version.ts
// validates. The release workflow runs this in a fresh checkout before a
// nightly build, so `root:version-check`, the embedded CLI version and the TUI's
// `--version` all report the nightly version without a commit.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  checkReleaseVersions,
  README_STATUS,
  type ReleaseVersionSite,
  releaseVersionSites,
} from './check-release-version';

const RELEASE_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// Escape `text` for use as a literal inside a RegExp source.
const literal = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Set `version = "..."` in each TOML table whose header line is exactly
// `header` and whose body lines pass `select`. Only the quoted value changes;
// every other byte, including other tables with the same version, stays put.
// Returns the new text and the number of tables rewritten.
function setTomlVersion(
  text: string,
  header: string,
  select: (body: string[]) => boolean,
  version: string
): { text: string; count: number } {
  const lines = text.split('\n');
  let count = 0;
  for (let start = 0; start < lines.length; start++) {
    if (lines[start]?.trim() !== header) continue;
    let end = start + 1;
    while (end < lines.length && !lines[end]?.startsWith('[')) end++;
    if (!select(lines.slice(start + 1, end))) continue;
    for (let at = start + 1; at < end; at++) {
      const line = lines[at] ?? '';
      if (!/^version\s*=\s*"/.test(line)) continue;
      lines[at] = line.replace(
        /^(version\s*=\s*")[^"]*(")/,
        (_, open: string, close: string) => `${open}${version}${close}`
      );
      count++;
      break;
    }
  }
  return { text: lines.join('\n'), count };
}

// Return `text` with this site's version set to `version`, or throw if the
// site is missing, so a partial rewrite never reaches disk.
function rewrite(
  site: ReleaseVersionSite,
  text: string,
  version: string
): string {
  switch (site.kind) {
    case 'manifest': {
      // Package manifests use JSON.stringify's two-space layout, so a round
      // trip only changes the version.
      const manifest = JSON.parse(text) as Record<string, unknown>;
      if (typeof manifest.version !== 'string') {
        throw new Error(`${site.path}: missing version`);
      }
      manifest.version = version;
      return `${JSON.stringify(manifest, null, 2)}\n`;
    }
    case 'bun-lock': {
      // bun.lock is JSONC with trailing commas, so edit the text: the first
      // "version" inside this workspace's object, before any nested object.
      const entry = new RegExp(
        `(${literal(JSON.stringify(site.workspace))}\\s*:\\s*\\{[^{}]*?"version"\\s*:\\s*")[^"]*(")`
      );
      if (!entry.test(text)) {
        throw new Error(`bun.lock: no version for ${site.workspace}`);
      }
      return text.replace(
        entry,
        (_, open: string, close: string) => `${open}${version}${close}`
      );
    }
    case 'cargo-toml': {
      const result = setTomlVersion(text, '[package]', () => true, version);
      if (result.count !== 1) {
        throw new Error(`${site.path}: expected one [package] version`);
      }
      return result.text;
    }
    case 'cargo-lock': {
      // The workspace's own crate is the lazythad record without a `source`;
      // a registry crate that happens to share the name or version stays put.
      const result = setTomlVersion(
        text,
        '[[package]]',
        (body) =>
          body.some((line) => /^name\s*=\s*"lazythad"\s*$/.test(line)) &&
          !body.some((line) => /^source\s*=/.test(line)),
        version
      );
      if (result.count !== 1) {
        throw new Error(
          `${site.path}: expected one local lazythad, got ${result.count}`
        );
      }
      return result.text;
    }
    case 'readme': {
      if (!README_STATUS.test(text)) {
        throw new Error('README: no active STATUS line');
      }
      return text.replace(
        README_STATUS,
        () => `STATUS: PRE-ALPHA (v${version})`
      );
    }
  }
}

/**
 * Set the shared release version to `version` in every version-bearing file
 * under `root` and return the paths that changed. Every file is rewritten in
 * memory first, so a missing site leaves the tree untouched; afterwards the
 * release-version checker must agree.
 */
export async function setReleaseVersion(
  root: string,
  version: string
): Promise<string[]> {
  if (!RELEASE_VERSION.test(version)) {
    throw new Error(`invalid release version ${JSON.stringify(version)}`);
  }
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  for (const site of releaseVersionSites(root)) {
    if (!before.has(site.path)) {
      const text = await readFile(join(root, site.path), 'utf8');
      before.set(site.path, text);
      after.set(site.path, text);
    }
    after.set(site.path, rewrite(site, after.get(site.path) ?? '', version));
  }
  const changed: string[] = [];
  for (const [path, text] of after) {
    if (text === before.get(path)) continue;
    await writeFile(join(root, path), text);
    changed.push(path);
  }
  const checked = checkReleaseVersions(root, `v${version}`);
  if (checked !== version) {
    throw new Error(`release version is ${checked} after setting ${version}`);
  }
  return changed;
}

if (import.meta.main) {
  try {
    const version = process.argv[2];
    if (version === undefined || process.argv.length !== 3) {
      throw new Error('usage: set-release-version.ts <version>');
    }
    const changed = await setReleaseVersion(
      resolve(import.meta.dir, '../../..'),
      version
    );
    for (const path of changed) console.log(path);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
