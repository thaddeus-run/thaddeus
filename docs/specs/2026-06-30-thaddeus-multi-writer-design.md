# Thaddeus — multi-writer collaboration (delegated push over P09) — design

**Date:** 2026-06-30 **Status:** Design — pending user review, then
implementation plan **Product:** Thaddeus **Company/monorepo:** Thaddeus
(`@thaddeus.run/*`) **Source of truth (vision):**
`the-new-age-of-source-control.html`, Pillar 09 (agents as principals) **Builds
on:** `docs/specs/2026-06-25-thaddeus-pillar-09-agents-design.md` (the
`Delegation`/`AgentRegistry`/`delegationPolicy`),
`docs/specs/2026-06-25-thaddeus-server-design.md` (the HTTP remote),
`docs/specs/2026-06-30-thaddeus-runnable-polish-design.md`

---

## 1. Context — why this, why now

The remote is owner-only: a repo's creator is its sole writer. That is the
single biggest functional gap for a _real_ source control — no teammates, no
agents. The substrate already solved the hard part in Pillar 09: an
operator-signed **`Delegation`** grants a `did:key` scoped, budgeted authority,
an `AgentRegistry` enforces it, and `delegationPolicy` is a fail-closed
`LandPolicy`. What is missing is the **wire + durability**: getting delegations
to the server, persisting them, and widening the gate so a delegate can push and
land.

This release delivers that. It is the payoff of P09's "agents as first-class
principals" over the network — and a `did:key` is a `did:key`, so the same
mechanism serves a human teammate and an autonomous agent identically.

## 2. Governing principle — _the wire over P09, fail-closed_

No new substrate primitives. The enforcement (`delegationPolicy`), the records
(`Delegation`), and the registry (`AgentRegistry`) are P09's; this release adds
the network endpoints, the durable registry, the gate widening, and the CLI. The
rigid calls: the **owner is exempt** from delegation (unrestricted), every other
writer is gated **per incoming op** by paths + `maxChanges`, the registry is
**durable** (survives restart), and revocation is **terminal**.

### 2.1 No new substrate primitive

| Need                         | Reuses                                                                   |
| ---------------------------- | ------------------------------------------------------------------------ |
| the grant record             | `@thaddeus.run/agent` `Delegation` + `signDelegation`/`verifyDelegation` |
| enforcement (scope/budget)   | `delegationPolicy(registry, exempt?)` (one additive `exempt` param)      |
| the registry                 | `AgentRegistry` (register/revoke/usage/record) — made durable per repo   |
| wire transport (byte fields) | the persistence `encodeRecord`/`decodeRecord` codec                      |
| the request envelope         | the server's existing signed-request headers                             |

## 3. The release's job

Across four layers, no new primitive:

- **`@thaddeus.run/agent`** — `delegationPolicy(registry, exempt?)` gains an
  optional `exempt: (author: string) => boolean` predicate (owner exemption).
- **`@thaddeus.run/server`** — a **durable per-repo `AgentRegistry`**;
  `POST …/grants`, `POST …/revoke`, `GET …/grants`; push/land gate widened to
  **owner-or-delegate**; land enforces
  `all(basePolicy, delegationPolicy(registry, ownerExempt))` and **records**
  delegate usage durably.
- **`@thaddeus.run/client`** — `grant` / `revoke` / `listGrants`.
- **`@thaddeus.run/cli`** — `thaddeus grant <did> [--paths] [--max-changes]`,
  `thaddeus revoke <did>`, `thaddeus grants`.
- A **demo** + `CHANGELOG.md`/`ARCHITECTURE.md`/CLI-README updates.

Not the job (deferred, §11): the **`maxSpend` cost model** (recorded `spend` is
`0`; the field/meter ride along — `maxChanges` is the enforced budget);
sub-delegation chains (a delegate granting another); per-hour rate windows /
delegation expiry (`not_after`); a reputation-tiered auto-grant (Pillar 10);
read-ACLs (reads stay a public mirror).

## 4. Decisions taken (brainstorm outcomes)

1. **Full P09 enforcement: paths + change-budget.** The owner grants a signed,
   path-scoped, change-budgeted `Delegation`; the server enforces paths and
   `maxChanges` at land. (`maxSpend` is carried and metered, but with no cost
   model recorded `spend` is `0` — decision 5.)

2. **Owner is exempt; everyone else is per-op gated.** `delegationPolicy` gains
   an `exempt` predicate so an op authored by the repo owner bypasses
   delegation; the owner is the unrestricted writer. Every non-owner op must
   clear paths + budget or the whole land is rejected (fail-closed, P09).

3. **The registry is durable per repo.** The server persists each delegation
   (`grant/<agent>`), revocation (`revoked/<agent>`), and usage meter
   (`meter/<agent>`) in the repo's scoped backend and rebuilds the
   `AgentRegistry` on first touch / restart. (The registry was in-memory — this
   is the main new work.)

4. **Record-after-land keeps the policy read-only.** `delegationPolicy` only
   _reads_ the meter; the server _records_ each delegate's landed-op count
   **after** a land allows, then persists the meter. The meter accumulates
   across lands and survives restart.

