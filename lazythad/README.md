# lazythad

A lazygit-style terminal UI for [Thaddeus](https://thaddeus.run) — browse a
remote's repos, the operation log, the signed "why", vetoes, and reputation over
the untrusted HTTP mirror, then query a matching local working copy with `/`.

`lazythad` is a standalone Rust crate (ratatui + crossterm). Because Thaddeus
reads are a public mirror — `GET /repos`, `…/pull`, `/reputation/:did` need no
signature — the browser holds **no keys** and does **no decryption**: it shows
the cleartext metadata (op ids, paths, authors, timestamps, the why, veto
claims) that the server serves to anyone. Decryption-bounded `callers` and
`references` queries are delegated to the installed `thaddeus` CLI; lazythad
never reads an identity seed or implements the capability boundary itself.

## Build & run

```sh
cargo build --release            # → target/release/lazythad
./target/release/lazythad                         # default http://localhost:4000
./target/release/lazythad http://localhost:4055   # a specific remote
```

Point it at a running `thaddeus serve`.

For local query views, launch it from inside a working copy whose repo and
server match the selected remote. Install the `thaddeus` CLI too (the official
installer installs both); set `THADDEUS_BIN=/path/to/thaddeus` to override CLI
discovery.

## Keys

| key            | action                                 |
| -------------- | -------------------------------------- |
| `q` / `Esc`    | quit                                   |
| `Tab`          | switch pane (repos ↔ activity)         |
| `j` / `k`, ↑/↓ | move the selection                     |
| `Enter`        | open the selected repo's log           |
| `t`            | toggle log / releases                  |
| `/`            | open the local query palette           |
| `r`            | refresh remote / rerun active query    |
| `R`            | reputation of the selected op's author |

## Live refresh

Interactive remote views refresh every two seconds in a single-flight background
worker, so remote I/O never blocks keyboard handling or terminal drawing. Fresh
results preserve the selected repo, operation, and release when those records
still exist. A refresh error leaves the last-known-good data on screen, reports
the error in the status line, and retries on the next interval; `r` requests the
same worker to refresh immediately.

Automatic refresh reads the same public repo metadata and ciphertext pull route
as the rest of lazythad. It remains keyless and does not derive semantic events
or ask the server to process plaintext; decryption-bounded semantic views still
run locally through the `thaddeus` CLI.

The query palette accepts:

```text
why <op>
touched-since <ISO>
by <did> [--since <ISO>] [--until <ISO>]
callers <symbol>
references <name>
```

Successful results replace the activity pane and remain navigable with `j`/`k`.
In a query view, `r` reruns the expression and `t` returns to the log. Queries
use the local committed branch: they do not pull or include dirty disk edits.

## Other modes

```sh
lazythad --dump [server]   # print repos + logs as text (no TTY) — scriptable
lazythad --version
lazythad --help
```

## Scope

Read-mostly by design. Remote browsing remains completely keyless; local query
views are a subprocess bridge to `thaddeus query --json`. Vetoes are shown as
**claimed** (signatures are not verified client-side yet — that needs the
ed25519 `did:key` verification the server and TS client do). Actions that write
— `land`, signing a `veto` — need the DID signed-request envelope reimplemented
in Rust, and are a fast-follow.
