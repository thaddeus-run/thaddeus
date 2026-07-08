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
  // The default server for `create`/`clone` when none is passed. Absent until
  // the user runs `thaddeus use`.
  defaultServer?: string;
}

function configPath(home: string): string {
  return join(home, '.config', 'thaddeus', 'config.json');
}

// Read the global config, treating any absent/unreadable file as empty so a
// fresh install (or a cleared default) just yields `{}`.
export function loadCliConfig(home: string): CliConfig {
  try {
    return JSON.parse(readFileSync(configPath(home), 'utf8')) as CliConfig;
  } catch {
    return {};
  }
}

// Persist the global config, writing only defined keys so a cleared value
// disappears rather than serializing as noise.
export function saveCliConfig(home: string, cfg: CliConfig): void {
  mkdirSync(join(home, '.config', 'thaddeus'), {
    recursive: true,
    mode: 0o700,
  });
  const clean: CliConfig = {};
  if (cfg.defaultServer !== undefined) clean.defaultServer = cfg.defaultServer;
  writeFileSync(configPath(home), `${JSON.stringify(clean, null, 2)}\n`, {
    mode: 0o600,
  });
}

// A server argument is an http(s) URL; a repo is `owner/name` with no scheme.
// This distinguishes a leading `create https://host repo` (back-compat) from a
// bare `create repo` (use the default), and validates a `--server`/`use` value.
export function isServerUrl(s: string | undefined): boolean {
  return s !== undefined && /^https?:\/\//i.test(s);
}

// The message shown when `create`/`clone` can't resolve a server. This is the
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
