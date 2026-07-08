# Thaddeus — the CLI + client SDK (design)

**Date:** 2026-06-25 **Status:** Design — pending user review, then
implementation plan **Product:** Thaddeus **Company/monorepo:** Thaddeus
(`@thaddeus.run/*`) **Source of truth (vision):**
`the-new-age-of-source-control.html` **Builds on:**
`docs/specs/2026-06-25-thaddeus-server-design.md` (the HTTP remote) +
`docs/specs/2026-06-25-thaddeus-persistence-design.md` (the durable `Backend`)

> **Naming:** the product is now **Thaddeus** (the working name "Strata" is
> retired). The npm scope `@thaddeus.run/*` is unchanged. Existing docs that
> still say "Thaddeus" are renamed in a separate pass (§11).

---

## 1. Context — why this, why now

The server made Thaddeus reachable over a network; using it still means
hand-rolling `fetch` + signing + bundle encode/decode + ingest + materialize
(the e2e test does exactly that by hand). The CLI turns that into a terminal
tool a human (or agent) actually uses: **`init` → `create` → `clone` → edit
files → `push`** — the day-to-day loop.

It is **infrastructure, not a pillar** — the client half of the API-first
remote. It introduces no new substrate: every byte of crypto stays client-side
(the brief's self-owned identity), and the server is untouched.

## 2. Governing principle — _thin client over a reusable SDK_

Two layers, each with one job:

- **`@thaddeus.run/client`** — a reusable **SDK**: a `Client` that holds an
  `Identity` and speaks the server's HTTP protocol (sign → fetch → bundle →
  ingest). Pure logic, no disk, no terminal — unit-tested in-process against
  `createServer(...).fetch`.
- **`@thaddeus.run/cli`** — the **binary** `thaddeus` (alias `thad`): arg
  parsing, the disk working tree, config I/O, human output — a thin shell over
  the SDK.

The rigid seams: the `Client` method surface, the `.thaddeus/` working-copy
layout, and the `run(argv, env)` CLI entry (injectable for tests). The loose
interiors: output formatting, diff details.

### 2.1 No new substrate

The CLI is pure orchestration over shipped packages:

| Need                        | Reuses                                                                |
| --------------------------- | --------------------------------------------------------------------- |
| protocol (sign, bundle)     | `@thaddeus.run/server` (`signRequest`, `encodeBundle`/`decodeBundle`) |
| local durable working copy  | `@thaddeus.run/persist` (`FileBackend`) + durable `Platform`/`Repo`   |
| commit / materialize / diff | `@thaddeus.run/fs` (`Workspace`), `OpLog.materialize`                 |
| identity (sign, decrypt)    | `@thaddeus.run/identity` (`Identity.fromSeed`)                        |

## 3. The release's job

The client SDK + the `thaddeus` CLI, end to end: identity, repo create, clone to
a disk working tree, edit, status, and publish (commit → upload → land).
Deliverables:

- **`@thaddeus.run/client`**: a `Client` with `createRepo` / `listRepos` /
  `clone` / `push` / `land`; internal request signing; `fetch` injection.
- **`@thaddeus.run/cli`**: the `thaddeus`/`thad` binary — `init`, `create`,
  `clone`, `status`, `push` (`--no-land`), `land`; the `.thaddeus/` working
  copy; `~/.config/thaddeus/` identity; a `run(argv, env)` entry.
- A **demo** (`examples/cli/`) driving the real binary against a live
  `Bun.serve`, plus `ARCHITECTURE.md` + `CHANGELOG.md` updates.

Not the job (deferred, §11): multi-user write / agent-delegation CLI surface;
incremental fetch / offline sync semantics; `log`/`diff`/`--json` output; merge
conflict resolution UX (slice one reports a blocked land); a published-binary
install story; the repo-wide "Strata → Thaddeus" doc rename (separate pass).

## 4. Decisions taken (brainstorm outcomes)

1. **SDK + thin CLI with a real disk working tree.** The full usable loop, not a
   library-only or a working-tree-less slice. The CLI materializes files to disk
   (git-like) so you edit with your own editor.

