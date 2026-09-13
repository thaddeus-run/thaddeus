import { Client, ClientResponseError } from '@thaddeus.run/client';
import { FileBackend } from '@thaddeus.run/persist';
import { Platform } from '@thaddeus.run/platform';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { loadIdentity } from './identity';
import { type PreparedIgnore, prepareIgnore } from './ignore';
import { beginInitState, initJournalPath, initStat } from './init-state';
import type { CliEnv } from './run';
import {
  type Config,
  listWorkingFiles,
  loadConfig,
  storePath,
} from './workcopy';

export class InitConflictError extends Error {}
export interface InitInspection {
  readonly root: string;
  readonly preparedIgnore: PreparedIgnore;
  readonly files: readonly string[];
  readonly skippedEntries: number;
  readonly existing: Config | null;
}

// Resolve through existing ancestors so a not-yet-created config directory
// cannot hide an identity home behind a symlink.
function canonical(path: string): string {
  const full = resolve(path);
  if (initStat(full) !== undefined) return realpathSync(full);
  return join(canonical(dirname(full)), relative(dirname(full), full));
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  );
}

// Inspect independently of user ignore rules: an ignored source directory can
// still contain a working copy which must not acquire a second parent root.
export function inspectInit(cwd: string, home: string): InitInspection {
  const root = realpathSync(cwd);
  if (!lstatSync(root).isDirectory())
    throw new InitConflictError('init requires a directory');
  if (contains(root, canonical(join(home, '.config', 'thaddeus')))) {
    throw new InitConflictError('directory contains identity configuration');
  }
  for (let parent = dirname(root); ; parent = dirname(parent)) {
    if (initStat(join(parent, '.thaddeus', 'config.json')) !== undefined) {
      throw new InitConflictError(`inside an existing working copy: ${parent}`);
    }
    if (dirname(parent) === parent) break;
  }
  const meta = join(root, '.thaddeus');
  const metadata = initStat(meta);
  if (metadata !== undefined && !metadata.isDirectory())
    throw new InitConflictError(`${meta} must be a real directory`);
  const marker = initStat(join(meta, 'config.json'));
  let existing: Config | null = null;
  if (marker !== undefined) {
    if (!marker.isFile())
      throw new Error('working-copy config must be a regular file');
    existing = loadConfig(root);
    if (
      existing === null ||
      typeof existing.server !== 'string' ||
      typeof existing.repo !== 'string' ||
      !Array.isArray(existing.base) ||
      existing.base.some((head) => typeof head !== 'string')
    ) {
      throw new Error('invalid working-copy config');
    }
  } else if (
    initStat(join(meta, 'store')) !== undefined &&
    initStat(initJournalPath(root, home)) === undefined
  ) {
    throw new InitConflictError('existing store has no init recovery record');
  }
  let skippedEntries = 0;
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['.git', '.thaddeus', 'node_modules'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (initStat(join(path, '.thaddeus', 'config.json')) !== undefined) {
          throw new InitConflictError(`nested working copy: ${path}`);
        }
        walk(path);
      } else if (!entry.isFile()) skippedEntries++;
    }
  }
  walk(root);
  const preparedIgnore = prepareIgnore(root);
  return {
    root,
    preparedIgnore,
    files: listWorkingFiles(root, preparedIgnore.ignore),
    skippedEntries,
    existing,
  };
}

export interface InitRepositoryInput {
  cwd: string;
  home: string;
  name: string;
  server: string;
  fetchImpl?: NonNullable<CliEnv['fetchImpl']>;
}
export interface InitResult {
  root: string;
  repo: string;
  owner: string;
  alreadyInitialized: boolean;
  includedFiles: number;
  skippedEntries: number;
  ignoreSource: PreparedIgnore['source'];
  warnings: string[];
}

