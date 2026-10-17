// Adapted from pingdotgg/t3code at 2fae0f9.
//
// `thaddeus triage` writes a machine-context file and a prompt (seed plus
// playbook) into a scratch directory and starts the user's own coding agent
// (claude or codex) there, so the agent can diagnose a broken setup and, only
// with the user's explicit yes, file a structured issue. Everything the command
// touches (home, clock, PATH, network, terminal, process spawning) arrives
// through `TriageDeps`, so the tests drive it without a real agent or server.
import { ready } from '@thaddeus.run/identity';
import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import {
  cliConfigDir,
  cliConfigPath,
  isServerUrl,
  loadCliConfig,
} from './config';
import { IdentityMissingError, identityPath, loadIdentity } from './identity';
import { TRIAGE_PLAYBOOK } from './triage-playbook';
import { VERSION } from './version';
import { findRoot, loadConfig, viewOf } from './workcopy';

/** What the `/version` probe hands to its fetch. It never carries the wire
 * protocol header: a mismatched one makes the server answer 426 instead of its
 * version, which is the very fact the probe is trying to record. */
export interface ProbeInit {
  signal: AbortSignal;
  headers: Record<string, string>;
}

/** The facts the context file is built from, all injectable. */
export interface TriageEnv {
  home: string;
  cwd: string;
  now: Date;
  /** The triage CLI's own version. */
  version: string;
  platform: string;
  arch: string;
  /** For example `Bun 1.3.14`. */
  runtime: string;
  execPath: string;
  fetchImpl: (url: string, init: ProbeInit) => Promise<Response>;
  /** Per-server cap on the `/version` probe. */
  probeTimeoutMs: number;
}

/** One agent process to start: stdio is inherited, the exit code is returned. */
export interface AgentLaunch {
  command: string;
  args: string[];
  cwd: string;
}

/** Everything `runTriage` needs: the context facts plus terminal and process IO. */
export interface TriageDeps extends TriageEnv {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Whether both stdin and stdout are terminals (so a prompt can be answered). */
  isTTY: boolean;
  /** Absolute path of an executable on PATH, or undefined when it is missing. */
  findCommand: (name: string) => string | undefined;
  ask: (question: string) => Promise<string>;
  spawnAgent: (launch: AgentLaunch) => Promise<number>;
}

const AGENTS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
] as const;

type AgentId = (typeof AGENTS)[number]['id'];

// The one argument the agent starts with. The real instructions live in
// prompt.md next to it: a short, space-only string survives every shell and
// Windows `.cmd` shim, which a multi-kilobyte multiline playbook would not.
const LAUNCH_ARGUMENT =
  'Read the file prompt.md in this directory and follow its instructions.';

const USAGE = 'usage: thaddeus triage [--agent claude|codex]';

// How many unusable answers to the agent picker we tolerate before giving up.
const MAX_PICK_ATTEMPTS = 3;

// The scratch directory for one run. The ISO timestamp has its `:` replaced so
// the name is a valid path component on Windows too.
export function triageDirFor(home: string, now: Date): string {
  return join(
    cliConfigDir(home),
    'triage',
    now.toISOString().replaceAll(':', '-')
  );
}

