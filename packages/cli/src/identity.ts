import { Identity } from '@thaddeus.run/identity';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Where the self-owned identity seed lives under a config home.
function identityPath(home: string): string {
  return join(home, '.config', 'thaddeus', 'identity.json');
}

// Load the identity from its stored 32-byte seed. Throws if absent (the CLI
// turns that into a "run 'thaddeus init'" message).
export function loadIdentity(home: string): Identity {
  let raw: string;
  try {
    raw = readFileSync(identityPath(home), 'utf8');
  } catch {
    throw new Error("no identity — run 'thaddeus init' first");
  }
  const { seed } = JSON.parse(raw) as { seed: string; did: string };
  return Identity.fromSeed(new Uint8Array(Buffer.from(seed, 'base64')));
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
      const existing = JSON.parse(readFileSync(path, 'utf8')) as {
        did: string;
      };
      return { did: existing.did, created: false };
    } catch (err) {
      // Only create a new identity when the file is absent. Any other error
      // (corrupt JSON, permissions) surfaces rather than silently rotating.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
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
  writeFileSync(
    path,
    `${JSON.stringify({ seed: Buffer.from(seed).toString('base64'), did: identity.did }, null, 2)}\n`,
    { mode: 0o600 }
  );
  chmodSync(path, 0o600);
  return { did: identity.did, created: true };
}