5. **`maxSpend` is present but `spend = 0`.** With no substrate cost model,
   recorded spend is `0`, so `maxSpend` never blocks and `maxChanges` is the
   enforced budget. The signed `Delegation` still carries `maxSpend` and the
   meter plumbing is durable — ready for a future cost model — so the
   wire/record format does not change when one lands.

6. **`grant`/`revoke` are owner-only; reads are public.** Only the repo owner
   may authorize/revoke (the request is owner-signed AND the delegation's
   `operator` must equal the owner). `GET /grants` is public — delegations are
   signed public records anyone can verify, like the ciphertext mirror.

7. **Revocation is terminal.** No un-revoke (P09): a compromised agent is
   replaced with a fresh `did:key`, not resurrected.

## 5. Scope

**In:** the `exempt` param (agent); the durable registry, the
`grants`/`revoke`/`grants` endpoints, the gate widening, and record-after-land
(server); `grant`/`revoke`/`listGrants` (client); `grant`/`revoke`/`grants`
(cli); a demo; docs.

**Out (deferred, named):** the `maxSpend` cost model; sub-delegation chains;
per-hour rate windows / `not_after` expiry; reputation-tier auto-grant (P10);
read-ACLs; a grant-management UI beyond the three CLI verbs.

## 6. The seam (public API)

### 6.1 `@thaddeus.run/agent` (one additive change)

```ts
// exempt: authors that bypass delegation entirely (e.g. the repo owner). An op
// whose author satisfies exempt is allowed without a delegation; every other
// op's author must be delegated, in path-scope, and under maxChanges. Default:
// no exemptions (unchanged behavior).
export function delegationPolicy(
  registry: AgentRegistry,
  exempt?: (author: string) => boolean
): LandPolicy;
```

### 6.2 `@thaddeus.run/server` — endpoints

```
POST /repos/:name/grants   (owner-signed)  body: <encoded Delegation>   → 200 { agent, paths, maxChanges, maxSpend }
POST /repos/:name/revoke   (owner-signed)  body: { agent: string }      → 200 { agent, revoked: true }
GET  /repos/:name/grants                   (public)                     → { grants: <encoded Delegation>[] }
```

- **grant:** verify request signer `=== meta.owner` (else 403); decode the
  `Delegation`; verify `d.operator === meta.owner` (else 403 — only the owner
  authorizes their repo) and `verifyDelegation(d)` (else 400); then
  `registry.register(d)` and persist `grant/<d.agent>`. Re-grant replaces (P09).
- **revoke:** owner-signed; `registry.revoke(agent)` + persist
  `revoked/<agent>`.
- **GET grants:** the registry's active (non-revoked) delegations, encoded.

Bodies carrying a `Delegation` use the persistence `encodeRecord`/`decodeRecord`
(base64 byte fields), like the push bundle.

### 6.3 `@thaddeus.run/server` — gate, policy, metering

- **Push/land gate** (both handlers):
  `signer === meta.owner || (registry.delegationFor(signer) !== undefined && !registry.isRevoked(signer))`
  — else 403.
- **Land policy:**
  `all(config.policy ?? blockOnConflict, delegationPolicy(registry, (a) => a === meta.owner))`,
  where `all(...policies)` allows only if every policy allows (first reject
  wins, with its reason).
- **Record-after-land:** capture `priorIntoHeads = repo.log.heads(into)` before
  `repo.land(...)`; on `landed: true`, compute the incoming ops
  (`closure(fromHeads) \ closure(priorIntoHeads)`), group by author, and for
  each **non-owner** author `registry.record(author, count, 0)` + persist
  `meter/<author>` = `registry.usage(author)`.
- **Durable registry:** a `Map<repoName, AgentRegistry>`; on first touch, build
  from the scoped backend — `list('grant/')` → register; `list('meter/')` →
  `record(agent, changes, spend)` once (seed accumulated usage);
  `list('revoked/')` → revoke. All per-repo mutations stay under the existing
  per-repo async lock.

### 6.4 `@thaddeus.run/client`

```ts
class Client {
  grant(
    name: string,
    delegation: Delegation
  ): Promise<{
    agent: string;
    paths: string[];
    maxChanges: number;
    maxSpend: number;
  }>;
  revoke(
    name: string,
    agent: string
  ): Promise<{ agent: string; revoked: boolean }>;
  listGrants(name: string): Promise<Delegation[]>;
}
```

A delegate's existing `clone`/`push`/`land` are unchanged — the delegate is now
an authorized signer.

### 6.5 `@thaddeus.run/cli`

```
thaddeus grant  <did> [--paths 'src/**,docs/**'] [--max-changes N]   owner grants push (signs a Delegation)
thaddeus revoke <did>                                                owner revokes
thaddeus grants                                                      list active grants
```

Run from a working copy (server+repo from `.thaddeus/config`, owner identity
from `~/.config/thaddeus`). `grant` builds
`signDelegation({ agent: did, paths (default ['**']), maxChanges (default a large constant), maxSpend (default a large constant) }, ownerIdentity)`
and posts it.