// Flatten untrusted text (a server's reply, a hand-edited config) to a single
// short line, so it cannot add headings or instructions to the context file.
function oneLine(text: string, max = 200): string {
  const flat = text.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// Matches the `scheme://userinfo@` start of any URL in free text. The userinfo
// part is greedy up to the last `@` before the path, as URL parsers read it,
// so a password containing `@` is covered too.
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi;

/** A URL with its username and password replaced by `***`, so a server URL
 * like `https://alice:secret@host` can be shown to a support agent without
 * the credentials. `https://***@host/` marks that credentials were configured.
 * A URL without credentials is returned exactly as given. Text that does not
 * parse as a URL still gets any `scheme://userinfo@` prefix masked, since a
 * hand-edited config can hold anything. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username === '' && parsed.password === '') return url;
    parsed.username = '***';
    parsed.password = '';
    return parsed.href;
  } catch {
    return url.replace(URL_USERINFO, '$1***@');
  }
}

// An error's message as one safe line. Network errors often quote the URL they
// failed on (real fetch refuses credentialed URLs and names the URL), so any
// userinfo in the message is masked too.
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return oneLine(message.replace(URL_USERINFO, '$1***@'));
}

// Ask a server what it is: `GET <server>/version`. Plain fetch with a short
// timeout and no protocol header (see ProbeInit); any failure becomes a line of
// text for the agent instead of an exception, since an unreachable or
// mismatched server is exactly the sort of thing triage exists to look at.
async function probeServer(env: TriageEnv, server: string): Promise<string[]> {
  if (!isServerUrl(server)) {
    return [
      `${oneLine(redactUrl(server))}: not a valid http(s) URL, so it was not probed`,
    ];
  }
  const url = `${server.replace(/\/+$/, '')}/version`;
  // What goes into the context file: the probe URL without any credentials.
  const shown = `${redactUrl(server).replace(/\/+$/, '')}/version`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('timed out')),
    env.probeTimeoutMs
  );
  try {
    const res = await env.fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const body = await res.text();
    const lines: string[] = [];
    if (res.status === 200) {
      lines.push(`GET ${shown}: HTTP 200 ${describeVersionBody(body)}`);
    } else {
      const reason =
        res.statusText === '' ? '' : ` ${oneLine(res.statusText, 60)}`;
      lines.push(
        `GET ${shown}: HTTP ${res.status}${reason}, body ${JSON.stringify(oneLine(body))}`
      );
    }
    const headers = ['x-thaddeus-version', 'x-thaddeus-protocol']
      .map((name) => [name, res.headers.get(name)] as const)
      .filter((pair): pair is readonly [string, string] => pair[1] !== null)
      .map(([name, value]) => `${name}: ${oneLine(value, 80)}`);
    if (headers.length > 0)
      lines.push(`response headers: ${headers.join(', ')}`);
    return lines;
  } catch (error) {
    const why = controller.signal.aborted
      ? `timed out after ${env.probeTimeoutMs} ms`
      : errorText(error);
    return [`GET ${shown}: unreachable (${why})`];
  } finally {
    clearTimeout(timer);
  }
}

// Summarise a 200 `/version` body as `server version X, protocol N`, or quote
// it (flattened and truncated) when it is not the documented shape.
function describeVersionBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string' &&
      'protocol' in parsed &&
      typeof parsed.protocol === 'number'
    ) {
      return `server version ${oneLine(parsed.version, 80)}, protocol ${parsed.protocol}`;
    }
  } catch {
    // Not JSON: fall through to the quoted form below.
  }
  return `but unexpected /version body ${JSON.stringify(oneLine(body))}`;
}

// A hand-editable config value as one safe line, or a marker when it is absent.
function configField(value: unknown, max = 200): string {
  return typeof value === 'string' ? oneLine(value, max) : '(missing)';
}

// The working copy at or above `cwd`: repository, branch and saved head, plus
// the server it talks to so that can be probed too.
function describeWorkingCopy(cwd: string): {
  lines: string[];
  server?: string;
  root?: string;
} {
  const root = findRoot(cwd);
  if (root === undefined) {
    return {
      lines: [
        `Not inside a working copy (no .thaddeus/config.json at or above ${oneLine(cwd, 300)}).`,
      ],
    };
  }
  try {
    const cfg = loadConfig(root);
    const base = Array.isArray(cfg.base) ? cfg.base.map(String) : [];
    const shown = base.slice(0, 8).map((id) => oneLine(id, 80));
    const more =
      base.length > shown.length
        ? ` (+${base.length - shown.length} more)`
        : '';
    const lines = [
      `Root: ${root}`,
      `Repository: ${configField(cfg.repo)}`,
      `Branch: ${oneLine(viewOf(cfg))}`,
      `Head (saved base): ${shown.length === 0 ? 'none (no commits synced yet)' : shown.join(', ') + more}`,
      `Server: ${typeof cfg.server === 'string' ? oneLine(redactUrl(cfg.server)) : '(missing)'}`,
    ];
    if (cfg.store !== undefined) {
      lines.push(
        `Shared object store (workspace): ${configField(cfg.store, 300)}`
      );
    }
    return {
      lines,
      root,
      server: typeof cfg.server === 'string' ? cfg.server : undefined,
    };
  } catch {
    return {
      root,
      lines: [
        `Root: ${root}`,
        'Working copy config is unreadable or not valid JSON (.thaddeus/config.json).',
      ],
    };
  }
}

// The identity's public DID, or why there isn't one. Only the fixed messages
// the identity loader itself produces are repeated: a JSON syntax error can
// quote the file, and the file holds the secret seed.
async function describeIdentity(home: string): Promise<string> {
  await ready();
  try {
    return loadIdentity(home).did;
  } catch (error) {
    if (error instanceof IdentityMissingError) {
      return "none (no identity yet; 'thaddeus identity init' creates one)";
    }
    if (
      error instanceof Error &&
      error.message.startsWith('invalid identity:')
    ) {
      return `present but invalid (${error.message})`;
    }
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string'
      ? `present but could not be loaded (unreadable: ${code})`
      : 'present but could not be loaded (not valid JSON)';
  }
}

/** Build the text of `context.md`: the facts a support agent needs, with the
 * identity seed deliberately absent (only its path, marked never-read). */
export async function buildTriageContext(env: TriageEnv): Promise<string> {
  const cli = loadCliConfig(env.home);
  const defaultServer =
    typeof cli.defaultServer === 'string' ? cli.defaultServer : undefined;
  const copy = describeWorkingCopy(env.cwd);

  const targets: { label: string; url: string }[] = [];
  if (copy.server !== undefined) {
    const isDefault = copy.server === defaultServer;
    targets.push({
      label: isDefault
        ? "Working copy server (also the default set by 'thaddeus use')"
        : 'Working copy server',
      url: copy.server,
    });
  }
  if (defaultServer !== undefined && defaultServer !== copy.server) {
    targets.push({
      label: "Default server ('thaddeus use')",
      url: defaultServer,
    });
  }
  const probes = await Promise.all(
    targets.map((target) => probeServer(env, target.url))
  );

  const serverLines: string[] = [];
  if (defaultServer === undefined) {
    serverLines.push(
      "- Default server ('thaddeus use'): no default server is set"
    );
  }
  targets.forEach((target, index) => {
    serverLines.push(
      `- ${target.label}: ${oneLine(redactUrl(target.url), 300)}`
    );
    for (const line of probes[index]) serverLines.push(`  - ${line}`);
  });

  const did = await describeIdentity(env.home);
  const lines = [
    '# Thaddeus triage context',
    '',
    `Generated by \`thaddeus triage\` at ${env.now.toISOString()}.`,
    '',
    `- Triage CLI version: ${env.version} (the thaddeus that ran this command; the bug may have happened on another build)`,
    `- OS: ${env.platform} ${env.arch}`,
    `- Runtime: ${env.runtime}`,
    `- Executable: ${env.execPath}`,
    `- Identity (public DID): ${did}`,
    `- Run from: ${env.cwd}`,
    '- Repo: https://github.com/thaddeus-run/thaddeus',
    '',
    '## Servers',
    '',
    ...serverLines,
    '',
    '## Working copy',
    '',
    ...copy.lines.map((line) => `- ${line}`),
    '',
    '## Paths',
    '',
    `- CLI config dir: ${cliConfigDir(env.home)}`,
    `- CLI config (default server): ${cliConfigPath(env.home)}`,
    `- Identity file: ${identityPath(env.home)} (never read this file; it holds the secret seed, and the public DID is above)`,
    `- Triage scratch dir: ${triageDirFor(env.home, env.now)}`,
  ];
  if (copy.root !== undefined) {
    lines.push(
      `- Working copy config: ${join(copy.root, '.thaddeus', 'config.json')} (names the server, repository, branch and saved base)`
    );
  }
  return `${lines.join('\n')}\n`;
}

// The seed paragraph in front of the playbook in prompt.md. It points at
// context.md by absolute path so the file also works pasted into an agent that
// was not started in the scratch directory.
function buildSeedPrompt(contextPath: string): string {
  return `A Thaddeus user is having a problem with their setup and started this session with \`thaddeus triage\`.

Machine facts (versions, OS, servers, working copy, config paths) are in the triage context file:

    ${contextPath}

The context file marks the identity seed file as never to be read; do not open it. Follow the playbook below, starting by asking the user what went wrong.

---

${TRIAGE_PLAYBOOK}`;
}

// Whether `file` is a regular file the current user may execute (on Windows
// only the extension decides, so existence is enough).
function isExecutableFile(file: string, platform: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `command` the way a shell would: first executable match on PATH,
 * trying PATHEXT suffixes on Windows. Returns undefined when absent. */
export function findOnPath(
  command: string,
  pathEnv: string | undefined,
  platform: string,
  pathExt?: string
): string | undefined {
  if (pathEnv === undefined) return undefined;
  const separator = platform === 'win32' ? ';' : ':';
  const suffixes =
    platform === 'win32'
      ? (pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((s) => s !== '')
      : [''];
  for (const dir of pathEnv.split(separator)) {
    if (dir === '') continue;
    for (const suffix of suffixes) {
      const candidate = resolve(dir, command + suffix);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

// Ask which of several installed agents to use, by number or id. Returns
// undefined after MAX_PICK_ATTEMPTS unusable answers (including a closed
// terminal, which answers with an empty string).
async function pickAgent<T extends { id: string; label: string }>(
  installed: readonly T[],
  ask: TriageDeps['ask']
): Promise<T | undefined> {
  const menu = installed
    .map((agent, index) => `  [${index + 1}] ${agent.label}`)
    .join('\n');
  for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt += 1) {
    const answer = (await ask(`Run triage with:\n${menu}\n> `)).trim();
    const byNumber = installed[Number.parseInt(answer, 10) - 1];
    if (byNumber !== undefined) return byNumber;
    const byId = installed.find((a) => a.id === answer.toLowerCase());
    if (byId !== undefined) return byId;
  }
  return undefined;
}

/** Run `thaddeus triage [--agent claude|codex]` and return the exit code: the
 * agent's own when one was launched, 0 when only the files were written, 2 for
 * usage or an unanswerable agent choice, 1 when the agent cannot be started. */
export async function runTriage(
  argv: string[],
  deps: TriageDeps
): Promise<number> {
  let requested: AgentId | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { agent: { type: 'string' } },
      allowPositionals: true,
    });
    const match = AGENTS.find((agent) => agent.id === values.agent);
    if (
      positionals.length > 0 ||
      (values.agent !== undefined && match === undefined)
    ) {
      deps.err(USAGE);
      return 2;
    }
    requested = match?.id;
  } catch {
    deps.err(USAGE);
    return 2;
  }

  const installed = AGENTS.flatMap((agent) => {
    const path = deps.findCommand(agent.id);
    return path === undefined ? [] : [{ ...agent, path }];
  });

  let selected: (typeof installed)[number] | undefined;
  if (requested !== undefined) {
    selected = installed.find((agent) => agent.id === requested);
    if (selected === undefined) {
      deps.err(
        `${requested} was not found on PATH. Install it, or run 'thaddeus triage' without --agent to write the prompt files only.`
      );
      return 1;
    }
  } else if (installed.length === 1) {
    selected = installed[0];
  } else if (installed.length > 1) {
    if (!deps.isTTY) {
      deps.err(
        'Both claude and codex are installed and there is no terminal to ask which to use. Re-run with --agent claude or --agent codex.'
      );
      return 2;
    }
    selected = await pickAgent(installed, deps.ask);
    if (selected === undefined) {
      deps.err(`No agent chosen. ${USAGE}`);
      return 2;
    }
  }

  const dir = triageDirFor(deps.home, deps.now);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const contextPath = join(dir, 'context.md');
  const promptPath = join(dir, 'prompt.md');
  writeFileSync(contextPath, await buildTriageContext(deps), { mode: 0o600 });
  writeFileSync(promptPath, buildSeedPrompt(contextPath), { mode: 0o600 });

  if (selected === undefined) {
    deps.out(
      [
        'No supported agent CLI (claude, codex) was found on PATH.',
        '',
        'The triage prompt and machine context were written to:',
        `  ${promptPath}`,
        `  ${contextPath}`,
        '',
        'Paste the prompt file into any coding agent to run triage by hand.',
      ].join('\n')
    );
    return 0;
  }

  deps.out(`Starting ${selected.label}. It will ask what went wrong.\n`);
  try {
    return await deps.spawnAgent({
      command: selected.path,
      args: [LAUNCH_ARGUMENT],
      cwd: dir,
    });
  } catch (error) {
    deps.err(`Could not start ${selected.id}: ${errorText(error)}`);
    return 1;
  }
}

// Wrap a value for cmd.exe, which Node needs when spawning a `.cmd`/`.bat`
// shim (it refuses to run them without a shell). Our own arguments never
// contain a double quote, so plain quoting is enough.
function quoteForCmd(value: string): string {
  return `"${value}"`;
}

// Start the agent on the user's terminal and wait for it. SIGINT is swallowed
// here while it runs: Ctrl-C reaches the whole foreground group, so the agent
// handles it itself and we only report how it ended.
function spawnOnTerminal(launch: AgentLaunch): Promise<number> {
  const shim =
    process.platform === 'win32' && /\.(cmd|bat)$/i.test(launch.command);
  const ignore = (): void => {};
  process.on('SIGINT', ignore);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      shim ? quoteForCmd(launch.command) : launch.command,
      shim ? launch.args.map(quoteForCmd) : launch.args,
      { cwd: launch.cwd, stdio: 'inherit', shell: shim }
    );
    child.once('error', reject);
    // A signal death has no exit code; report it as a failure.
    child.once('exit', (code) => resolve(code ?? 1));
  }).finally(() => {
    process.off('SIGINT', ignore);
  });
}

