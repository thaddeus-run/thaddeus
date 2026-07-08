# @thaddeus.run/cli

The [Thaddeus](https://thaddeus.run) CLI — a post-Git, agent-native
source-control substrate — distributed as a prebuilt binary. Installs the
`thaddeus` (and `thad`) command.

```sh
npm i -g @thaddeus.run/cli@alpha
thaddeus --version
thaddeus help
```

Installing fetches the `thaddeus` binary for your platform from the
[GitHub releases](https://github.com/thaddeus-run/thaddeus/releases) (with a
download-on-first-run fallback if install scripts are disabled). No Bun or Node
is needed at runtime — the binary is self-contained; the npm package is just the
launcher.

Prefer a single command?
`curl -fsSL https://raw.githubusercontent.com/thaddeus-run/thaddeus/main/install.sh | sh`
installs both `thaddeus` and `lazythad` and sets up your `PATH`.

See the
[getting-started guide](https://github.com/thaddeus-run/thaddeus/blob/main/docs/getting-started.md).