2. **The local working copy IS a durable `Platform` repo.** `.thaddeus/store` is
   a `FileBackend`; the local repo's objects/ops/views live there (the
   persistence layer). No re-download per command, and the local history is
   real.

3. **`push` = publish to `main`.** One command: commit the disk diff → upload →
   land into `main`. `--no-land` uploads without landing; `land` finishes it. A
   blocked land (conflict) is reported; content stays uploaded.

4. **Single-branch working model.** The local repo has one view, `main`;
   `config.base` records the server `main` heads at last sync. After a
   successful publish, local `main` + `base` fast-forward to the merged heads,
   so disk == local == server and `status` is clean.

5. **Content-compare change detection, no staging area.** `push`/`status`
   compare each working-dir file's bytes to the base-materialized state;
   new/changed → `Workspace.write`, gone → `Workspace.rm`, unchanged → skipped
   (no spurious ops). `.thaddeus/` is ignored.

6. **One global identity from a stored seed.** `init` writes a 32-byte seed
   (`crypto.getRandomValues`) to `~/.config/thaddeus/identity.json`;
   `Identity.fromSeed` reloads it. The repo owner is its creator.
   Single-user-owner writes in slice one (the server is owner-only; a non-owner
   clones the public mirror but cannot push).

7. **`clone` reads the view heads explicitly.** The SDK fetches `/views/<view>`
   alongside `/pull`, so the local view is set from the server's heads — closing
   the deferred "pull infers the frontier" gap from the server review.

8. **Zero-dep arg parsing + in-process testability.** `util.parseArgs`; the CLI
   entry is `run(argv, { cwd, home, fetchImpl })` so commands run in temp dirs
   against an in-process `createServer(...).fetch` — no ports, no subprocess.

## 5. Scope

**In:** `@thaddeus.run/client` (the `Client` SDK); `@thaddeus.run/cli`
(`thaddeus`/ `thad`: `init`/`create`/`clone`/`status`/`push`/`land`,
`.thaddeus/` working copy, `~/.config/thaddeus/` identity); the demo; docs.

**Out (deferred, named):**

- **Multi-user write & agent-delegation CLI** — the substrate supports delegated
  agents (P09); a CLI surface for them is later. Slice one is single-owner.
- **Incremental fetch / offline sync** — slice one pulls the full reachable set
  and publishes online; `since`-fetch and offline conflict semantics are
  deferred.
- **`log` / `diff` / `--json` / richer output** — slice one ships `status` and
  human text.
- **Merge-conflict resolution UX** — a blocked land is reported; resolving it
  (re-pull, three-way) is later (and ties to Pillar 10 review).
- **A published-binary install story** (npm bin, Homebrew, etc.) — run via
  `bun`/`moon` for now.
- **Repo-wide "Strata → Thaddeus" doc rename** — a separate cleanup pass (§11).

## 6. The seam (public API)

### 6.1 `@thaddeus.run/client`

```ts
import type { Backend } from '@thaddeus.run/store';
import type { Identity } from '@thaddeus.run/identity';
import type { Repo } from '@thaddeus.run/platform';

interface PushResult {
  accepted: { objects: number; ops: number; caps: number };
  rejected: { kind: string; id: string; reason: string }[];
}
interface LandOutcome {
  landed: boolean;
  into: string;
  heads: string[];
  reason?: string;
}

class Client {
  // fetchImpl defaults to global fetch; tests pass createServer(...).fetch.
  constructor(server: string, identity: Identity, fetchImpl?: typeof fetch);

  createRepo(name: string): Promise<{ name: string; owner: string }>;
  listRepos(): Promise<string[]>;

  // Pull a view's reachable bundle, ingest into `backend`, and set the local
  // view to the server's reported heads (read from GET /views/<view> — not
  // inferred). Returns the opened local Repo + the heads.
  clone(
    name: string,
    backend: Backend,
    view?: string
  ): Promise<{ repo: Repo; heads: string[] }>;

  // Upload the ops/objects/caps reachable from `heads` (idempotent; the server
  // re-ingest of existing content is a no-op).
  push(name: string, repo: Repo, heads: readonly string[]): Promise<PushResult>;

  // Land uploaded heads into a target view under the server's policy.
  land(
    name: string,
    fromHeads: readonly string[],
    into?: string
  ): Promise<LandOutcome>;
}
```

