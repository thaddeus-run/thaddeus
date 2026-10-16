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

// Check every member of the shared release before a build or publication can drift.
export function checkReleaseVersions(
  root: string,
  expectedTag?: string
): string {
  const errors: string[] = [];
  const read = <T>(path: string, parse: (text: string) => T): T | undefined => {
    try {
      return parse(readFileSync(join(root, path), 'utf8'));
    } catch (error) {
      errors.push(
        `${path}: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
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
  const compare = (path: string, actual: unknown): void => {
    if (actual !== expected)
      errors.push(
        `${path}: expected ${expected}, got ${JSON.stringify(actual)}`
      );
  };
  const lock = read('bun.lock', (text) => Bun.JSONC.parse(text) as BunLock);
  for (const entry of readdirSync(join(root, 'packages'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const path = `packages/${entry.name}/package.json`;
    compare(path, read<Manifest>(path, JSON.parse)?.version);
    compare(
      `bun.lock workspaces[packages/${entry.name}]`,
      lock?.workspaces?.[`packages/${entry.name}`]?.version
    );
  }
  for (const name of ['thaddeus', 'lazythad']) {
    const path = `npm/${name}/package.json`;
    compare(path, read<Manifest>(path, JSON.parse)?.version);
  }
  const cargo = read<CargoManifest>('lazythad/Cargo.toml', Bun.TOML.parse);
  compare('lazythad/Cargo.toml package.version', cargo?.package?.version);
  const cargoLock = read<CargoLock>('lazythad/Cargo.lock', Bun.TOML.parse);
  const local = Array.isArray(cargoLock?.package)
    ? cargoLock.package.filter(
        (entry) => entry.name === 'lazythad' && entry.source === undefined
      )
    : [];
  if (local.length !== 1) {
    errors.push(
      `lazythad/Cargo.lock: expected one local lazythad, got ${local.length}`
    );
  } else {
    compare('lazythad/Cargo.lock local lazythad', local[0]?.version);
  }
  const readme = read('README', (text) => text);
  compare(
    'README active STATUS',
    readme?.match(/^STATUS: PRE-ALPHA \(v([^\r\n)]+)\)$/m)?.[1]
  );
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
