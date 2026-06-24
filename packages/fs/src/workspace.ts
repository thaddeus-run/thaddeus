import type { Identity } from '@thaddeus.run/identity';
import type { OpLog } from '@thaddeus.run/log';
import { AccessDenied, type Ref, type Store } from '@thaddeus.run/store';

// A change staged in the copy-on-write overlay, not yet committed to the log.
type Staged =
  | { readonly kind: 'write'; readonly bytes: Uint8Array }
  | { readonly kind: 'tombstone' };

// What `status()` reports for a path with an uncommitted edit.
export interface Change {
  readonly path: string;
  readonly change: 'write' | 'rm';
}

// A grep hit: the path, the 1-based line number, and the matching line text.
export interface Match {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

// Process-local counter for unique private view names. There is no real
// filesystem and no global registry, so a monotonic integer suffices.
let workspaceSeq = 0;

// A copy-on-write working copy over a P03 op-log. Reads project a private,
// pinned forked view; edits stage in an in-memory overlay; commit folds the
// overlay into signed ops on that view. Spike — in-memory, single process, not
// durable, not concurrency-safe.
export class Workspace {
  readonly #log: OpLog;
  readonly #store: Store;
  readonly #reader: Identity;
  readonly #view: string;
  readonly #overlay: Map<string, Staged>;

  private constructor(
    log: OpLog,
    store: Store,
    reader: Identity,
    view: string,
    overlay: Map<string, Staged>
  ) {
    this.#log = log;
    this.#store = store;
    this.#reader = reader;
    this.#view = view;
    this.#overlay = overlay;
  }

  // Open a workspace over `source`. Forks a private zero-copy view at source's
  // current heads; because OpLog.append never moves a view, that base is pinned
  // against concurrent peers. `reader` bounds what reads/grep can decrypt.
  static open(
    log: OpLog,
    store: Store,
    opts: { source: string; reader: Identity; name?: string }
  ): Workspace {
    const view = opts.name ?? `ws/${opts.source}/${workspaceSeq++}`;
    log.fork(view, opts.source);
    return new Workspace(log, store, opts.reader, view, new Map());
  }

  // Decrypted bytes at `path`, or null if absent, staged-removed, or the reader
  // cannot decrypt it. Resolution order: overlay tombstone → overlay write →
  // base (materialize + store.get). Never throws on a denied read.
  async read(path: string): Promise<Uint8Array | null> {
    const staged = this.#overlay.get(path);
    if (staged !== undefined) {
      return staged.kind === 'write' ? staged.bytes : null;
    }
    const entry = this.#log.materialize(this.#view, this.#reader).get(path);
    if (entry === undefined || entry.ref === null) {
      return null;
    }
    return this.#read(entry.ref);
  }

  // store.get wrapped to fail soft: a denied/undecryptable object reads as null.
  async #read(ref: Ref): Promise<Uint8Array | null> {
    try {
      return await this.#store.get(ref, this.#reader);
    } catch (e) {
      if (e instanceof AccessDenied) {
        return null;
      }
      throw e;
    }
  }

  // Paths visible in the workspace: base paths ∪ staged writes, minus staged
  // tombstones, under an optional prefix, in sorted order. Not decryption-bounded
  // — a path whose content the reader cannot decrypt still appears (P03 keeps
  // paths cleartext); read() of it returns null and grep() skips it.
  async list(prefix = ''): Promise<readonly string[]> {
    const paths = new Set<string>(
      this.#log.materialize(this.#view, this.#reader).keys()
    );
    for (const [path, staged] of this.#overlay) {
      if (staged.kind === 'write') {
        paths.add(path);
      } else {
        paths.delete(path);
      }
    }
    return [...paths].filter((p) => p.startsWith(prefix)).sort();
  }

  // Stage a write into the overlay. Synchronous, isolated, unsigned.
  write(path: string, bytes: Uint8Array): void {
    this.#overlay.set(path, { kind: 'write', bytes });
  }

  // Stage a tombstone into the overlay. read/list/grep treat the path as absent.
  rm(path: string): void {
    this.#overlay.set(path, { kind: 'tombstone' });
  }

  // Uncommitted edits vs the base, in deterministic path order.
  status(): readonly Change[] {
    return [...this.#overlay.entries()]
      .map(
        ([path, s]): Change => ({
          path,
          change: s.kind === 'write' ? 'write' : 'rm',
        })
      )
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}
