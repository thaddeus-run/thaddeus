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

| Command                                        | Description                            |
| ---------------------------------------------- | -------------------------------------- |
| `init`                                         | Create a self-owned `did:key` identity |
| `create <server> <repo>`                       | Create a repo on a server              |
| `clone <server> <repo> [dir]`                  | Clone a repo to a working tree         |
| `status`                                       | Show working-tree changes              |
| `push [--no-land]`                             | Commit + upload + land into `main`     |
| `land`                                         | Land uploaded-but-unmerged commits     |
| `grant <did> [--paths a,b] [--max-changes N]`  | Grant push rights to a DID/agent       |
| `revoke <did>`                                 | Revoke a previously granted delegation |
| `grants`                                       | List active grants for this repo       |
| `serve [--port 4000] [--data ./thaddeus-data]` | Run a durable server                   |

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
