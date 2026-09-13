import { createHash, randomUUID } from 'node:crypto';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { type PreparedIgnore, prepareIgnore } from './ignore';
import type { Config } from './workcopy';

export interface InitStateInput {
  root: string;
  home: string;
  repo: string;
  server: string;
  owner: string;
}
export type InitPhase = 'prepared' | 'create-attempted' | 'remote-created';
interface Evidence {
  dev: number;
  ino: number;
  digest: string;
}
interface Journal extends InitStateInput {
  version: 1;
  attempt: string;
  phase: InitPhase;
  metadataCreated: boolean;
  metadata: { dev: number; ino: number };
  stageIdentity?: { dev: number; ino: number };
  installed: Partial<Record<'store' | 'ignore' | 'config', Evidence>>;
}
export interface InitState {
  readonly stage: string;
  readonly phase: InitPhase;
  readonly resumed: boolean;
  mark(phase: InitPhase): void;
  publish(config: Config, preparedIgnore: PreparedIgnore): void;
  rollback(): void;
  finish(): void;
  release(): void;
}

// lstat also detects dangling symlinks, which must never be mistaken for free paths.
export function initStat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// Recovery can delete only files whose identity and contents match the staged
// artifacts. Hash directory contents too, to preserve a store someone edited.
function evidence(path: string): Evidence {
  const stat = lstatSync(path);
  const hash = createHash('sha256');
  function visit(entry: string, name: string): void {
    const info = lstatSync(entry);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      throw new Error(`cannot recover changed artifact: ${entry}`);
    }
    hash.update(JSON.stringify([name, info.dev, info.ino, info.mode]));
    if (info.isDirectory()) {
      for (const child of readdirSync(entry).sort())
        visit(join(entry, child), `${name}/${child}`);
    } else {
      hash.update(readFileSync(entry));
    }
  }
  visit(path, '');
  return { dev: stat.dev, ino: stat.ino, digest: hash.digest('hex') };
}

function matches(path: string, expected: Evidence): boolean {
  const stat = initStat(path);
  return (
    stat !== undefined &&
    stat.dev === expected.dev &&
    stat.ino === expected.ino &&
    evidence(path).digest === expected.digest
  );
}

export function initJournalPath(root: string, home: string): string {
  return join(
    home,
    '.config',
    'thaddeus',
    'init',
    `${createHash('sha256').update(root).digest('hex')}.json`
  );
}

// Validate journal fields before deriving any cleanup paths. No path read from
// the journal is used as an arbitrary filesystem destination.
function readJournal(input: InitStateInput): Journal | undefined {
  const path = initJournalPath(input.root, input.home);
  const stat = initStat(path);
  if (stat === undefined) return undefined;
  if (!stat.isFile()) throw new Error(`invalid init recovery record: ${path}`);
  const journal = JSON.parse(readFileSync(path, 'utf8')) as Journal;
  if (
    journal === null ||
    journal.version !== 1 ||
    typeof journal.attempt !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(journal.attempt) ||
    !['prepared', 'create-attempted', 'remote-created'].includes(
      journal.phase
    ) ||
    typeof journal.metadataCreated !== 'boolean' ||
    journal.metadata === null ||
    typeof journal.metadata !== 'object' ||
    !Number.isSafeInteger(journal.metadata.dev) ||
    !Number.isSafeInteger(journal.metadata.ino) ||
    journal.installed === null ||
    typeof journal.installed !== 'object' ||
    Object.keys(input).some(
      (key) =>
        journal[key as keyof InitStateInput] !==
        input[key as keyof InitStateInput]
    )
  ) {
    throw new Error(
      `init recovery record does not match root, server, repo or identity: ${path}`
    );
  }
  for (const [key, value] of Object.entries(journal.installed)) {
    if (
      !['store', 'ignore', 'config'].includes(key) ||
      value === null ||
      typeof value !== 'object' ||
      !Number.isSafeInteger(value.dev) ||
      !Number.isSafeInteger(value.ino) ||
      typeof value.digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.digest)
    ) {
      throw new Error(`invalid init recovery artifact: ${path}`);
    }
  }
  return journal;
}

