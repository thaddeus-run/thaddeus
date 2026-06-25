import type { Op } from '@thaddeus.run/log';
import type { Repo } from '@thaddeus.run/platform';
import type { Capability, EncryptedObject } from '@thaddeus.run/store';

// The upload payload for `heads`: every op reachable by walking parents
// (inclusive), in (lamport, id) order, plus the CURRENT ciphertext object and
// served caps for each plaintext_id those ops reference (current — not a
// historical id — because store.get decrypts the current object).
export function bundleFor(
  repo: Repo,
  heads: readonly string[]
): { ops: Op[]; objects: EncryptedObject[]; caps: Capability[] } {
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
  const ops = all
    .filter((o) => seen.has(o.id))
    .sort((x, y) =>
      x.lamport !== y.lamport ? x.lamport - y.lamport : x.id < y.id ? -1 : 1
    );
  const objects: EncryptedObject[] = [];
  const caps: Capability[] = [];
  const pids = new Set<string>();
  for (const op of ops) {
    const pid = op.payload?.plaintext_id;
    if (pid === undefined || pids.has(pid)) {
      continue;
    }
    pids.add(pid);
    const current = repo.store.current(pid);
    if (current !== undefined) {
      objects.push(current);
      caps.push(...repo.store.caps(pid));
    }
  }
  return { ops, objects, caps };
}
