# @thaddeus.run/cli

The **Thaddeus** CLI — `thaddeus` (alias `thad`).

```sh
thaddeus serve --data ./srv-data &       # run a server
thaddeus init                            # create a self-owned identity
thaddeus create http://localhost:4000 me/notes
thaddeus clone http://localhost:4000 me/notes ~/notes
cd ~/notes && echo "# notes" > readme.md && thaddeus push
```

A git-like client over the untrusted remote: edit files on disk, `push` to
publish. All crypto is client-side; your identity seed lives in
`~/.config/thaddeus/`.

## Commands

| Command                                                                  | Description                            |
| ------------------------------------------------------------------------ | -------------------------------------- |
| `init`                                                                   | Create a self-owned `did:key` identity |
| `create <server> <repo>`                                                 | Create a repo on a server              |
| `clone <server> <repo> [dir]`                                            | Clone a repo to a working tree         |
| `status`                                                                 | Show working-tree changes              |
| `push [--no-land]`                                                       | Commit + upload + land into `main`     |
| `land`                                                                   | Land uploaded-but-unmerged commits     |
| `grant <did> [--paths a,b] [--max-changes N] [--max-changes-per-hour N]` | Grant push rights to a DID/agent       |
| `revoke <did>`                                                           | Revoke a previously granted delegation |
| `grants`                                                                 | List active grants for this repo       |
| `policy [set\|clear]`                                                    | Show or select repo land policy        |
| `query <kind> ...`                                                       | Query history and the semantic graph   |
| `watch [symbol] [--kind <event>]...`                                     | Stream remote semantic changes         |
| `schedule-reveal <path> --at <ISO>`                                      | Make committed content public later    |
| `reveal <path>`                                                          | Trigger a due public reveal            |
| `reputation <did>`                                                       | Show trusted/untrusted reputation      |
| `reputation export <did> [--output path]`                                | Export a public reputation archive     |
| `reputation import <path\|->` / `import --from URL`                      | Import or directly copy your archive   |
| `serve [--port 4000] [--data DIR] [--max-request-body-bytes N]`          | Run a durable server                   |

## Server request limits

`thaddeus serve` accepts request bodies through 16 MiB by default. Override the
inclusive limit with `--max-request-body-bytes N`; invalid, non-positive, or
unsafe-integer values stop startup before the listening socket opens. The
container entrypoint exposes the same setting as
`THADDEUS_MAX_REQUEST_BODY_BYTES`.

## Query the committed branch

```sh
thaddeus query why <op>                          # signed provenance
thaddeus query touched-since 2026-07-01          # time-window history
thaddeus query by did:key:z6Mk... --since 2026-07-01
thaddeus query callers refreshToken              # live semantic callers
thaddeus query references refreshToken           # live use sites
```

All query forms accept `--json`. They run locally over the current committed
branch, include only code your identity can decrypt, and never pull, commit, or
include dirty disk edits. `thaddeus why <op>` remains a compatibility alias.

## Watch remote semantic changes

```sh
thaddeus watch [symbol] [--kind <event>]... [--interval <duration>] [--json]
```

`watch` polls this working copy's remote branch. Its initial pull establishes a
silent baseline; later events are one line each in text mode or one
`SemanticEvent` per line in JSON mode (JSONL). Repeat `--kind` to select
`defined`, `removed`, `renamed`, `moved`, or `references-changed`. The optional
symbol may be a current name, stable id, or unique id prefix, and continues to
follow that stable id through signed remote renames. The interval defaults to
`2s` and accepts `ms`, `s`, or `m` durations of at least `100ms`.

The watcher pulls public ciphertext through the existing atomic pull route into
an isolated in-memory mirror. It derives semantic events locally, bounded by the
content your identity can decrypt, and never updates or cleans checked-out files
or the durable working-copy store. Run `thaddeus pull` explicitly when you want
to update the working tree. Transient polling errors are reported and retried;
Ctrl-C exits cleanly.

## Timed public content

```sh
thaddeus schedule-reveal announcement.md --at 2030-01-01T00:00:00Z
thaddeus reveal announcement.md # optional manual trigger; cannot release early
```

The owner creates a future-dated public capability locally; the server stores it
outside ordinary pulls and promotes it automatically when due. A fresh clone can
then read the content without a grant. Because the public identity is
well-known, this opts into trusting the selected host as embargo custodian for
the scheduled file; the current membrane is store-honest, not trustless. These
commands reveal committed file content—the path and operation metadata are
already visible on the ciphertext mirror—and ignore dirty disk edits.

## Collaboration example

```sh
# Owner: grant a teammate scoped push rights on src/**
thaddeus grant did:key:z6Mk… --paths 'src/**'

# Teammate: clone, edit, push — lands because src/ is in scope
thaddeus clone http://localhost:4000 proj ~/proj
cd ~/proj && mkdir -p src && echo "fn main() {}" > src/main.rs && thaddeus push
#   published to main (1 head(s))

# A push outside the granted paths is scope-blocked at land:
echo "oops" > README.md && thaddeus push
#   not landed: README.md is outside …'s delegated scope (content uploaded)

# Owner: revoke to cut off further pushes
thaddeus revoke did:key:z6Mk…
```

> **Status: spike.** Online, full-set sync (see the CLI design spec).
