// The one-screen command overview (bare `thaddeus`, `help`, `--help`).
export const USAGE = `thaddeus — the Thaddeus CLI

  thaddeus <command> [args]     run 'thaddeus help <command>' for details

Working tree
  init                          create a self-owned identity
  whoami                        print the current identity's DID
  use    [<url>] [--hosted]     set (or show) your default server
  create <repo> [--server URL]  create a repo on a server
  clone  <repo> [dir] [--server URL]
                                clone a repo to a working tree
  repos  [--mine]               list server repos (--mine = owned by you)
  delete <repo> --yes           delete a repo you own (irreversible)
  pull                          fetch landed changes into this working copy
  branch [<name>]               list branches, or create one here
  workspace <branch> [dir]      open a branch as its own working copy (COW)
  status                        show working-tree changes
  diff   [--staged] [path...]   show a line diff of working-tree changes
  push   [-m "<why>"]           commit + upload (+ a signed why) + land
  land   [<branch>]             land commits — or a branch — under policy

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
  --json                        machine-readable output (read commands)

Hosted server (optional)
  There is an official server at https://ams1.thaddeus.run. It is never set for
  you — opt in with 'thaddeus use --hosted', or point at your own with
  'thaddeus use <url>' (or per command, 'create/clone --server <url>').`;

// Per-command detailed help, shown by `thaddeus <cmd> --help` or
// `thaddeus help <cmd>`. Each entry is a self-contained usage block.
export const HELP: Record<string, string> = {
  init: `thaddeus init [--force]

  Create a self-owned identity (a did:key) under the config home. Idempotent:
  re-running prints the existing DID. --force rotates to a fresh identity.`,

  whoami: `thaddeus whoami [--json]

  Print the current identity's DID (the key every write is signed with).`,

  use: `thaddeus use [<url>] [--hosted] [--clear] [--json]

  Set your default server — the one create/clone use when you don't pass one.
  With no argument, print the current default. --hosted sets the official server
  (https://ams1.thaddeus.run); --clear removes the default. The server is always
  your explicit choice — nothing is pre-filled.`,

  create: `thaddeus create <repo> [--server <url>]

  Create a repo you own on a server. The server is, in order: --server, else a
  leading https:// argument (create <url> <repo>), else your default
  ('thaddeus use'). You become its owner; only you (or a delegate) may push.`,

  clone: `thaddeus clone <repo> [dir] [--server <url>]

  Clone <repo> into [dir] (defaults to the repo's last path segment) from a
  server resolved like 'create' (--server, else a leading https:// argument,
  else your default). Materializes 'main' and records the remote.`,

  repos: `thaddeus repos [--mine] [--server <url>] [--json]

  List the repos on a server (resolved like 'create': --server, else your
  default). --mine shows only repos your identity owns.`,

  delete: `thaddeus delete <repo> [--server <url>] --yes

  Delete a repo you own. Irreversible — there is no undo or GC yet — so --yes is
  required. The server rejects a delete from anyone but the repo's owner.`,

  pull: `thaddeus pull

  Fetch the landed changes on 'main' into this working copy: ingest the ops,
  objects and capabilities, advance the base, and update the files on disk
  (removing what was deleted upstream). Refuses when the working tree is dirty
  or you hold unpublished commits — commit and push (or discard) first.`,

  branch: `thaddeus branch [<name>] [--json]

  With no argument, list the repo's branches and mark this working copy's. With
  a name, create a branch at your current branch's heads. A branch is a name
  over a head-set (copy-on-write) — it copies ids, never files — so creating one
  adds no operations and needs no land policy. Open it in its own directory with
  'thaddeus workspace <name>'; land it back with 'thaddeus land <name>'.`,

  workspace: `thaddeus workspace <branch> [dir]

  Open <branch> as its OWN working copy in [dir] (default: a sibling of this
  working copy, named <copy>-<branch>, e.g. web-feature). Copy-on-write over the origin's object store: the new
  directory holds a config and your files, never a store copy — so working
  copies are cheap and unlimited, the same branch can be open in several at
  once, and nothing ever switches or hijacks an existing tree. There is no
  checkout. (The shared store is single-process: don't run two thaddeus
  commands over it at the same instant.)`,

  status: `thaddeus status [--json]

  Show working-tree changes against the base snapshot (added / modified /
  deleted) and how many commits are unpublished. Files your identity holds no
  decryption capability for are skipped and reported, not an error.`,

  diff: `thaddeus diff [--staged] [path...]

  Show a line-level diff of the working tree against the base snapshot. With
  [path...], limit the diff to those repo paths. --staged diffs the committed-
  but-unpublished ops against the last synced base instead of the disk.`,

  push: `thaddeus push [-m "<why>"] [--no-land]

  Commit the working-tree diff, upload it, and land it on 'main'. -m attaches a
  signed provenance "why" to each published op. --no-land uploads without
  landing (finish later with 'thaddeus land').`,

  land: `thaddeus land [<branch>]

  With no argument: land your already-uploaded but unmerged commits onto the
  current branch, under the server's policy. With a branch: land THAT branch's
  ops into the branch you're on — this is not a 3-way merge and there is no
  merge ceremony; the ops were signed at commit, and landing is one re-point
  gated by policy (conflict, delegation scope, standing veto, any reputation
  floor). A blocked land reports the reason and leaves your branch untouched.`,

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
  and capped at --max-changes ops (default 1,000,000). Also shares the
  decryption capability for every object this working copy can read, so the
  delegate can clone and read the repo — run 'thaddeus pull' first if your copy
  is stale, since you can only share what you can decrypt.`,

  revoke: `thaddeus revoke <did>

  Revoke a delegate's access. Revocation is terminal — issue a fresh identity
  to re-grant. Future pushes stop sharing keys with the revoked did, but content
  already shared with it is NOT recalled (revocation cannot un-read); key
  rotation is a later addition.`,

  grants: `thaddeus grants [--json]

  List the repo's active (non-revoked) delegations.`,

  reputation: `thaddeus reputation <did> [--server <url>] [--json]

  Show a DID's server-wide reputation: attested (host-vouched) vs claimed
  (self-asserted) contributions, and the attested tally by kind. Reputation is
  server-wide, not repo-scoped: the server is resolved like 'repos' (--server,
  else your default), so this works from anywhere — no working copy needed.
  Only an attesting server ('serve --host') co-signs merges, so a non-attesting
  server reports attested: 0.`,

  serve: `thaddeus serve [--port N] [--data DIR] [--host] [--min-merges N]

  Run a durable Thaddeus server over a FileBackend at --data (default
  ./thaddeus-data) on --port (default 4000). --host makes it an attesting
  instance (co-signs reputation with the operator's identity); --min-merges
  gates land on that many attested merges per op author.`,
};
