import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Manifest {
  version?: unknown;
}
interface BunLock {
  workspaces?: Record<string, Manifest>;
}
interface CargoManifest {
  package?: Manifest;
}
interface CargoLock {
  package?: { name?: string; version?: unknown; source?: string }[];
}

/**
 * One place that carries the shared release version. `kind` says how to read
 * and rewrite it, `path` is relative to the repository root.
 */
export type ReleaseVersionSite =
  | { readonly kind: 'manifest'; readonly path: string }
  | {
      readonly kind: 'bun-lock';
      readonly path: 'bun.lock';
      readonly workspace: string;
    }
  | { readonly kind: 'cargo-toml'; readonly path: 'lazythad/Cargo.toml' }
  | { readonly kind: 'cargo-lock'; readonly path: 'lazythad/Cargo.lock' }
  | { readonly kind: 'readme'; readonly path: 'README' };

/** The active README status line; group 1 is the version. */
export const README_STATUS: RegExp = /^STATUS: PRE-ALPHA \(v([^\r\n)]+)\)$/m;

// List every version-bearing site of the shared release. This checker reads
// the list and set-release-version.ts rewrites it, so the two cannot disagree
// about which files belong to a release. packages/* is discovered, so a new
// package joins the release (and its bun.lock entry) automatically.
export function releaseVersionSites(root: string): ReleaseVersionSite[] {
  const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`);
  return [
    ...packages.flatMap((dir): ReleaseVersionSite[] => [
      { kind: 'manifest', path: `${dir}/package.json` },
      { kind: 'bun-lock', path: 'bun.lock', workspace: dir },
    ]),
    { kind: 'manifest', path: 'npm/thaddeus/package.json' },
    { kind: 'manifest', path: 'npm/lazythad/package.json' },
    { kind: 'cargo-toml', path: 'lazythad/Cargo.toml' },
    { kind: 'cargo-lock', path: 'lazythad/Cargo.lock' },
    { kind: 'readme', path: 'README' },
  ];
}

// Check every member of the shared release before a build or publication can drift.
export function checkReleaseVersions(
  root: string,
  expectedTag?: string
): string {
  const errors: string[] = [];
  // Parse each file once, so a malformed file reports one error however many
  // sites it holds.
  const parsed = new Map<string, unknown>();
  const read = <T>(path: string, parse: (text: string) => T): T | undefined => {
    if (parsed.has(path)) return parsed.get(path) as T | undefined;
    let value: T | undefined;
    try {
      value = parse(readFileSync(join(root, path), 'utf8'));
    } catch (error) {
      errors.push(
        `${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    parsed.set(path, value);
    return value;
  };
  const expected = read<Manifest>(
    'packages/cli/package.json',
    JSON.parse
  )?.version;
  if (typeof expected !== 'string' || expected.trim().length === 0) {
    throw new Error(
      [...errors, 'packages/cli/package.json: missing version'].join('\n')
    );
  }
  const compare = (label: string, actual: unknown): void => {
    if (actual !== expected)
      errors.push(
        `${label}: expected ${expected}, got ${JSON.stringify(actual)}`
      );
  };
  for (const site of releaseVersionSites(root)) {
    switch (site.kind) {
      case 'manifest':
        compare(site.path, read<Manifest>(site.path, JSON.parse)?.version);
        break;
      case 'bun-lock':
        compare(
          `bun.lock workspaces[${site.workspace}]`,
          read(site.path, (text) => Bun.JSONC.parse(text) as BunLock)
            ?.workspaces?.[site.workspace]?.version
        );
        break;
      case 'cargo-toml':
        compare(
          `${site.path} package.version`,
          read<CargoManifest>(site.path, Bun.TOML.parse)?.package?.version
        );
        break;
      case 'cargo-lock': {
        const lock = read<CargoLock>(site.path, Bun.TOML.parse);
        const local = Array.isArray(lock?.package)
          ? lock.package.filter(
              (entry) => entry.name === 'lazythad' && entry.source === undefined
            )
          : [];
        if (local.length !== 1) {
          errors.push(
            `${site.path}: expected one local lazythad, got ${local.length}`
          );
        } else {
          compare(`${site.path} local lazythad`, local[0]?.version);
        }
        break;
      }
      case 'readme':
        compare(
          'README active STATUS',
          read(site.path, (text) => text)?.match(README_STATUS)?.[1]
        );
        break;
    }
  }
  if (expectedTag !== undefined && expectedTag !== `v${expected}`) {
    errors.push(
      `release tag ${JSON.stringify(expectedTag)} does not match v${expected}`
    );
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return expected;
}

if (import.meta.main) {
  try {
    console.log(
      checkReleaseVersions(
        resolve(import.meta.dir, '../../..'),
        process.env.THADDEUS_RELEASE_TAG
      )
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