// Reserve the root and keep write-ahead evidence outside the working tree.
// HTTP decisions belong to repo-init; this module never sends requests.
export function beginInitState(
  input: InitStateInput,
  completed = false
): InitState {
  const previous = readJournal(input);
  const meta = join(input.root, '.thaddeus');
  let stat = initStat(meta);
  const metadataCreated = stat === undefined;
  if (stat === undefined) {
    mkdirSync(meta, { mode: 0o700 });
    stat = lstatSync(meta);
  }
  if (!stat.isDirectory()) throw new Error(`${meta} must be a real directory`);
  const journal: Journal = previous ?? {
    ...input,
    version: 1,
    attempt: randomUUID(),
    phase: 'prepared',
    metadataCreated,
    metadata: { dev: stat.dev, ino: stat.ino },
    installed: {},
  };
  // A caught failure may have removed our empty metadata directory.
  if (previous !== undefined && metadataCreated) {
    journal.metadata = { dev: stat.dev, ino: stat.ino };
    journal.metadataCreated = true;
  } else if (
    stat.dev !== journal.metadata.dev ||
    stat.ino !== journal.metadata.ino
  ) {
    throw new Error(`changed init metadata directory: ${meta}`);
  }
  const lock = join(meta, 'init.lock');
  const ownerPath = join(lock, 'owner.json');
  const attempt = journal.attempt;
  const stage = join(meta, `init-stage-${attempt}`);
  const path = initJournalPath(input.root, input.home);
  let held = false;
  let ownerWritten = false;
  let committed = completed;
  let stageCreated = false;
  let finished = false;
  const installedPaths = {
    store: join(meta, 'store'),
    ignore: join(input.root, '.thaddeusignore'),
    config: join(meta, 'config.json'),
  };

  // Atomic replacement keeps a killed process from leaving half a JSON record.
  function persist(): void {
    const dir = join(input.home, '.config', 'thaddeus', 'init');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `${attempt}-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, `${JSON.stringify(journal)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  function removeEmptyMetadata(): void {
    const current = initStat(meta);
    if (
      !journal.metadataCreated ||
      current?.dev !== journal.metadata.dev ||
      current.ino !== journal.metadata.ino
    )
      return;
    try {
      rmdirSync(meta);
    } catch (error) {
      if (
        !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(
          (error as NodeJS.ErrnoException).code ?? ''
        )
      )
        throw error;
    }
  }
  function release(): void {
    if (!held) return;
    if (ownerWritten) {
      if (readdirSync(lock).some((name) => name !== 'owner.json'))
        throw new Error(`preserving changed init lock: ${lock}`);
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as {
        attempt: string;
        pid: number;
      };
      if (owner.attempt !== attempt || owner.pid !== process.pid)
        throw new Error(`changed init lock: ${lock}`);
      rmSync(ownerPath);
      ownerWritten = false;
    }
    rmdirSync(lock);
    held = false;
    removeEmptyMetadata();
  }
  // Check the stage directory identity again before recursive cleanup.
  function removeStage(): void {
    if (!stageCreated) return;
    const current = initStat(stage);
    if (current === undefined) return;
    if (
      !current.isDirectory() ||
      journal.stageIdentity?.dev !== current.dev ||
      journal.stageIdentity.ino !== current.ino
    ) {
      throw new Error(`preserving changed init stage: ${stage}`);
    }
    rmSync(stage, { recursive: true });
  }
  // Do not clear the journal until rollback has removed every owned artifact.
  function rollback(): void {
    if (committed) return;
    if (!held) throw new Error('init lock is not held');
    for (const key of ['store', 'ignore'] as const) {
      const expected = journal.installed[key];
      const target = installedPaths[key];
      if (expected === undefined || initStat(target) === undefined) continue;
      if (!matches(target, expected))
        throw new Error(`preserving changed init artifact: ${target}`);
      rmSync(target, { recursive: key === 'store' });
    }
    removeStage();
  }
  function finish(): void {
    if (finished) return;
    const current = readJournal(input);
    if (current !== undefined && current.attempt !== attempt)
      throw new Error(`changed init recovery record: ${path}`);
    removeStage();
    rmSync(path, { force: true });
    release();
    finished = true;
  }

  try {
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (
        initStat(lock)?.isDirectory() !== true ||
        initStat(ownerPath)?.isFile() !== true
      )
        throw new Error(`inspect incomplete init lock: ${lock}`);
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as {
        attempt: string;
        pid: number;
      };
      if (
        previous === undefined ||
        owner.attempt !== previous.attempt ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0
      )
        throw new Error(`inspect init lock before retry: ${lock}`);
      try {
        process.kill(owner.pid, 0);
        throw new Error(`active init lock: ${lock}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      // Remove only the known lock entry. Unknown contents block recovery.
      if (readdirSync(lock).some((name) => name !== 'owner.json'))
        throw new Error(`inspect unknown files in init lock: ${lock}`);
      rmSync(ownerPath);
      rmdirSync(lock);
      mkdirSync(lock, { mode: 0o700 });
    }
    held = true;
    writeFileSync(ownerPath, JSON.stringify({ attempt, pid: process.pid }), {
      flag: 'wx',
      mode: 0o600,
    });
    ownerWritten = true;
    if (
      previous === undefined &&
      initStat(installedPaths.store) !== undefined
    ) {
      throw new Error(
        `existing store has no init recovery record: ${installedPaths.store}`
      );
    }
    if (previous !== undefined) {
      const oldStage = initStat(stage);
      if (
        oldStage !== undefined &&
        (!oldStage.isDirectory() ||
          journal.stageIdentity?.dev !== oldStage.dev ||
          journal.stageIdentity.ino !== oldStage.ino)
      )
        throw new Error(`changed init stage: ${stage}`);
      stageCreated = oldStage !== undefined;
      const configStat = initStat(installedPaths.config);
      // The hard link is the commit point. Later pushes may change config bytes,
      // but the published inode still proves this attempt installed the marker.
      committed ||=
        configStat?.isFile() === true &&
        journal.installed.config !== undefined &&
        configStat.dev === journal.installed.config.dev &&
        configStat.ino === journal.installed.config.ino;
      if (!committed) rollback();
    }
    journal.installed = committed ? journal.installed : {};
    persist();
    if (!committed) {
      mkdirSync(stage, { mode: 0o700 });
      stageCreated = true;
      const stageStat = lstatSync(stage);
      journal.stageIdentity = { dev: stageStat.dev, ino: stageStat.ino };
      persist();
    }
    return {
      stage,
      resumed: previous !== undefined,
      get phase() {
        return journal.phase;
      },
      mark(phase) {
        if (!held) throw new Error('init lock is not held');
        journal.phase = phase;
        persist();
      },
      publish(config, preparedIgnore) {
        if (!held || committed)
          throw new Error('init cannot publish outside its transaction');
        const currentMeta = lstatSync(meta);
        if (
          !currentMeta.isDirectory() ||
          currentMeta.ino !== journal.metadata.ino ||
          currentMeta.dev !== journal.metadata.dev
        ) {
          throw new Error(`changed init metadata directory: ${meta}`);
        }
        const current = prepareIgnore(input.root);
        if (
          current.source !== preparedIgnore.source ||
          current.input?.text !== preparedIgnore.input?.text
        ) {
          throw new Error('ignore rules changed during init; retry');
        }
        if (preparedIgnore.seed !== null) {
          const seed = join(stage, 'ignore');
          writeFileSync(seed, preparedIgnore.seed, { flag: 'wx' });
          journal.installed.ignore = evidence(seed);
          persist();
          linkSync(seed, installedPaths.ignore);
        }
        journal.installed.store = evidence(join(stage, 'store'));
        persist();
        // The init lock serializes cooperating writers. Refuse pre-existing
        // stores before moving our staged metadata into place.
        if (initStat(installedPaths.store) !== undefined)
          throw new Error(`existing store: ${installedPaths.store}`);
        renameSync(join(stage, 'store'), installedPaths.store);
        const stagedConfig = join(stage, 'config.json');
        writeFileSync(stagedConfig, `${JSON.stringify(config, null, 2)}\n`, {
          flag: 'wx',
        });
        journal.installed.config = evidence(stagedConfig);
        persist();
        linkSync(stagedConfig, installedPaths.config);
        committed = true;
      },
      rollback,
      finish,
      release,
    };
  } catch (error) {
    try {
      if (held) {
        if (stageCreated && !committed) rollback();
        if (previous === undefined && journal.phase === 'prepared')
          rmSync(path, { force: true });
        release();
      } else removeEmptyMetadata();
    } catch (cleanup) {
      throw new Error(
        `${String(error)}; init cleanup failed: ${String(cleanup)}`
      );
    }
    throw error;
  }
}
