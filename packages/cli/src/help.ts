// The one-screen command overview (bare `thaddeus`, `help`, `--help`).
export const USAGE = `thaddeus — the Thaddeus CLI

  thaddeus <command> [args]     run 'thaddeus help <command>' for details

Working tree
  init                          create a self-owned identity
  whoami                        print the current identity's DID
  create <server> <repo>        create a repo on a server
  clone  <server> <repo> [dir]  clone a repo to a working tree
  status                        show working-tree changes
  diff   [--staged] [path...]   show a line diff of working-tree changes
  push   [-m "<why>"]           commit + upload (+ a signed why) + land
  land                          land uploaded-but-unmerged commits

History & meaning
  log    [--since D] [--until D]  main's history with the why per change
  why    <op>                     the signed why for one op
  veto   <op> [-m "<reason>"]     lodge a standing veto that blocks a land
  vetoes <op>                     list the standing vetoes on one op
  rename <old> <new> [-m "<why>"] rename a symbol as one signed SymbolOp
  history <symbol>                a symbol's signed rename chain

Access & trust
  grant  <did> [--paths a,b] [--max-changes N]  grant push to a DID/agent
  revoke <did>                                  revoke a grant
  grants                                        list active grants
  reputation <did>                              a DID's server-wide reputation

Server
  serve  [--port N] [--data DIR] [--host] [--min-merges N]  run a server

Global flags
  --version, -v                 print the version
  --help,    -h                 print help (per command when after a command)
  --json                        machine-readable output (read commands)`;

// Per-command detailed help, shown by `thaddeus <cmd> --help` or
// `thaddeus help <cmd>`. Each entry is a self-contained usage block.
export const HELP: Record<string, string> = {
  init: `thaddeus init [--force]

  Create a self-owned identity (a did:key) under the config home. Idempotent:
  re-running prints the existing DID. --force rotates to a fresh identity.`,

  whoami: `thaddeus whoami [--json]

  Print the current identity's DID (the key every write is signed with).`,

  create: `thaddeus create <server> <repo>

  Create a repo you own on <server>. You become its owner; only you (or a
  delegate you grant) may push or land.`,

  clone: `thaddeus clone <server> <repo> [dir]

  Clone <repo> from <server> into [dir] (defaults to the repo's last path
  segment). Materializes the current 'main' view and records the remote.`,

  status: `thaddeus status [--json]

  Show working-tree changes against the base snapshot (added / modified /
  deleted) and how many commits are unpublished.`,

  diff: `thaddeus diff [--staged] [path...]

  Show a line-level diff of the working tree against the base snapshot. With
  [path...], limit the diff to those repo paths. --staged diffs the committed-
  but-unpublished ops against the last synced base instead of the disk.`,

  push: `thaddeus push [-m "<why>"] [--no-land]

  Commit the working-tree diff, upload it, and land it on 'main'. -m attaches a
  signed provenance "why" to each published op. --no-land uploads without
  landing (finish later with 'thaddeus land').`,

  land: `thaddeus land

  Land already-uploaded but unmerged commits onto 'main' under the server's
  policy. A blocked land reports the reason and leaves 'main' untouched.`,

  log: `thaddeus log [--since <ISO>] [--until <ISO>] [--json]

  Show 'main' history newest-first with the signed why per change and a ⛔
  marker for a vetoed op. --since/--until filter by the op's signed timestamp
  (op.at), inclusive, compared as instants (any ISO 8601 form, e.g.
  2026-07-01 or 2026-07-01T12:00:00+02:00).`,

  why: `thaddeus why <op> [--json]

  Show the signed provenance for one op (resolved by id prefix), each record
  labelled [verified] or [unverified].`,

  veto: `thaddeus veto <op> [-m "<reason>"]

  Lodge a standing veto on an op (resolved by id prefix). A verified veto blocks
  any subsequent land of that op. Requires push access on the repo.`,

  vetoes: `thaddeus vetoes <op> [--json]

  List the standing vetoes on one op (resolved by id prefix).`,

  rename: `thaddeus rename <old> <new> [-m "<why>"] [--no-land]

  Rename a symbol as ONE signed SymbolOp rendered across its definition and
  every reference, then push + land. -m attaches a why; --no-land uploads only.`,

  history: `thaddeus history <symbol> [--json]

  Show a symbol's signed rename chain. <symbol> is a live name, a full symbol
  id, or an id prefix (as 'rename' prints).`,

  grant: `thaddeus grant <did> [--paths a,b] [--max-changes N]

  Grant <did> push access to the repo, scoped to --paths (globs, default **)
  and capped at --max-changes ops (default 1,000,000).`,

  revoke: `thaddeus revoke <did>

  Revoke a delegate's access. Revocation is terminal — issue a fresh identity
  to re-grant.`,

  grants: `thaddeus grants [--json]

  List the repo's active (non-revoked) delegations.`,

  reputation: `thaddeus reputation <did> [--json]

  Show a DID's server-wide reputation: attested (host-vouched) vs claimed
  (self-asserted) contributions, and the attested tally by kind.`,

  serve: `thaddeus serve [--port N] [--data DIR] [--host] [--min-merges N]

  Run a durable Thaddeus server over a FileBackend at --data (default
  ./thaddeus-data) on --port (default 4000). --host makes it an attesting
  instance (co-signs reputation with the operator's identity); --min-merges
  gates land on that many attested merges per op author.`,
};
