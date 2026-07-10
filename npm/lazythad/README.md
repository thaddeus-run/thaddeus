# @thaddeus.run/lazythad

A lazygit-style terminal UI for [Thaddeus](https://thaddeus.run) (Rust ·
[ratatui](https://ratatui.rs)) — browse a server's repos, the op log, the signed
why, vetoes, and reputation. Distributed as a prebuilt binary. Installs the
`lazythad` command.

When launched inside a matching Thaddeus working copy, press `/` to query its
committed history and semantic graph through the separately installed `thaddeus`
CLI (`why`, `touched-since`, `by`, `callers`, and `references`). The official
installer below installs both commands.

Interactive remote views refresh every two seconds in a single-flight background
worker without blocking keyboard input. Lazythad preserves the selected repo,
operation, and release across fresh snapshots and keeps last-known-good data
visible when a refresh fails; press `r` to request an immediate retry. Refreshes
read public metadata and ciphertext pulls only. Semantic derivation remains
local, keyless in lazythad itself, and bounded by the `thaddeus` CLI identity's
decryption capabilities.

```sh
npm i -g @thaddeus.run/lazythad@alpha
lazythad http://localhost:4000
```

Installing fetches the `lazythad` binary for your platform from the
[GitHub releases](https://github.com/thaddeus-run/thaddeus/releases) (with a
download-on-first-run fallback). The npm package is just the launcher.

Prefer a single command?
`curl -fsSL https://raw.githubusercontent.com/thaddeus-run/thaddeus/main/install.sh | sh`
installs both `thaddeus` and `lazythad` and sets up your `PATH`.
