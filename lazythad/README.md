# lazythad

A lazygit-style terminal UI for [Thaddeus](https://thaddeus.run) — browse a
remote's repos, the operation log, the signed "why", vetoes, and reputation over
the untrusted HTTP mirror.

`lazythad` is a standalone Rust crate (ratatui + crossterm). Because Thaddeus
reads are a public mirror — `GET /repos`, `…/pull`, `/reputation/:did` need no
signature — the browser holds **no keys** and does **no decryption**: it shows
the cleartext metadata (op ids, paths, authors, timestamps, the why, veto
claims) that the server serves to anyone.

## Build & run

```sh
cargo build --release            # → target/release/lazythad
./target/release/lazythad                         # default http://localhost:4000
./target/release/lazythad http://localhost:4055   # a specific remote
```

Point it at a running `thaddeus serve`.

## Keys

| key            | action                                 |
| -------------- | -------------------------------------- |
| `q` / `Esc`    | quit                                   |
| `Tab`          | switch pane (repos ↔ log)              |
| `j` / `k`, ↑/↓ | move the selection                     |
| `Enter`        | open the selected repo's log           |
| `r`            | refresh from the remote                |
| `R`            | reputation of the selected op's author |

## Other modes

```sh
lazythad --dump [server]   # print repos + logs as text (no TTY) — scriptable
lazythad --version
lazythad --help
```

## Scope

Read-mostly by design. Vetoes are shown as **claimed** (signatures are not
verified client-side yet — that needs the ed25519 `did:key` verification the
server and TS client do). Actions that write — `land`, signing a `veto` — need
the DID signed-request envelope reimplemented in Rust, and are a fast-follow.
