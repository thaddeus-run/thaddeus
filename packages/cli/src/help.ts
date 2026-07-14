// The one-screen command overview (bare `thaddeus`, `help`, `--help`).
export const USAGE = `thaddeus — the Thaddeus CLI

  thaddeus <command> [args]     run 'thaddeus help <command>' for details

Working tree
  init                          create a self-owned identity
  whoami                        print the current identity's DID
  use    [<url>] [--hosted]     set (or show) your default server
  create <repo> [--server URL]  create a repo on a server
  clone  <repo> [dir] [--server URL] [--owner DID]
                                clone a repo to a working tree
  repos  [--mine]               list server repos (--mine = owned by you)
  delete <repo> --yes           delete a repo you own (irreversible)
  pull [--bootstrap-head]       fetch verified landed changes into this copy
  watch  [symbol]               stream remote semantic changes without pulling files
  branch [<name>]               list branches, or owner-create one here
  workspace <branch> [dir]      open a branch as its own working copy (COW)
  status                        show working-tree changes
  show   [--view B] [path...]   inspect a committed view without touching files
  diff   [--staged] [path...]   show line diffs (or --from/--to views)
  push   [-m "<why>"]           commit + upload; owner-sign the shared head
  land   [<branch>] [--dry-run] owner-land commits or a branch under policy

History & meaning
  log    [--since D] [--until D]  main's history with the why per change
  query  <kind> ...               query why, history, callers, and references
  why    <op>                     alias for 'query why <op>'
  veto   <op> [-m "<reason>"]     lodge a standing veto that blocks a land
  vetoes <op>                     list the standing vetoes on one op
  rename <old> <new> [-m "<why>"] rename a symbol as one signed SymbolOp
  history <symbol>                a symbol's signed rename chain
  release <tag>                   sign immutable server-history metadata
  releases [tag]                  list releases or show one

Access & trust
  grant  <did> [--paths a,b] [--max-changes N]  grant push to a DID/agent
  revoke <did>                                  revoke a grant and rotate keys
  grants                                        list active grants
  policy [set|clear]                            show or select repo land policy
  reputation <did>|export|import                inspect or move reputation
  schedule-reveal <path> --at <ISO>             make committed content public later
  reveal <path>                                 trigger a due public reveal now

Server
  serve  [--port N] [--data DIR] [--attestation-aws-kms-key-arn ARN]  run a server

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
  ('thaddeus use'). You become its owner and sign the empty 'main' head.
  Delegates may upload signed operations, but only you can sign shared heads.`,

  clone: `thaddeus clone <repo> [dir] [--server <url>] [--owner <did>]

  Clone <repo> into [dir] (defaults to the repo's last path segment) from a
  server resolved like 'create' (--server, else a leading https:// argument,
  else your default). The complete owner-signed head chain and exact operation
  closure are verified before anything is accepted. --owner checks an owner DID
  learned out of band; without it, the first valid owner is pinned on first use.`,

  repos: `thaddeus repos [--mine] [--server <url>] [--json]

  List the repos on a server (resolved like 'create': --server, else your
  default). --mine shows only repos your identity owns.`,

  delete: `thaddeus delete <repo> [--server <url>] --yes

  Delete a repo you own. Irreversible — there is no undo or GC yet — so --yes is
  required. The server rejects a delete from anyone but the repo's owner.`,

  pull: `thaddeus pull [--bootstrap-head]

  Verify the complete owner-signed head chain and exact operation closure, then
  fetch landed changes into this working copy and update files on disk. Refuses
  rollback, a conflicting history, withheld operations, a dirty tree, or local
  unpublished commits.

  --bootstrap-head migrates an unsigned legacy branch. It is owner-only, refuses
  an existing signed history, requires a clean/not-ahead copy, and signs this
  copy's saved base as version 0 before continuing with a normal verified pull.`,

  watch: `thaddeus watch [symbol] [--kind <event>]... [--interval <duration>] [--json]

  Stream semantic changes from this working copy's remote branch. The initial
  pull is a silent baseline. Events are defined, removed, renamed, moved, and
  references-changed; repeat --kind to filter them. An optional symbol may be a
  current name, stable id, or unique id prefix and keeps following renames.

  --interval accepts ms, s, or m (default 2s, minimum 100ms). --json emits one
  SemanticEvent per line (JSONL); diagnostics use stderr. The watcher uses an
  isolated in-memory mirror and never changes checked-out files, branch heads,
  saved base, config, or the durable local store. Run 'thaddeus pull' explicitly
  to update files. Ctrl-C exits cleanly.`,

  branch: `thaddeus branch [<name>] [--json]

  With no argument, list the repo's branches and mark this working copy's. With
  a name, the repository owner creates a branch at the current branch's heads.
  A branch is a name
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

  show: `thaddeus show [--view <branch>] [--json] [path...]

  Inspect committed content without touching the working tree. With no --view,
  reads this working copy's current branch. With --view, fetches that remote
  branch into an internal read-only cache view, never into a real branch view.
  With no path, lists readable files. With paths, prints text content and
  reports binary files by size. Missing or unreadable requested paths exit 1.`,

  diff: `thaddeus diff [--staged] [path...]
