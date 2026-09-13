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
thaddeus identity init            # writes a seed to ~/.config/thaddeus/
thaddeus whoami                   # prints your did:key
```

## 3. Run a server (or point at one)

A Thaddeus server normally holds no decryption keys: it verifies what it ingests
and serves ciphertext. Timed reveals are the explicit exception—the chosen host
is trusted to honor the embargo for scheduled files. Run one locally over a
durable directory outside your project:

```sh
thaddeus serve --port 4000 --data /tmp/thaddeus-demo-server
# add --host to make it attest reputation; --min-merges N to gate landings
```

Leave it running in another terminal (or use a remote you trust). Then save a
default server so you don't repeat it on every command:

```sh
thaddeus use http://localhost:4000    # your default for init/create/clone
thaddeus use                          # show the current default
```

There's also an **official hosted server** — but it's never set for you; opt in
explicitly if you want it:

```sh
thaddeus use --hosted                 # use https://ams1.thaddeus.run
```

## 4. Adopt your project and publish

Start in the directory containing your existing project. The identity created in
step 2 signs the new repository. Nothing moves to another directory.

```sh
thaddeus init acme/web              # uses your saved default server
# Or: thaddeus init acme/web --server http://localhost:4000
thaddeus status                    # existing included files appear as added
thaddeus diff
thaddeus push -m "initial import"  # commit, upload and land the first change
```

`init <name>` requires an existing identity and an explicitly selected server.
It creates empty signed `main` and local `.thaddeus` metadata; it does not
commit or upload your source files. Bare `thaddeus init` no longer creates an
identity. Use `thaddeus identity init` for that, and
`thaddeus identity init --force` only when you intend to replace your identity.

The `-m` message becomes a signed provenance record bound to the operation. A
fresh clone carries both the code and its explanation:

```sh
thaddeus clone acme/web ../web-check
```

The destination is explicit here. Without a destination, `clone acme/web`
creates `./web`. Existing `create` and `clone` commands remain available when
you want to create the remote separately.

Init prints its ignore source and included file count. It uses the root
`.thaddeusignore` unchanged, or seeds one from the root `.gitignore` when
present. Later changes to `.gitignore` do not update the seed. With neither
file, init creates neither. Unreadable or non-regular ignore inputs stop
initialization.

The matcher reads root-level rules only. It supports glob patterns and negation,
but does not implement all Git ignore syntax or read nested ignore files. `.git`
and `.thaddeus` metadata are excluded, including Git worktree marker files;
`node_modules` directories are always pruned. Other build trees need an ignore
rule. `.env` is included unless your rules exclude it. Review `status` and edit
`.thaddeusignore` before pushing.

An empty directory initializes with clean status. Empty subdirectories, symlinks
and special files stay on disk but are not tracked. Init preserves existing file
bytes and modes; this does not add executable-mode or symlink tracking to
clones.

Repeating init with the same repository, server and identity succeeds without
network access. It refuses another repository at that root, enclosing or nested
working copies, and fresh remote name collisions. A `.thaddeus/bin` installation
can coexist with repository metadata; unknown stores and symlinked metadata
cannot be adopted.

On failure, init removes only working-copy artifacts belonging to its attempt.
It never changes your identity or deletes a remote repository. If remote
creation succeeded or its response was lost, init retains a recovery record in
`~/.config/thaddeus/init/` and prints the exact retry command. Retry in the same
directory with the same identity and server. Recovery accepts only your empty,
version-zero remote. If it has changed, clone into a separate directory and
reconcile your source files. An active init lock blocks another invocation;
stale locks are recovered only when the recorded process is confirmed absent.
Unknown locks or changed artifacts require inspection, not `--force`.

List what's on a server with `thaddeus repos` (`--mine` for repos your identity
owns), and remove one you own with `thaddeus delete <repo> --yes`
(irreversible).

## 5. Read the history and the why

```sh
thaddeus log                       # main, newest-first, with the why per change (⛔ marks a vetoed op)
thaddeus log --since 2026-07-01    # filter by the op's signed timestamp
thaddeus query why <op>            # the signed why for one op (id prefix from `log`)
thaddeus query touched-since 2026-07-01
thaddeus query by did:key:z6Mk... --since 2026-07-01
thaddeus query callers refreshToken
thaddeus query references refreshToken
```

`thaddeus why <op>` remains a compatibility alias. Every query also has `--json`
for scripting or a TUI. Queries use the current committed branch and are
local/read-only: they do not pull, commit, or include dirty disk edits.

### Watch remote semantic changes

```sh
thaddeus watch [symbol] [--kind <event>]... [--interval <duration>] [--json]
```

The initial remote pull is a silent baseline. Later text events are
line-oriented; `--json` emits JSONL with one `SemanticEvent` per line. A symbol
filter may be a current name, full stable id, or unique id prefix and follows
that id through signed renames. Repeat `--kind` to select `defined`, `removed`,
`renamed`, `moved`, or `references-changed`; the polling interval defaults to
`2s` and accepts `ms`, `s`, or `m` durations of at least `100ms`.

Watching is observer-only. It polls the existing atomic public-ciphertext pull
route into an isolated in-memory mirror, derives semantic differences locally
within your identity's decryption boundary, and never updates or cleans the
working tree or durable working-copy store. Run `thaddeus pull` explicitly to
update files. Transient polling errors retry, and Ctrl-C exits cleanly.

## 6. Collaborate with someone else

Reads are **decryption-bounded**: the server only ever holds ciphertext, and you
can read exactly what your identity holds a capability for. So sharing a repo
means sharing _keys_, not just permissions — `grant` does both:

```sh
# owner, inside the working copy:
thaddeus grant did:key:z6Mk…               # write access AND the read capability
```

Add `--max-changes-per-hour N` to also bound how many ops the agent may land
within any trailing hour; the lifetime `--max-changes` cap still applies.

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
  `thaddeus reputation <did>`. Take those public proofs with you using
  `thaddeus reputation export <did> --output reputation.json`, then import them
  as that identity with
  `thaddeus reputation import reputation.json --server <destination>` (or copy
  directly with `--from <source>`). A destination keeps valid foreign proofs but
  counts only host DIDs its operator configured with repeatable
  `serve --trust-host <did>`.
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
- **Timed public content:** an owner can run
  `thaddeus schedule-reveal announcement.md --at 2030-01-01T00:00:00Z`. The
  server withholds the wrapped public capability from pulls, then publishes it
  automatically when due; `thaddeus reveal announcement.md` is an optional
  manual trigger that still obeys the server clock. This reveals the committed
  file content (dirty edits are ignored); its path and operation metadata were
  already visible on the ciphertext mirror. Because the public identity is
  well-known, scheduling opts into trusting that host not to unwrap or publish
  the capability early; this membrane is store-honest, not trustless.

## 9. Browse it in a TUI

[`lazythad`](../lazythad/README.md) is a lazygit-style terminal UI over a
server's public mirror (repos, the op log, the why, vetoes, reputation):

```sh
cargo build --release --manifest-path lazythad/Cargo.toml
./lazythad/target/release/lazythad http://localhost:4000
```

Launch lazythad from inside the matching working copy and press `/` for the same
`why`, time, author, caller, and reference queries in a navigable TUI view.
Remote metadata refreshes every two seconds in a single-flight background
worker, preserving the current selection and last-known-good data without
blocking the terminal loop. Refresh errors stay visible and retry on the next
interval. In log and release views, `r` requests an immediate refresh; in a
query view it reruns the active expression. With a reputation overlay open, `r`
only dismisses that modal overlay.

## Where to go next

- `thaddeus help <command>` for any verb's details.
- [ARCHITECTURE.md](../ARCHITECTURE.md) for how the substrate fits together.
- [CONTRIBUTING.md](../CONTRIBUTING.md) to build and hack on it.