Signing is internal (each write builds the canonical request and signs with the
held `Identity`). `clone`'s `backend` is caller-supplied (CLI → `FileBackend`;
tests → `MemoryBackend`). The SDK keeps the three protocol verbs separate
(matching the server); the **publish** composition (commit + push + land) lives
in the CLI.

### 6.2 `@thaddeus.run/cli`

```ts
// The injectable entry point — argv plus an environment for testability.
interface CliEnv {
  cwd: string; // working directory (find .thaddeus/ from here)
  home: string; // config root (identity at <home>/.config/thaddeus/)
  fetchImpl?: typeof fetch; // injected in tests; defaults to global fetch
  out?: (line: string) => void; // defaults to console.log
}
function run(argv: readonly string[], env: CliEnv): Promise<number>; // exit code
```

Commands: `init`, `create <server> <repo>`, `clone <server> <repo> [dir]`,
`status`, `push [--no-land]`, `land`. `thad` is the same binary under a second
name.

### 6.3 On-disk layout

```
~/.config/thaddeus/identity.json     { seed: <base64 32 bytes>, did }
<workdir>/
  <materialized files…>               the working tree you edit
  .thaddeus/
    store/                            FileBackend — the local durable repo
    config.json                       { server, repo, base: string[] }   (base = server main heads at last sync)
```

## 7. Data model

No new records. New on-disk artifacts only: the identity seed file and the
per-working-copy `config.json` + `FileBackend` store. The working tree is the
materialization of the local repo's `main` view (`OpLog.materialize` → decrypt
each file via the held identity → write bytes to disk).

## 8. Crypto choices

**None new.** The CLI/SDK hold the `Identity` and do all client-side crypto via
existing packages: `Identity.fromSeed` (load), `signRequest` (sign requests),
`Workspace.commit` (sign ops + encrypt objects), `store.get` (decrypt on
materialize). The seed is generated with `crypto.getRandomValues` (Web Crypto,
not `Math.random`). The seed file is the user's secret — never transmitted; the
server sees only signatures and ciphertext.

## 9. Flows

- **`init`** — if `~/.config/thaddeus/identity.json` is absent, generate a
  32-byte seed, write `{seed, did}`, print the DID; if present, print the
  existing DID (`--force` rotates with a confirmation).
- **`create <server> <repo>`** — load identity → `Client.createRepo` → print
  `{name, owner}`.
- **`clone <server> <repo> [dir]`** — `dir` defaults to the repo's last path
  segment → `Client.clone(repo, new FileBackend(dir/.thaddeus/store))` →
  materialize `main` to `dir` → write `dir/.thaddeus/config.json`
  `{server, repo, base: heads}`.
- **`status`** — find `.thaddeus/`; content-compare the working tree to the
  base-materialized `main` (added / modified / deleted); report "N commit(s) not
  published" if local `main` is ahead of `base`.
- **`push [--no-land]`** — find `.thaddeus/` + config + identity; open the local
  repo; stage the disk diff into a `Workspace` over `main`; if nothing changed
  and not ahead, print "nothing to publish" and exit 0; else `commit` →
  `Client.push(reachable heads)`; unless `--no-land`,
  `Client.land(fromHeads, into: 'main')`; on landed, repoint local `main` +
  update `base` to the merged heads and re-materialize; print accepted counts +
  land result; on a blocked land, print the conflict (content stays uploaded).
- **`land`** — land the local committed-but-unpublished `main` heads into the
  server `main`; update `base`.

## 10. Acceptance criteria (measurable; written test-first)

**SDK (`@thaddeus.run/client`, in-process against `createServer(...).fetch`):**