thaddeus diff [--from <branch>] [--to <branch>] [path...] [--json]

  Show a line-level diff of the working tree against the base snapshot. With
  [path...], limit the diff to those repo paths. --staged diffs the committed-
  but-unpublished ops against the last synced base instead of the disk.
  --from/--to diff committed branch views without touching files; an omitted
  side means this working copy's current branch. --staged cannot be combined
  with --from/--to.`,

  push: `thaddeus push [-m "<why>"] [--no-land]

  Commit the working-tree diff, upload it, and land it on 'main'. -m attaches a
  signed provenance "why" to each uploaded op. --no-land uploads without
  landing. Shared heads require the repository owner's signature: a delegate's
  automatic landing stops after upload and prints the uploaded head IDs for the
  owner; it never claims the change was published.`,

  land: `thaddeus land [<branch>] [--dry-run] [--json]

  Owner-only. With no argument: sign and land your already-uploaded but unmerged
  commits onto the current branch, under server policy. With a branch: land THAT branch's
  ops into the branch you're on — this is not a 3-way merge and there is no
  merge ceremony; the ops were signed at commit, and landing is one owner-signed
  monotonic head update gated by policy (conflict, delegation scope, standing
  veto, any reputation floor). A blocked land persists no head update.
  --dry-run previews a branch land locally — incoming ops and conflicts — without
  requiring a clean tree, calling server land, re-pointing, or writing files.`,

  log: `thaddeus log [--since <ISO>] [--until <ISO>] [--json]

  Show 'main' history newest-first with the signed why per change and a ⛔
  marker for a vetoed op. --since/--until filter by the op's signed timestamp
  (op.at), inclusive, compared as instants (any ISO 8601 form, e.g.
  2026-07-01 or 2026-07-01T12:00:00+02:00).`,

  why: `thaddeus why <op> [--json]

  Compatibility alias for 'thaddeus query why <op>'. Show the signed provenance
  for one op on the current branch (resolved by id prefix), each record labelled
  [verified] or [unverified].`,

  query: `thaddeus query why <op> [--json]