// Quote retry arguments for POSIX shells without allowing command substitution.
function quoteArgument(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

// Create the signed empty remote and publish only local metadata. Existing
// source files are never materialized, committed, or uploaded by this command.
export async function initRepository(
  input: InitRepositoryInput
): Promise<InitResult> {
  const identity = loadIdentity(input.home);
  const inspection = inspectInit(input.cwd, input.home);
  const { root, existing } = inspection;
  const server = input.server.replace(/\/+$/, '');
  const stateInput = {
    root,
    home: input.home,
    repo: input.name,
    server,
    owner: identity.did,
  };
  const result: InitResult = {
    root,
    repo: input.name,
    owner: identity.did,
    alreadyInitialized: existing !== null,
    includedFiles: inspection.files.length,
    skippedEntries: inspection.skippedEntries,
    ignoreSource: inspection.preparedIgnore.source,
    warnings: [],
  };
  if (existing !== null) {
    if (
      existing.repo !== input.name ||
      existing.server.replace(/\/+$/, '') !== server
    ) {
      throw new InitConflictError(
        'working copy already belongs to a different repository or server'
      );
    }
    const store = storePath(root, existing);
    if (initStat(store)?.isDirectory() !== true)
      throw new Error('working-copy store is missing or invalid');
    const local = await new Platform().openDurable(
      existing.repo,
      new FileBackend(store)
    );
    if (local.headRecords.owner !== identity.did)
      throw new InitConflictError(
        'working-copy owner differs from the current identity'
      );
    if (initStat(initJournalPath(root, input.home)) !== undefined) {
      const state = beginInitState(stateInput, true);
      try {
        state.finish();
      } catch (error) {
        result.warnings.push(
          `already initialized; cleanup needs retry: ${String(error)}`
        );
      } finally {
        try {
          state.release();
        } catch (error) {
          result.warnings.push(`lock cleanup needs retry: ${String(error)}`);
        }
      }
    }
    return result;
  }
  const state = beginInitState(stateInput);
  const client = new Client(server, identity, input.fetchImpl);
  let keepJournal = state.phase !== 'prepared';
  let published = false;
  const clone = () =>
    client.clone(
      input.name,
      new FileBackend(join(state.stage, 'store')),
      'main',
      { expectedOwner: identity.did }
    );
  try {
    // Recovery rolls back an ignore seed installed by the interrupted attempt.
    // Inspect its inputs again before the network round trip, so publication
    // compares against the recovered tree while still catching later edits.
    const preparedIgnore = state.resumed
      ? prepareIgnore(root)
      : inspection.preparedIgnore;
    result.ignoreSource = preparedIgnore.source;
    let cloned: Awaited<ReturnType<typeof clone>> | undefined;
    if (state.resumed && state.phase !== 'prepared') {
      try {
        cloned = await clone();
      } catch (error) {
        if (!(error instanceof ClientResponseError) || error.status !== 404)
          throw error;
      }
    }
    if (cloned === undefined) {
      state.mark('create-attempted');
      keepJournal = true;
      try {
        await client.createRepo(input.name);
      } catch (error) {
        // A fresh rejected request cannot own the colliding repository. A
        // resumed attempt keeps its evidence if a competing create raced it.
        if (
          !state.resumed &&
          error instanceof ClientResponseError &&
          error.status >= 400 &&
          error.status < 500
        ) {
          keepJournal = false;
        }
        throw error;
      }
      state.mark('remote-created');
      cloned = await clone();
    }
    if (
      cloned.head.version !== 0 ||
      cloned.heads.length !== 0 ||
      cloned.repo.log.ops().length !== 0
    ) {
      throw new Error(
        'repository changed during init; clone into a separate directory'
      );
    }
    // Recheck roots after the network round trip. Do not publish around a
    // working copy that appeared while the request was in flight.
    const current = inspectInit(root, input.home);
    if (current.existing !== null)
      throw new InitConflictError('working-copy config appeared during init');
    state.publish(
      { server, repo: input.name, base: [], view: 'main' },
      preparedIgnore
    );
    published = true;
    result.includedFiles = listWorkingFiles(
      root,
      prepareIgnore(root).ignore
    ).length;
    try {
      state.finish();
    } catch (error) {
      result.warnings.push(
        `initialized; cleanup needs retry: ${String(error)}`
      );
    }
    return result;
  } catch (error) {
    if (published) {
      result.warnings.push(
        `initialized; cleanup needs retry: ${String(error)}`
      );
      return result;
    }
    const problems: string[] = [];
    try {
      state.rollback();
    } catch (cleanup) {
      problems.push(String(cleanup));
      keepJournal = true;
    }
    if (!keepJournal) {
      try {
        state.finish();
      } catch (cleanup) {
        problems.push(String(cleanup));
      }
    }
    try {
      state.release();
    } catch (cleanup) {
      problems.push(String(cleanup));
    }
    const recovery = keepJournal
      ? `; recovery record: ${initJournalPath(root, input.home)}; retry in ${root}: thaddeus init ${quoteArgument(input.name)} --server ${quoteArgument(server)}`
      : '';
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${problems.length > 0 ? `; ${problems.join('; ')}` : ''}${recovery}`
    );
  } finally {
    try {
      state.release();
    } catch (error) {
      if (published)
        result.warnings.push(
          `initialized; lock cleanup needs retry: ${String(error)}`
        );
      // A failed attempt has already reported release errors with its primary error.
    }
  }
}
