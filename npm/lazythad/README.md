# @thaddeus.run/lazythad

A lazygit-style terminal UI for [Thaddeus](https://thaddeus.run) (Rust ·
[ratatui](https://ratatui.rs)) — browse a server's repos, the op log, the signed
why, vetoes, and reputation. Distributed as a prebuilt binary. Installs the
`lazythad` command.

```sh
npm i -g @thaddeus.run/lazythad
lazythad http://localhost:4000
```

Installing fetches the `lazythad` binary for your platform from the
[GitHub releases](https://github.com/thaddeus-run/thaddeus/releases) (with a
download-on-first-run fallback). The npm package is just the launcher.

Prefer a single command?
`curl -fsSL https://raw.githubusercontent.com/thaddeus-run/thaddeus/main/install.sh | sh`
installs both `thaddeus` and `lazythad` and sets up your `PATH`.
