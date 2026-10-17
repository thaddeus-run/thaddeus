import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The optional, official hosted Thaddeus server. It is NEVER pre-filled: a user
// opts in explicitly with `thaddeus use --hosted`. Recommended (not defaulted)
// in the first-run hint, `thaddeus help`, and the docs — the choice of server
// always stays the user's.
export const HOSTED_SERVER = 'https://ams1.thaddeus.run';

// Global, per-user CLI settings — distinct from the per-working-copy config in
// `.thaddeus/config.json` (workcopy.ts). Lives beside the identity seed so all
// user-scoped state is under one `~/.config/thaddeus/` dir.
export interface CliConfig {
  // The default server for `init`/`create`/`clone` when none is passed. Absent until
  // the user runs `thaddeus use`.
  defaultServer?: string;
}

// The per-user config directory: holds `config.json` and the identity seed.
export function cliConfigDir(home: string): string {
  return join(home, '.config', 'thaddeus');
}

export function cliConfigPath(home: string): string {
  return join(cliConfigDir(home), 'config.json');
}

/** The global config as loaded. `ignored` says why an existing `config.json`
 * was not used, phrased to follow "the file is" (e.g. `not valid JSON`). It
 * never quotes the file, and is absent when the file loaded or does not exist. */
export interface CliConfigRead {
  config: CliConfig;
  ignored?: string;
}

// The JSON type of a parsed value that is not an object, for `ignored`.
function jsonKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

// Read the global config. Anything that is not a JSON object (a missing or
// unreadable file, bad JSON, or a hand-edited `null`, array, string or number)
// yields `{}`, so every caller can read `defaultServer` without checking; the
// reason is kept for `thaddeus triage`, which reports it.
export function readCliConfig(home: string): CliConfigRead {
  let text: string;
  try {
    text = readFileSync(cliConfigPath(home), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { config: {} };
    return { config: {}, ignored: `unreadable (${code ?? 'unknown error'})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { config: {}, ignored: 'not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      config: {},
      ignored: `not a JSON object (found ${jsonKind(parsed)})`,
    };
  }
  return { config: parsed as CliConfig };
}

// The global config, or `{}` when there is none usable, so a fresh install (or
// a cleared default) just yields `{}`.
export function loadCliConfig(home: string): CliConfig {
  return readCliConfig(home).config;
}

// Persist the global config, writing only defined keys so a cleared value
// disappears rather than serializing as noise.
export function saveCliConfig(home: string, cfg: CliConfig): void {
  mkdirSync(cliConfigDir(home), {
    recursive: true,
    mode: 0o700,
  });
  const clean: CliConfig = {};
  if (cfg.defaultServer !== undefined) clean.defaultServer = cfg.defaultServer;
  writeFileSync(cliConfigPath(home), `${JSON.stringify(clean, null, 2)}\n`, {
    mode: 0o600,
  });
}

// Whether `s` is a usable http(s) server URL (scheme + a non-empty host) — not
// merely scheme-shaped, so `https://` is rejected. This both validates a
// `--server`/`use` value and distinguishes a leading `create https://host repo`
// (back-compat) from a bare `create repo` (a repo is `owner/name`, not a URL).
export function isServerUrl(s: string | undefined): boolean {
  if (s === undefined) return false;
  try {
    const url = new URL(s);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname !== ''
    );
  } catch {
    return false;
  }
}

// The message shown when `init`/`create`/`clone` can't resolve a server. This is the
// first-run hint: it lays out every way to provide one — inline, saved default,
// or the hosted server — without ever pre-choosing for the user.
export function noServerHint(command: string): string {
  return [
    'no server set. Pass one, save a default, or use the hosted server:',
    `  thaddeus ${command} … --server https://your-host   # this time only`,
    '  thaddeus use https://your-host                    # save as your default',
    `  thaddeus use --hosted                             # use ${HOSTED_SERVER}`,
  ].join('\n');
}