1. **createRepo** — signed create sets the owner; `listRepos` shows it.
2. **clone conveys heads** — `clone` returns the server's `main` heads read from
   `/views/<view>` (not inferred from the bundle frontier); a fresh local repo
   over a `MemoryBackend` materializes and decrypts the content.
3. **push idempotent** — `push` returns accepted counts; a second identical
   `push` adds nothing and is not an error.
4. **land** — `land` returns `landed:true` and advances the server view; a
   blocked land returns `landed:false` + reason (not a throw).

**CLI (`@thaddeus.run/cli`, via `run(argv, env)` in temp dirs):**

5. **init** — writes a seed + prints a DID; a second `init` is idempotent (same
   DID, no overwrite).
6. **clone materializes** — `create` then `clone` writes the working files to
   disk and a valid `.thaddeus/config.json`.
7. **status** — editing a file shows it `modified`; a new file `added`; a
   deletion `deleted`; after a successful `push`, `status` is clean.
8. **publish round-trip (headline)** — edit a file → `thaddeus push` → a **fresh
   `clone` in another temp dir materializes and decrypts the edit**.
9. **no-op push** — `push` with no changes prints "nothing to publish" and
   creates no op.
10. **two-step publish** — `push --no-land` then `land` works; `status` reports
    "ahead" between them.
11. **non-owner** — a clone under a different identity reads the public mirror
    but `push` fails with a clear not-owner message (exit non-zero).

## 11. Honest limitations (stated, not hidden)

- **Single-user-owner writes.** Only the repo's creator can push (the server's
  owner-only model); no delegated-agent or multi-writer CLI surface yet.
- **Online, full-set sync.** `clone`/`push` talk to a reachable server and move
  the full reachable set; no incremental fetch, no offline queue, no automatic
  re-pull-before-push (a stale local copy surfaces as a blocked land, not an
  auto-merge).
- **No conflict resolution UX.** A blocked land is reported with its reason;
  resolving it (re-clone / three-way) is manual and tied to Pillar 10.
- **Whole-tree diff.** `status`/`push` walk the working tree and compare by
  content; large trees are linear scans (fine for spike-sized repos). No
  `.thaddeusignore` beyond skipping `.thaddeus/` itself.
- **Seed file is the whole secret.** Lose `~/.config/thaddeus/identity.json` and
  the identity is gone (P01's no-recovery posture); the file is plaintext on
  disk.
- **Run via `bun`/`moon`.** No published binary / installer yet.

## 12. Seeded/updated docs

- **`CHANGELOG.md`** — `[Unreleased] → Added`: `@thaddeus.run/client` (the
  client SDK: `createRepo`/`clone`/`push`/`land`, request signing, `fetch`
  injection, clone-reads-heads) and `@thaddeus.run/cli` (the `thaddeus`/`thad`
  binary: the `init`→`create`→`clone`→edit→`push` loop over a `.thaddeus/`
  durable working copy). Note the deferred "client SDK/CLI" item is now shipped;
  the pull-conveys-heads follow-up is closed.
- **`ARCHITECTURE.md`** — after the Server section, a "Client & CLI" note: the
  remote is now driven by a reusable `@thaddeus.run/client` SDK and the
  `thaddeus` CLI with a git-like disk working tree; multi-user/agent CLI,
  offline sync, and conflict UX are next.
- **Naming** — note in both that the product is **Thaddeus** ("Thaddeus"
  retired); a repo-wide rename of remaining "Thaddeus" mentions is a follow-up
  pass.

## 13. Open items / next primitives

- **Repo-wide "Strata → Thaddeus" rename** — sweep `AGENTS.md`, prior specs,
  CHANGELOG, and package READMEs (mechanical; its own small PR).
- **Multi-writer / agent CLI** — surface P09 delegations so an operator can
  grant an agent push rights and an agent can publish under a delegation.
- **Incremental + offline** — `since`-fetch, a local op queue, and
  re-pull-before-publish with a real merge/conflict UX (with Pillar 10).
- **`log` / `diff` / `--json`** — history and machine-readable output for
  agents.
- **A published binary** — install story once the surface stabilizes.