## 7. Data model

No new domain records (`Delegation` is P09's). New persisted, per-repo,
backend-scoped items:

```
grant/<agentDid>    → Delegation        (the signed grant; write-on-grant, replace-on-regrant)
revoked/<agentDid>  → true              (terminal)
meter/<agentDid>    → { changes, spend } (accumulated usage; written after each land)
```

These live in the same scoped namespace as the repo's `obj`/`op`/`view`/`meta`.

## 8. Crypto choices

**None new.** Delegations are signed by the operator (`signDelegation`, P09) and
verified with public DIDs (`verifyDelegation`); the grant/revoke requests use
the server's existing signed-request envelope; the server holds no key and reads
no plaintext. A grant is a public signed record; a delegate's ops are still
`verifyOp`-checked on ingest.

## 9. The collaboration story

```
# owner (identity A), in a working copy of acme/web:
thaddeus grant did:key:zB --paths 'src/**' --max-changes 100

# teammate / agent (identity B):
thaddeus clone http://host acme/web ~/web && cd ~/web
echo 'fn f() {}' > src/x.rs && thaddeus push      # in scope → lands
echo 'x'        > docs/y.md && thaddeus push      # out of scope → land rejected (content uploaded)

# owner, later:
thaddeus revoke did:key:zB                         # B can no longer land
```

## 10. Acceptance criteria (measurable; written test-first)

**Agent (`delegationPolicy` exempt):**

1. With `exempt = (a) => a === owner`, an owner-authored op passes with no
   delegation; a non-owner op still requires a valid in-scope delegation.

**Server / SDK (in-process against `createServer(...).fetch`):**

2. **grant + list** — owner-signed `grant` registers a delegation; `GET /grants`
   returns it (signature verifies); a non-owner `grant` → 403; a delegation
   whose `operator ≠ owner` → 403.
3. **delegate push + land (in scope)** — B (delegated `src/**`) pushes a `src/…`
   op and lands it (`landed: true`).
4. **out of scope** — B pushes a `docs/…` op; land → `landed: false` with an
   out-of-scope reason; the op is uploaded but not on `main`.
5. **budget** — B granted `maxChanges: 2` lands two ops across two lands; a
   third → `landed: false` over-budget.
6. **revoke** — after `revoke`, B's land → rejected (revoked); the push gate
   also rejects B.
7. **owner unaffected** — the owner lands ops on any path regardless of
   delegations (exempt).
8. **durable** — a fresh `createServer` over the same backend still enforces the
   grant, the accumulated meter, and the revocation.

**CLI (headline, via `run` over a live `startServer`):**

9. owner `grant`s teammate B `--paths 'src/**'`; B clones, edits `src/x` →
   `push` lands; B edits `docs/y` → `push` reports the land rejected; owner
   `revoke`s B → B's `push` fails with a clear message; `thaddeus grants` lists
   the active grant.

**No-regression:**

10. Owner-only repos (no delegations) behave exactly as before; existing
    `agent`/`server`/`client`/`cli` suites stay green.

## 11. Honest limitations (stated, not hidden)

- **`maxSpend` is not yet enforced** — recorded `spend` is `0` (no cost model);
  `maxChanges` is the enforced budget. The field + durable meter ride along.
- **No sub-delegation** — only the owner grants; a delegate cannot re-delegate.
- **No expiry / rate window** — a grant is valid until revoked; per-hour rate
  and `not_after` need a wall-clock policy (deferred).
- **Revocation is terminal and not retroactive** — it blocks _future_ lands; ops
  a delegate already landed remain (you replace the agent, you don't rewrite
  history).
- **Reads stay a public mirror** — delegation gates _writes_; anyone can still
  pull ciphertext and read the public `GET /grants`.
- **Single server.** Multi-node consistency of the registry/meter is the
  existing single-process posture.

## 12. Seeded/updated docs

- **`CHANGELOG.md`** — Added: multi-writer collaboration — owner-signed P09
  delegations over the wire (`grant`/`revoke`/`grants`), a durable per-repo
  `AgentRegistry`, push/land widened to owner-or-delegate, and land enforcing
  paths + `maxChanges` per op (owner exempt). Note `maxSpend` deferred.
- **`ARCHITECTURE.md`** — a "Multi-writer" note in the Client & CLI / Server
  section: delegated push via P09, durable registry, fail-closed at land.
- **`packages/cli/README.md`** — the `grant`/`revoke`/`grants` verbs + a
  collaboration example.

## 13. Open items / next primitives

- **`maxSpend` cost model** — define a per-change cost (bytes? ops? a priced
  attestation, P09→later) so `maxSpend` becomes a real budget.
- **Pillar 10 — review-as-policy** — reputation-tier gates, test/proof gates,
  the human veto over the same `LandPolicy` seam; a high-reputation delegate's
  change could merge under a richer policy.
- **Sub-delegation + expiry** — delegation chains and `not_after` / rate
  windows.
- **Federation of grants** — sharing delegations/reputation across instances.