thaddeus query touched-since <ISO> [--json]
thaddeus query by <did> [--since <ISO>] [--until <ISO>] [--json]
thaddeus query callers <symbol> [--json]
thaddeus query references <name> [--json]

  Interrogate the current working copy's committed branch through CodeDB. The
  command is local and read-only: it does not pull, commit, or include dirty disk
  edits. History queries are current-branch-only and newest-first; time bounds
  are inclusive ISO-8601 instants. callers accepts a current name, full symbol
  id, or unique id prefix. references accepts a current symbol name. Semantic
  answers include only content your identity can decrypt.`,

  'schedule-reveal': `thaddeus schedule-reveal <path> --at <ISO> [--json]

  Schedule one committed file's content for public release. The client wraps
  its content key to the well-known public identity and sends that signed,
  future-dated capability; the server persists it outside normal pull responses
  and promotes it automatically when its clock reaches --at. Because the public
  identity is well-known, this trusts the host not to release the file early.
  Owner-only.

  This reveals file content, not hidden history: paths and operation metadata
  are already public on the ciphertext mirror. Dirty disk edits are ignored.`,

  reveal: `thaddeus reveal <path> [--json]

  Manually trigger a scheduled reveal for one committed file. The server uses
  its own trusted clock, so calling this early leaves the content private.
  Normal servers also scan for due reveals automatically. Owner-only.`,

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

  release: `thaddeus release <tag> [--view <branch>] [--notes <text>]
                         [--notes-file <path>] [--artifact <path>]...
                         [--artifact-uri <name=uri,sha256=<hex>>]... [--json]

  Create an immutable signed release over the server's current committed view.
  The default view is this working copy's branch (or main). Dirty files and
  local-only operations are ignored. --artifact hashes a local file and stores
  only its name, content-addressed SHA-256 URN, digest, and size; bytes are never
  uploaded.
  --artifact-uri records externally hosted metadata with a required SHA-256.`,

  releases: `thaddeus releases [tag] [--json]

  List immutable releases newest-first, or show one release with its signer,
  view snapshot, notes, and artifact metadata. JSON signatures are base64.`,

  grant: `thaddeus grant <did> [--paths a,b] [--max-changes N] [--max-changes-per-hour N]

  Grant <did> push access to the repo, scoped to --paths (globs, default **)
  and capped at --max-changes ops (default 1,000,000). Also shares the
  decryption capability for every object this working copy can read, so the
  delegate can clone and read the repo — run 'thaddeus pull' first if your copy
  is stale, since you can only share what you can decrypt.
  Delegates upload signed operations but cannot create branches or sign shared
  landings; the owner reviews their uploaded head IDs and signs the landing.
  --max-changes-per-hour caps how many delegate-authored ops the owner may land
  within any trailing hour (default: no hourly cap).`,

  revoke: `thaddeus revoke <did>

  Revoke a delegate's access. Revocation is terminal — issue a fresh identity
  to re-grant. Revoke fetches the current branch into an internal inspect view,
  rotates every readable object to a new content key, uploads the recalled
  ciphertexts/caps, and quarantines the DID on the server under one repo lock.
  Fresh clones no longer receive keys for recalled content; plaintext already
  read before revoke cannot be un-read.`,

  grants: `thaddeus grants [--json]

  List the repo's active (non-revoked) delegations.`,

  policy: `thaddeus policy [--json]
thaddeus policy set [--require-provenance] [--require-checks ci,proof]
                    [--protect globs --allow dids]
                    [--forbid-deletes] [--forbid-paths globs]
                    [--release-creators owner|delegates|allowList]
                    [--release-allow dids] [--json]
thaddeus policy clear [--json]

  Show or owner-select this repo's land policy. 'set' overwrites the whole
  policy from explicit flags; 'clear' restores the default conflict-only policy.
  --require-provenance requires every incoming op to carry a verified why.
  --require-checks requires a verified provenance record from one of the named
  checker actor kinds (default examples: ci, proof). --protect blocks changes
  to protected path globs unless authored by --allow dids; when --allow is
  omitted, your DID is allowed. --forbid-deletes and --forbid-paths add typed
  standing queries. Release creation is owner-only by default; delegates admits
  active non-revoked delegates, while allowList admits the named DIDs. Changes
  take effect on the next land or release; no server restart.`,

  reputation: `thaddeus reputation <did> [--server <url>] [--json]
  thaddeus reputation export <did> [--server <url>] [--output <path>]
  thaddeus reputation import <path|-> [--server <url>] [--json]
  thaddeus reputation import --from <source-url> [--server <destination>] [--json]

  Show a DID's server-wide reputation: all trusted-host proofs, unique counted
  events, valid but untrusted-host proofs, claimed contributions, and the
  counted tally by kind.
  Export writes a public versioned JSON proof archive to stdout (or --output).
  Import reads a file or '-' from stdin; --from copies your current identity's
  archive directly between instances. Only the archive subject may import it.
  Reputation is
  server-wide, not repo-scoped: the server is resolved like 'repos' (--server,
  else your default), so this works from anywhere — no working copy needed.
  Only an attesting server co-signs eligible events. Production uses
  --attestation-aws-kms-key-arn; --host loads a local private seed and is for
  development only. A non-attesting server reports attested: 0.`,

  serve: `thaddeus serve [--port N] [--data DIR] [--attestation-aws-kms-key-arn <exact-key-arn>] [--attestation-rate-limit <0..20>] [--host] [--min-merges N] [--trust-host <did> ...] [--max-request-body-bytes N] [--replay-nonce-capacity N] [--request-skew-ms N]

  Run a durable Thaddeus server over a FileBackend at --data (default
  ./thaddeus-data) on --port (default 4000). Production attestation uses an
  exact AWS KMS Ed25519 key ARN; startup validates KMS before binding. --host
  is mutually exclusive and development-only because it loads the operator's
  local private signing seed. --attestation-rate-limit sets the subject-wide
  rolling-hour issuance cap (default/max 20; 0 disables issuance).
  --min-merges gates land on unique trusted merge events per op author.
  --trust-host is repeatable and forms an exact foreign-host DID allowlist;
  the active attester DID is trusted automatically and trust is not transitive.
  --replay-nonce-capacity bounds live durable signed-request nonces (default
  100000, maximum 1000000). --request-skew-ms narrows accepted timestamp skew
  from the protocol maximum/default of 300000 ms.
  --max-request-body-bytes sets the inclusive request-body limit (default
  16777216, or 16 MiB) and must be a positive integer no greater than
  Number.MAX_SAFE_INTEGER - 1.`,
};