// One question on the terminal. A closed stdin answers with an empty string
// instead of leaving the promise pending forever.
async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.once('close', () => resolve(''));
      rl.question(question).then(resolve, () => resolve(''));
    });
  } finally {
    rl.close();
  }
}

/** The real-world `TriageDeps`: this process, the system clock and PATH, global
 * fetch (or the CLI's injected request handler, in tests of the full CLI). */
export function systemTriageDeps(io: {
  home: string;
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  fetchImpl?: (req: Request) => Promise<Response>;
}): TriageDeps {
  const requestHandler = io.fetchImpl;
  return {
    home: io.home,
    cwd: io.cwd,
    now: new Date(),
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    runtime:
      process.versions.bun !== undefined
        ? `Bun ${process.versions.bun}`
        : `Node ${process.version}`,
    execPath: process.execPath,
    fetchImpl:
      requestHandler === undefined
        ? (url, init) => fetch(url, init)
        : (url, init) => requestHandler(new Request(url, init)),
    probeTimeoutMs: 3000,
    out: io.out,
    err: io.err,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    findCommand: (name) =>
      findOnPath(
        name,
        process.env.PATH ?? process.env.Path,
        process.platform,
        process.env.PATHEXT
      ),
    ask: askOnTerminal,
    spawnAgent: spawnOnTerminal,
  };
}
