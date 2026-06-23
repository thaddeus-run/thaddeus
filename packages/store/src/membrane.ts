import { Identity } from '@thaddeus.run/identity';

// A fixed, PUBLISHED seed. The secret key derived from it is world-known on
// purpose: a capability sealed to this identity is readable by anyone, which is
// how "becomes world-readable at T" is expressed. Spike-only — a real protocol
// would post the released key to an open mirror, not hardcode a seed.
//
// The identity is derived from a private copy; PUBLIC_SEED is exported as a
// fresh copy so callers mutating the exported array cannot change the
// well-known public DID.
const SEED: Uint8Array = new Uint8Array(32).fill(7);
export const PUBLIC_SEED: Uint8Array = Uint8Array.from(SEED);

let cached: Identity | undefined;

// Memoized so callers share one instance (and we build it only after ready()).
export function publicIdentity(): Identity {
  cached ??= Identity.fromSeed(SEED);
  return cached;
}

export function publicDid(): string {
  return publicIdentity().did;
}
