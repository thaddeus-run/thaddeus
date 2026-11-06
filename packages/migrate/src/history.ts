import { type HeadRecord, type Op, OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';

import { byCodeUnit, digest } from './codec';

export const REVISION_DOMAIN = 'thaddeus.migrate.revision.v1';

/** One file in a revision: its path and the BLAKE3 address of its bytes. */
export interface Entry {
  readonly path: string;
  readonly contentId: string;
}

/** The tree one signed head version names, and the revision id of that tree. */
export interface Version {
  readonly version: number;
  // The source head record this version reproduces.
  readonly head: string;
  readonly revision: string;
  readonly entries: readonly Entry[];
}

export function sortEntries(entries: readonly Entry[]): Entry[] {
  return [...entries].sort((a, b) =>
    byCodeUnit(a.path, b.path) !== 0
      ? byCodeUnit(a.path, b.path)
      : byCodeUnit(a.contentId, b.contentId)
  );
}

/**
 * A revision id is the exact content of every path and nothing else, so the
 * owner's client and the trusted service compute the same id for the same
 * files without sharing any state.
 */
export function revisionId(entries: readonly Entry[]): string {
  return digest(
    REVISION_DOMAIN,
    JSON.stringify(sortEntries(entries).map((e) => [e.path, e.contentId]))
  );
}

/**
 * Reconstructs the tree at every version of one owner-signed head chain. It
 * uses the shipped `OpLog.materialize`, so a migrated revision is exactly the
 * file set a keyless client checks out for that version.
 */
export function historyOf(
  ops: readonly Op[],
  chain: readonly HeadRecord[]
): Version[] {
  const log = new OpLog(new MemoryStore());
  for (const op of ops) log.append(op);
  return chain.map((record) => {
    const name = `migrate/${record.view}/${record.version}`;
    log.view(name, record.heads);
    const entries: Entry[] = [];
    for (const [path, { ref }] of log.materialize(name)) {
      if (ref !== null) entries.push({ path, contentId: ref.plaintext_id });
    }
    const sorted = sortEntries(entries);
    return {
      version: record.version,
      head: record.id,
      revision: revisionId(sorted),
      entries: sorted,
    };
  });
}

/** Paths whose content differs between two trees, sorted. */
export function changedPaths(
  before: readonly Entry[],
  after: readonly Entry[]
): string[] {
  const old = new Map(before.map((e) => [e.path, e.contentId]));
  const now = new Map(after.map((e) => [e.path, e.contentId]));
  const changed = new Set<string>();
  for (const [path, id] of now) if (old.get(path) !== id) changed.add(path);
  for (const path of old.keys()) if (!now.has(path)) changed.add(path);
  return [...changed].sort(byCodeUnit);
}
