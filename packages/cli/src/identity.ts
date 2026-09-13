import { Identity } from '@thaddeus.run/identity';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Where the self-owned identity seed lives under a config home.
function identityPath(home: string): string {
  return join(home, '.config', 'thaddeus', 'identity.json');
}

export class IdentityMissingError extends Error {
  constructor() {
    super("no identity; run 'thaddeus identity init' first");
  }
}

// Load the identity from its stored 32-byte seed. Throws if absent (the CLI
// distinguishes absence from corruption or an unreadable existing seed).
export function loadIdentity(home: string): Identity {
  let raw: string;
  try {
    raw = readFileSync(identityPath(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new IdentityMissingError();
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (
    value === null ||
    typeof value !== 'object' ||
    !('seed' in value) ||
    typeof value.seed !== 'string' ||
    !('did' in value) ||
    typeof value.did !== 'string'
  ) {
    throw new Error('invalid identity: expected seed and DID');
  }
  const seed = Buffer.from(value.seed, 'base64');
  if (seed.length !== 32 || seed.toString('base64') !== value.seed) {
    throw new Error('invalid identity: expected a base64-encoded 32-byte seed');
  }
  const identity = Identity.fromSeed(new Uint8Array(seed));
  if (identity.did !== value.did)
    throw new Error('invalid identity: DID does not match seed');
  return identity;
}

// Create the identity if absent (or rotate with force). Returns the DID and
// whether a new one was created.
export function initIdentity(
  home: string,
  force: boolean
): { did: string; created: boolean } {
  const path = identityPath(home);
  if (!force) {
    try {
      return { did: loadIdentity(home).did, created: false };
    } catch (err) {
      // Only create a new identity when the file is absent. Any other error
      // (corrupt JSON, permissions) surfaces rather than silently rotating.
      if (!(err instanceof IdentityMissingError)) throw err;
      // fall through to create
    }
  }
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  const identity = Identity.fromSeed(seed);
  mkdirSync(join(home, '.config', 'thaddeus'), {
    recursive: true,
    mode: 0o700,
  });
  try {
    writeFileSync(
      path,
      `${JSON.stringify({ seed: Buffer.from(seed).toString('base64'), did: identity.did }, null, 2)}\n`,
      { mode: 0o600, flag: force ? 'w' : 'wx' }
    );
  } catch (error) {
    if (force || (error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw error;
    return { did: loadIdentity(home).did, created: false };
  }
  chmodSync(path, 0o600);
  return { did: identity.did, created: true };
}
