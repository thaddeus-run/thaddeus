import type { Identity, PublicIdentity } from '@thaddeus.run/identity';
import type { Repo } from '@thaddeus.run/platform';
import { AccessDenied } from '@thaddeus.run/store';

// The plaintext_ids referenced by every op reachable from `heads` — the same
// walk `bundleFor` performs, so a reshare covers exactly the objects a push
// will upload.
export function reachablePids(
  repo: Repo,
  heads: readonly string[]
): Set<string> {
  const all = repo.log.ops();
  const byId = new Map(all.map((o) => [o.id, o]));
  const seen = new Set<string>();
  const stack = [...heads];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const op = byId.get(id);
    if (op !== undefined) {
      stack.push(...op.parents);
    }
  }
  const pids = new Set<string>();
  for (const op of all) {
    const pid = op.payload?.plaintext_id;
    if (seen.has(op.id) && pid !== undefined) {
      pids.add(pid);
    }
  }
  return pids;
}

// Re-wrap the content key of every readable object in `pids` for each member
// that does not already hold a capability for it, so a collaborator can DECRYPT
// what they are authorized to write. `store.put` seals a new object only to its
// author, so without this the owner cannot read a delegate's push (and a freshly
// granted delegate cannot read the repo at all).
//
// Idempotent: a member already holding a cap is skipped (store.grant appends
// without de-duplicating). Fail-soft: an object `by` cannot decrypt is skipped
// rather than fatal — a partial-capability member reshares what it can.
// Returns how many capabilities were issued.
export async function reshareObjects(
  repo: Repo,
  pids: Iterable<string>,
  members: readonly PublicIdentity[],
  by: Identity
): Promise<number> {
  let granted = 0;
  for (const pid of pids) {
    const current = repo.store.current(pid);
    if (current === undefined) {
      continue;
    }
    const held = new Set(repo.store.caps(pid).map((c) => c.grantee));
    const ref = { id: current.id, plaintext_id: current.plaintext_id };
    for (const member of members) {
      if (member.did === by.did || held.has(member.did)) {
        continue;
      }
      try {
        await repo.store.grant(ref, member, by);
        granted += 1;
      } catch (err) {
        // `by` holds no capability for this object, so there is no content key
        // to re-wrap. Nothing to share here for ANY member — move to the next.
        if (err instanceof AccessDenied) {
          break;
        }
        throw err;
      }
    }
  }
  return granted;
}

export interface RevokeObjectsResult {
  rotated: number;
  skipped: string[];
}

// Rotate every readable object in `pids`, dropping `revoked` from the served and
// pending capability sets. This is the local cryptographic half of repo revoke;
// the server later receives the rotated ciphertexts/caps in the signed revoke
// request and stops serving the old keys to fresh clones.
export async function revokeObjects(
  repo: Repo,
  pids: Iterable<string>,
  revoked: PublicIdentity,
  by: Identity
): Promise<RevokeObjectsResult> {
  let rotated = 0;
  const skipped: string[] = [];
  for (const pid of pids) {
    const current = repo.store.current(pid);
    if (current === undefined) {
      continue;
    }
    try {
      await repo.store.revoke(
        { id: current.id, plaintext_id: current.plaintext_id },
        revoked,
        by
      );
      rotated += 1;
    } catch (err) {
      if (err instanceof AccessDenied) {
        skipped.push(pid);
        continue;
      }
      throw err;
    }
  }
  skipped.sort();
  return { rotated, skipped };
}
