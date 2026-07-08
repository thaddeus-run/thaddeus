# Getting started with Thaddeus

Thaddeus is a post-Git, agent-native source-control substrate: encrypted,
content-addressed objects; a signed operation log; a signed "why" behind every
change; merge as policy (proofs, reputation, a human veto) instead of a person
reading a diff. This guide takes you from install to your first published,
explained change in a few minutes.

> **Pre-alpha.** Interfaces still move. Everything here is real and tested, but
> not yet stable.

## 1. Install the CLI

The CLI ships as a self-contained binary (`thaddeus`, aliased `thad`) — no
runtime dependency. The TUI (`lazythad`) ships the same way.

**Install script** (recommended — installs both and sets up your `PATH`):

```sh
curl -fsSL https://raw.githubusercontent.com/thaddeus-run/thaddeus/main/install.sh | sh
```

**npm:**

```sh
npm i -g @thaddeus.run/cli @thaddeus.run/lazythad   # each fetches the prebuilt binary
```

**Manual:** download the binary for your platform from the
[releases page](https://github.com/thaddeus-run/thaddeus/releases) and put it on
your `PATH`.

**From source** (needs [Bun](https://bun.sh)):

```sh
git clone https://github.com/thaddeus-run/thaddeus
cd thaddeus && bun install
CI= moon run cli:compile          # → packages/cli/release/thaddeus
```

Check it:

```sh
thaddeus --version
thaddeus help                     # command overview; `thaddeus help <cmd>` for one
```

## 2. Create your identity

Every write is signed by a self-owned `did:key` — no account, no server trust.

```sh
thaddeus init                     # writes a seed to ~/.config/thaddeus/
thaddeus whoami                   # prints your did:key
```

## 3. Run a server (or point at one)

A Thaddeus server is untrusted: it holds no keys, verifies what it ingests, and
serves ciphertext. Run one locally over a durable directory:

```sh
thaddeus serve --port 4000 --data ./thaddeus-data
# add --host to make it attest reputation; --min-merges N to gate landings
```

Leave it running in another terminal (or use a remote you trust).

## 4. Create, clone, edit, publish

```sh
thaddeus create http://localhost:4000 acme/web      # you own it
thaddeus clone  http://localhost:4000 acme/web       # → ./acme/web
cd acme/web
echo 'fn refresh() {}' > src/auth.rs
thaddeus status                                      # what changed
thaddeus diff                                        # a line diff vs the base
thaddeus push -m "add the token refresh path"        # commit + upload + land, with a signed why
```

The `-m` message becomes a **signed provenance record** bound to the op — the
"why" travels with the code to every clone.

## 5. Read the history and the why

```sh
thaddeus log                       # main, newest-first, with the why per change (⛔ marks a vetoed op)
thaddeus log --since 2026-07-01    # filter by the op's signed timestamp
thaddeus why <op>                  # the signed why for one op (id prefix from `log`)
```

Every read verb also has `--json` for scripting or a TUI.

## 6. Meaning layers

- **Veto (a standing human "no"):** a reviewer blocks a landing, even a green
  one. `thaddeus veto <op> -m "ships a secret"`; list with
  `thaddeus vetoes <op>`. A verified veto blocks the next land, durably.
- **Reputation (attested contributions):** against an attesting server
  (`serve --host`), a landed op mints a host-vouched merge for its author.
  `thaddeus reputation <did>`.
- **Rename as a first-class op:** `thaddeus rename oldName newName -m "why"`
  rewrites the code as one signed `SymbolOp`; `thaddeus history <symbol>` shows
  the rename chain.
- **Delegation:** grant an agent scoped, budgeted push access —
  `thaddeus grant <did> --paths 'src/**' --max-changes 50`; `thaddeus grants`;
  `thaddeus revoke <did>`.

## 7. Browse it in a TUI

[`lazythad`](../lazythad/README.md) is a lazygit-style terminal UI over a
server's public mirror (repos, the op log, the why, vetoes, reputation):

```sh
cargo build --release --manifest-path lazythad/Cargo.toml
./lazythad/target/release/lazythad http://localhost:4000
```

## Where to go next

- `thaddeus help <command>` for any verb's details.
- [ARCHITECTURE.md](../ARCHITECTURE.md) for how the substrate fits together.
- [CONTRIBUTING.md](../CONTRIBUTING.md) to build and hack on it.
