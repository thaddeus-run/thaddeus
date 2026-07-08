# Thaddeus — runnable polish: `thaddeus serve` + atomic pull + rename (design)

**Date:** 2026-06-30 **Status:** Design — pending user review, then
implementation plan **Product:** Thaddeus **Company/monorepo:** Thaddeus
(`@thaddeus.run/*`) **Builds on:**
`docs/specs/2026-06-25-thaddeus-cli-design.md` (the client SDK + CLI) +
`docs/specs/2026-06-25-thaddeus-server-design.md` (the HTTP remote)

---

## 1. Context — why this, why now

The single-user spine is complete and merged: substrate → persistence → server →
client SDK + CLI. Three small loose ends keep it from being _cleanly_ runnable,
all flagged as deferred during the recent PRs:

- **No `thaddeus serve`.** Running a server today means hand-rolling a
  `Bun.serve` launcher (the user hit this directly when asking "how do I use
  it").
- **The clone TOCTOU.** `Client.clone` reads `GET /views` and `GET /pull`
  separately; a concurrent land between them could split the snapshot (both PR
  #12 bots flagged it; resolution was deferred to a server-side atomic pull).
- **The product was renamed Strata → Thaddeus** during the CLI work;
  forward-facing docs still say "Thaddeus".

This release closes all three. It is **infrastructure polish, not a pillar** —
no new substrate, the server gains only additive response fields, and the rename
is mechanical.

## 2. Governing principle — _small, additive, testable_

Each piece is a thin addition over shipped seams: `serve` wraps the existing
`createServer` + `Bun.serve`; the atomic pull is an **additive** change to one
response shape; the rename touches only forward-facing text. The rigid choices:
`startServer` is factored so `serve` is testable without leaking a port from
`run()`, and the pull response extension is additive (old readers unaffected).

## 3. The release's job

Three deliverables:

- **`thaddeus serve`** — an exported, testable `startServer(...)` + a `serve`
  CLI command that runs a durable server over a `FileBackend`.
- **Atomic `GET /pull`** — the pull response carries
  `{ view, heads, ...bundle }`; `Client.clone` reads heads from it in a single
  request (closing the TOCTOU).
- **Strata → Thaddeus rename** (forward-facing) — package READMEs/comments,
  `AGENTS.md` naming, `ARCHITECTURE.md`, current `CHANGELOG.md`; historical
  `docs/specs` + `docs/plans` are left as dated artifacts.

Not the job (deferred): TLS, daemonization/process-management, request logging
beyond a startup line, a configurable-policy CLI surface (the default
`blockOnConflict` only), `--since`/incremental pull, and any rewrite of
historical design docs.

## 4. Decisions taken (brainstorm outcomes)

1. **`serve` lives in the CLI**, factored as a testable `startServer`. The CLI
   is the umbrella tool a user already has; `@thaddeus.run/server` becomes a
   **runtime** dependency of `@thaddeus.run/cli` (it was a devDependency). The
   command blocks (awaits indefinitely) so the process stays up; a `SIGINT`
   handler stops the server and exits 0.

2. **The atomic pull is additive.** The pull handler returns
   `{ view, heads, ...encodeBundle(...) }`. Existing consumers that read
   `{ ops, objects, caps }` are unaffected (`decodeBundle` ignores the extra
   fields). `Client.clone` reads `heads` from the pull response and **drops**
   the separate `GET /views` call — one request, one consistent snapshot. The
   standalone `GET /views/:view` endpoint stays (it has other callers and is a
   cheap heads-only read).

3. **Rename forward-facing only.** Historical specs/plans recorded "Thaddeus
   (working name)" accurately for their date; rewriting them is churn that
   muddies git history. `AGENTS.md` is updated to declare the product is
   **Thaddeus** (Thaddeus retired) while keeping the `@thaddeus.run/*`
   package-naming guidance.

## 5. Scope

**In:** `startServer` + `thaddeus serve` (CLI); the additive pull response + the
`Client.clone` single-read simplification; the forward-facing rename; tests;
`CHANGELOG.md`/`ARCHITECTURE.md`/CLI-README updates.

**Out (deferred, named):** TLS / auth tokens / deployment / daemonization;
request logging; a `--policy` CLI flag (default policy only); incremental /
`--since` pull; rewriting historical design docs; multi-node concerns.

## 6. The seam (public API delta)

### 6.1 `@thaddeus.run/cli` — `startServer` + `serve`

```ts
import type { LandPolicy } from '@thaddeus.run/platform';

export interface ServeOptions {
  dataDir: string; // FileBackend root
  port?: number; // default 4000; 0 = OS-assigned (tests)
  policy?: LandPolicy; // default blockOnConflict
}
export interface RunningServer {
  url: string; // http://localhost:<port>
  port: number; // the resolved (possibly OS-assigned) port
  stop(): Promise<void>; // releases the port
}

// Start a durable Thaddeus server over a FileBackend at dataDir. Testable: bind
// port 0, fetch against `url`, then `stop()`. Does NOT block.
export function startServer(opts: ServeOptions): RunningServer;
```

The `serve` command (`run(['serve', …])`): parse `--port` (default `4000`) and
`--data <dir>` (default `./thaddeus-data`);
`const s = startServer({ port, dataDir })`; print
`thaddeus serving on ${s.url} (data: ${dataDir})`; install
`process.on('SIGINT', async () => { await s.stop(); process.exit(0); })`; then
`await new Promise(() => {})` so the process stays up. (Under normal operation
the `serve` command never returns; it runs until interrupted.)

### 6.2 `@thaddeus.run/server` — atomic pull

The `pull` handler's response changes from `encodeBundle(ops, objects, caps)`
to:

```ts
return json(200, {
  view,
  heads: [...repo.log.heads(view)],
  ...encodeBundle(ops, objects, caps), // ops, objects, caps
});
```

Additive: `{ view, heads, ops, objects, caps }`. No other endpoint changes.

### 6.3 `@thaddeus.run/client` — single-read clone

`Client.clone` no longer fetches `GET /views`; it reads `heads` from the pull
response:

```ts
const res = await this.#fetch(
  new Request(`${this.#server}/repos/${enc(name)}/pull?view=${enc(view)}`)
);
const body = (await this.#ok(res)) as { heads: string[] } & Parameters<
  typeof decodeBundle
>[0];
const bundle = decodeBundle(body);
// …ingest objects then ops…
await repo.log.repoint(view, body.heads);
return { repo, heads: body.heads };
```

Behaviorally identical for a quiescent repo; race-free under a concurrent land
(one request = one revision).

## 7. Data model

No new records. The pull response gains two derived fields (`view`, `heads`);
the on-disk and wire record formats are unchanged. `serve` introduces no new
persisted state beyond the `FileBackend` the server already uses.

## 8. Crypto choices

**None new.** `serve` runs the existing untrusted server (no keys, ciphertext
only); the atomic pull serves the same ciphertext bundle plus cleartext head ids
(op ids are already public). The rename is text only.

## 9. The runnable story

After this release, the documented usage (CLI README) is:

```
thaddeus serve --data ./srv-data &       # in one terminal
thaddeus init
thaddeus create http://localhost:4000 me/notes
thaddeus clone http://localhost:4000 me/notes ~/notes
cd ~/notes && echo "# notes" > readme.md && thaddeus push
```

No hand-rolled launcher.

## 10. Acceptance criteria (measurable; written test-first)

1. **`startServer` serves** — `startServer({ dataDir: <tmp>, port: 0 })` returns
   a `RunningServer`; `fetch(`${url}/repos`)` → `200 { repos: [] }`; `stop()`
   resolves and the port is released.
2. **Full CLI flow over a live port** — against a `startServer` instance: `init`
   → `create` → `clone` → edit → `push` publishes, and a fresh `clone` reads the
   file back (real HTTP, real port).
3. **`serve` SIGINT** — (unit-level where feasible) `stop()` releases the port
   so a second `startServer` on the same fixed port succeeds; the `serve`
   command wires `stop()` to SIGINT.
4. **Pull is atomic** — `GET /pull?view=main` returns
   `{ view, heads, ops, objects, caps }`; `heads` equals `GET /views/main`'s
   heads for the same repo.
5. **`clone` is one request** — `Client.clone` makes a single GET to `/pull` (no
   `/views` call) and still returns the server's heads and a repo that
   materializes + decrypts the content. (Asserted via a counting/fake fetch that
   records exactly one request path.)
6. **No-regression** — existing `server`/`client`/`cli` suites stay green; the
   additive pull fields don't break `decodeBundle` or any existing reader.
7. **Rename complete + scoped** — `grep -r Thaddeus` over forward-facing files
   (package `README.md`s, `src/**` comments, `AGENTS.md`, `ARCHITECTURE.md`,
   `CHANGELOG.md`) returns nothing; `AGENTS.md` declares the product is
   Thaddeus; `docs/specs` + `docs/plans` are unchanged (historical).

## 11. Honest limitations (stated, not hidden)

- **`serve` is a foreground spike server.** No TLS, no daemonization, no
  structured logging, no graceful drain beyond `stop()`; single process (the
  server's existing posture). Run it under your own process supervisor for real
  use.
- **Default policy only.** `serve` uses `blockOnConflict`; choosing
  `requireVerifiedProvenance` / a delegation policy from the CLI is deferred.
- **Atomic pull, not atomic clone-vs-future-push.** One pull is a consistent
  revision; it does not subscribe to later changes (no live updates) — re-clone
  or re-pull to refresh.
- **Rename is forward-facing.** Historical specs/plans still say "Thaddeus";
  that is intentional (dated records).

## 12. Seeded/updated docs

- **`packages/cli/README.md`** — the usage block uses `thaddeus serve`; rename
  Strata → Thaddeus.
- **`CHANGELOG.md`** — `[Unreleased] → Added`: `thaddeus serve` (run a durable
  server in one command) and the atomic `GET /pull` (`{view, heads, …bundle}`,
  closing the clone TOCTOU); note the forward-facing Strata → Thaddeus rename.
- **`ARCHITECTURE.md`** — note `thaddeus serve` in the Client & CLI section;
  Strata → Thaddeus.
- **`AGENTS.md`** — naming section: product is **Thaddeus** (Thaddeus retired);
  packages stay `@thaddeus.run/*`.

## 13. Open items / next primitives

- **Multi-writer collaboration** — expose P09 delegations on the server so an
  owner grants push to other DIDs/agents (the biggest functional unlock,
  deferred).
- **Pillar 10 — review-as-policy** — real merge gates over the `LandPolicy`
  seam.
- **`serve` hardening** — TLS, logging, supervision, a `--policy` flag — once
  the surface stabilizes.
