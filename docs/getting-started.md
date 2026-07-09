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
# pre-alpha publishes to the `alpha` channel, so pin @alpha:
npm i -g @thaddeus.run/cli@alpha @thaddeus.run/lazythad@alpha
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

Leave it running in another terminal (or use a remote you trust). Then save a
default server so you don't repeat it on every command:

```sh
thaddeus use http://localhost:4000    # your default for create/clone
thaddeus use                          # show the current default
```

There's also an **official hosted server** — but it's never set for you; opt in
explicitly if you want it:

```sh
thaddeus use --hosted                 # use https://ams1.thaddeus.run
```

## 4. Create, clone, edit, publish

```sh
thaddeus create acme/web             # you own it (uses your default server)
thaddeus clone  acme/web              # → ./acme/web
# point at a different server just this once with --server https://host
cd acme/web
echo 'fn refresh() {}' > src/auth.rs
thaddeus status                                      # what changed
thaddeus diff                                        # a line diff vs the base
thaddeus push -m "add the token refresh path"        # commit + upload + land, with a signed why
```

The `-m` message becomes a **signed provenance record** bound to the op — the
"why" travels with the code to every clone.

Thaddeus keeps its own ignore file, `.thaddeusignore` — on first use it seeds
one from your `.gitignore` (if present), then reads only `.thaddeusignore`. It
always skips `.git`, `.thaddeus`, and `node_modules`, so `status`/`push` stay
fast and never upload dependency or build trees. Edit `.thaddeusignore` to
change what Thaddeus ignores.

List what's on a server with `thaddeus repos` (`--mine` for repos your identity
owns), and remove one you own with `thaddeus delete <repo> --yes`
(irreversible).

## 5. Read the history and the why

```sh
thaddeus log                       # main, newest-first, with the why per change (⛔ marks a vetoed op)
thaddeus log --since 2026-07-01    # filter by the op's signed timestamp
thaddeus why <op>                  # the signed why for one op (id prefix from `log`)
```

Every read verb also has `--json` for scripting or a TUI.

## 6. Collaborate with someone else

Reads are **decryption-bounded**: the server only ever holds ciphertext, and you
can read exactly what your identity holds a capability for. So sharing a repo
means sharing _keys_, not just permissions — `grant` does both:

```sh
# owner, inside the working copy:
thaddeus grant did:key:z6Mk…               # write access AND the read capability
```

The collaborator can then clone, read, edit and publish; every `push` re-wraps
its new objects for all members, so the owner can read their work too:

```sh
# collaborator:
thaddeus clone acme/web && cd web
echo 'fn login() {}' >> src/auth.rs
thaddeus push -m "add login"

# owner: fetch their landed work into the existing checkout
thaddeus pull
```

`thaddeus pull` fast-forwards a **clean** working copy (commit and push your own
work first). Files you hold no key for are skipped and reported by `status`, not
an error. `thaddeus revoke <did>` rotates readable repo objects and stops fresh
clones from receiving those keys; it still cannot un-read plaintext someone
already saw.

> **Secrets are first-class.** Because objects are encrypted before they leave
> your machine, you can version a `.env` and share it only with the DIDs you
> choose. `.thaddeusignore` is seeded from `.gitignore`, which usually ignores
> `.env` — un-ignore it with a `!.env` line to track it.

## 7. Branches are free — and you never switch

A branch is a **name over a head-set**, not a copy of files. And a working copy
is a cheap, **copy-on-write view** over one shared object store — so you don't
_switch_ branches, you open each one in its own directory. There is no
`checkout`, no clean-tree dance, and no `git worktree` misery: the same branch
can be open in several directories at once, and nothing ever hijacks your tree.

```sh
thaddeus branch                   # list branches, * marks this copy's
thaddeus branch feature           # create one at your current heads (free)
thaddeus workspace feature        # open it as its own directory (../web-feature)
cd ../web-feature
echo 'fn login() {}' > src/auth.rs
thaddeus push -m "add login"      # lands on `feature`; main's copy untouched

cd ../web                         # your main working copy, exactly as you left it
thaddeus land feature             # land the branch into main, under policy
```

The workspace directory holds a config and your files — **never a second object
store** — which is why it's instant. Creating a branch adds **no operations**,
so it needs no policy. **Landing** one does: there is no merge ceremony — the
ops were signed at commit, and `land` is one re-point gated by the server's
policy (conflict, delegation scope, standing veto, any reputation floor). A
blocked land leaves your branch untouched.

## 8. Meaning layers

- **Veto (a standing human "no"):** a reviewer blocks a landing, even a green
  one. `thaddeus veto <op> -m "ships a secret"`; list with
  `thaddeus vetoes <op>`. A verified veto blocks the next land, durably.
- **Reputation (attested contributions):** against an attesting server
  (`serve --host`), a landed op mints a host-vouched merge for its author.
  `thaddeus reputation <did>`.
- **Repo policy:** owners can select durable land gates without restarting the
  server. `thaddeus policy` shows the active record;
  `thaddeus policy set --protect 'src/auth/**' --allow did:key:z6Mk...` protects
  paths; `--require-provenance`, `--require-checks ci`, `--forbid-deletes`, and
  `--forbid-paths 'secrets/**'` add the other built-in gates.
  `thaddeus policy clear` restores the default conflict-only policy.
- **Rename as a first-class op:** `thaddeus rename oldName newName -m "why"`
  rewrites the code as one signed `SymbolOp`; `thaddeus history <symbol>` shows
  the rename chain.
- **Delegation:** grant an agent scoped, budgeted push access —
  `thaddeus grant <did> --paths 'src/**' --max-changes 50`; `thaddeus grants`;
  `thaddeus revoke <did>`.

## 9. Browse it in a TUI

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
