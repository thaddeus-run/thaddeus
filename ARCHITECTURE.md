# Thaddeus — Architecture & convergence spine

Thaddeus builds the Thaddeus substrate **one primitive at a time**, releasing
each as a standalone npm package, while this document keeps the separately-built
pieces converging into one system. There is no "dumb primitive + smart platform"
seam: the packages compose; Thaddeus is their composition.

## Shared primitives (reused, not duplicated)

| Primitive                             | Package                  | Reused by                                               |
| ------------------------------------- | ------------------------ | ------------------------------------------------------- |
| Identity (`did:key`)                  | `@thaddeus.run/identity` | P01 caps · P04 provenance · P07 reputation · P09 agents |
| Object (encrypted, content-addressed) | `@thaddeus.run/store`    | P01 · P02 membrane · P03 snapshots · P11 query          |
| Capability (sealed key)               | `@thaddeus.run/store`    | P01 · P02 reveal · P09 revocation                       |
| Op (operation log entry)              | `@thaddeus.run/log`      | P03 · P04 · P05 · P06 · P08 · P10 · P11 query           |
| Head (owner-signed shared view)       | `@thaddeus.run/log`      | P03 · platform · server · client                        |

## Build order (each tier depends only on tiers below)

- **Tier 0 — Foundation:** `@thaddeus.run/identity`, `@thaddeus.run/store` (P01)
- **Tier 1 — Spine:** membrane/time (P02), operation log (P03)
- **Tier 2 — Why + surface:** provenance (P04), virtual FS (P05), platform (P06)
- **Tier 3 — Home + authors:** identity federation/reputation (P07), agents
  (P09)
- **Tier 4 — Meaning + governance:** semantic graph (P08), review (P10), live DB
  (P11)

## North-star flow (the continuous integration test)

`integration/test/one-edit-end-to-end.test.ts` runs the brief's "one edit, end
to end": write → snapshot → Op → provenance → policy → mirror. Tier 0 is real;
higher pillars are `test.todo`. After each primitive ships, one `test.todo`
becomes a real assertion. When the last stub is gone, the substrate is whole.

## Status / traceability

| Pillar                                | Package              | Status | Resolves         |
| ------------------------------------- | -------------------- | ------ | ---------------- |
| 01 Encrypted objects + capabilities   | `identity` + `store` | built  | P1 P2 P4 P18 P21 |
| 02 Membrane (time-varying visibility) | `store`              | built  | P2 P4            |
| 03 Operation log                      | `log`                | built  | P5 P6 P12        |
| 04 Provenance ("why")                 | `provenance`         | built  | P12              |
| 05 Virtual FS                         | `fs`                 | built  | P6 P7 P8 P11     |
| 06 Platform                           | `platform`           | built  | P9 P10 P11       |
| 07 Identity federation / reputation   | `reputation`         | built  | P13 P19 P20      |
| 08 Semantic graph                     | `graph`              | built  | P14 P5 P18       |
| 09 Agents as principals               | `agent`              | built  | P16 P3 P21       |
| 10 Review as policy                   | `review`             | built  | P15 P12          |
| 11 Live database                      | `query` + `watch`    | built  | P17 P10          |

## Persistence (infrastructure, not a pillar)

The substrate is now optionally **durable** behind a pluggable `Backend`
(`@thaddeus.run/persist`: `FileBackend`, `MemoryBackend`). `Store` and `OpLog`
take an optional backend (hot-cache write-through + static `open`/`load`); with
none, behavior is unchanged. `Platform.createDurable`/`openDurable` compose a
backend-backed repo, so **a repo survives a process restart** — the code.store
"in-memory writes, cold storage" split. `HeadStore` retains every owner-signed
shared-view update as a contiguous versioned chain with no unsigned current
pointer. Other signed-record-log persistence ships too (provenance, veto,
reputation, symbol-ops — see the Server section). SQLite/S3 backends,
compaction/GC, and a Git gateway are the next steps.

## Server (infrastructure, not a pillar)

The durable `Platform` is reachable over HTTP via `@thaddeus.run/server` — a
`Bun.serve` remote that is **untrusted** (no keys, verifies-don't-trust, serves
ciphertext): reads are a public mirror, writes are signed, and shared-view
authority is owner-signed and policy-gated. Every public view exposes a complete
monotonic `HeadRecord` chain. The server cannot use raw view pointers as public
authority, and it refuses to serve a pull unless its operation bundle is exactly
the current signed head's reachable closure. Delegates may upload signed
operations, but only the repository owner can create a shared branch or sign a
landing. Signed mutations bind a random nonce into the request signature;
single-node durable replay state rejects reuse throughout the five-minute
timestamp window. The server is otherwise stateless over the shared `Backend`,
so a node restart serves the same repos. It now carries **and persists the whole
substrate** — not just code (P01 objects, P03 ops) but the meaning around it:
the signed "why" (P04), the standing human veto (P10), server-wide reputation
(P07), and semantic-graph ops (P08), each write-through under its own
content-addressed key and rebuilt on load.

The server may **optionally attest** successful merge and release events. Its
trust set is an exact DID allowlist: configured foreign hosts plus the active
local or KMS attester, with no recursive or transitive trust. Portable archives
retain every valid proof for audit, but reputation gates count one deterministic
proof per `(subject, repo, kind, ref)` event. A merge earns no host proof when
the operation author owns the target repository, and all issuance shares a
durable per-subject rolling-hour ceiling of 20. These checks make simple replay,
multi-host duplication, and owner farming ineffective; they do not prevent
colluding trusted hosts or Sybil identities. The proof schema cannot reconstruct
historical repository ownership independently, so an allowed host remains
trusted to have enforced issuance policy at the time.

Production attestation uses AWS KMS. The process never receives private signing
key bytes, although its short-lived IAM authorization can request signatures and
is therefore security-sensitive. The compatibility `serve --host` path does load
a private seed and is development-only. Ordinary content hosting still has no
repository decryption keys. Timed reveal remains the deliberate exception
described below: it temporarily handles a deliberately publishable content key
using a world-known public seed. Multi-node concurrency, dynamic federation
discovery, and the Git gateway are the next steps.

Timed reveal is the deliberate exception to that normal trust boundary. An owner
uploads a public-wrapped capability before its start time so the server can
release it while the owner is offline. Since the public identity is well-known,
the selected host is trusted as embargo custodian for that scheduled file.
Ordinary pulls cannot release it early, but a dishonest host can; a trustless
unattended reveal requires the deferred time-lock design.

## Client & CLI (infrastructure, not a pillar)

The remote is driven by a reusable `@thaddeus.run/client` SDK (a `Client`
holding a self-owned identity: `createRepo`/`clone`/`push`/`land`, all crypto
client-side) and the **`thaddeus`** CLI (`@thaddeus.run/cli`, alias `thad`) — a
git-like client with a `.thaddeus/` durable working tree. Clone uses an explicit
expected owner or trust on first use, then every pull verifies the complete
signed chain against its durable pin and checks the exact operation closure
before moving a view. The server is runnable in one command via
**`thaddeus serve`**. The remote is multi-writer for operation upload: the owner
delegates scoped, budgeted push to other DIDs/agents via P09 `Delegation`s
(`thaddeus grant`/`revoke`/`grants`); the server evaluates `delegationPolicy`
over those authors when the owner signs a landing. Delegates cannot
independently advance shared heads. Offline sync and conflict UX are next.

## Per-primitive loop

read `ARCHITECTURE.md` → brainstorm → spec (`docs/specs/`) → plan
(`docs/plans/`) → build (TDD) → extend the north-star flow → update
`CHANGELOG.md` + this table.
