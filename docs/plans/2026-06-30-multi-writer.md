# Multi-writer collaboration (delegated push over P09) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a repo owner grant push/land rights to other DIDs and agents — a
durable, owner-signed P09 `Delegation` enforced (paths + `maxChanges`) at land,
revocable, with the owner exempt.

**Architecture:** Pure wire + durability over Pillar 09: `delegationPolicy`
gains an owner-`exempt` predicate; the server holds a **durable per-repo
`AgentRegistry`** (persist `grant`/`revoked`/`meter`, rebuild on open), adds
`grants`/`revoke` endpoints, widens push/land to owner-or-delegate, runs
`all(basePolicy, delegationPolicy(registry, ownerExempt))`, and records delegate
usage after a land. The client/CLI add `grant`/`revoke`/`grants`.

**Tech Stack:** TypeScript (ESM), Bun (`bun:test`), moon, tsdown. Reuses
`agent`/`server`/`client`/`cli`/`platform`/`persist`. No new third-party deps.

## Global Constraints

- **Spec:** `docs/specs/2026-06-30-thaddeus-multi-writer-design.md` is the
  source of truth.
- **No new substrate primitive.** Reuse P09's `Delegation` / `signDelegation` /
  `verifyDelegation` / `AgentRegistry` / `delegationPolicy`. The only agent
  change is an additive `exempt` param.
- **Owner exempt; everyone else per-op gated.** An op authored by `meta.owner`
  bypasses delegation; every other op's author must be non-revoked,
  in-path-scope, and under `maxChanges`, else the whole land is rejected
  (fail-closed).
- **Durable registry.** Persist `grant/<agent>` (the signed `Delegation`),
  `revoked/<agent>` (terminal), `meter/<agent>` (`{changes, spend}`) in the
  repo's scoped backend; rebuild the `AgentRegistry` on first touch / restart.
- **Record-after-land keeps the policy read-only.** The server records each
  delegate's landed-op count AFTER a land allows, then persists the meter.
- **`maxSpend` is carried but `spend` recorded is `0`** (no cost model) —
  `maxChanges` is the enforced budget. Default `maxSpend` is a large constant so
  the retrospective spend check never blocks.
- **grant/revoke owner-only** (request owner-signed AND
  `delegation.operator === owner`); `GET /grants` is public. Revocation is
  terminal (no un-revoke).
- **New runtime deps:** `@thaddeus.run/agent` → `server` (runtime) and `cli`
  (runtime, for `signDelegation`); `@thaddeus.run/agent` → `client` (type only,
  for the `Delegation` type).
- **Tooling:** `bun` only; `moon run <project>:<task>`; `AGENT=1` for tests;
  Conventional Commits 1.0.0; trailing newlines; `isolatedDeclarations: true`.
  Port-binding tests use `CI=`. No `Math.random`. No dynamic `import()` in
  shipped src. `.rejects.toThrow()` forbidden (use try/catch or
  `expectRejects`).
- **Verification baseline:** `moon run root:format root:lint` + affected
  `moonx <project>:typecheck` and `moonx <project>:test`.

---

### Task 1: `delegationPolicy(registry, exempt?)` — owner exemption

**Files:**

- Modify: `packages/agent/src/policy.ts`
- Test: `packages/agent/test/policy.test.ts`

**Interfaces:**

- Produces:
  `delegationPolicy(registry: AgentRegistry, exempt?: (author: string) => boolean): LandPolicy`

- [ ] **Step 1: Write the failing test** — add to
      `packages/agent/test/policy.test.ts`:

```ts
test('an exempt author bypasses delegation and budget', async () => {
  const owner = Identity.create();
  const agent = Identity.create();
  const registry = new AgentRegistry();
  // agent is delegated only to src/**, maxChanges 1; owner has NO delegation.
  registry.register(
    signDelegation(
      { agent: agent.did, paths: ['src/**'], maxChanges: 1, maxSpend: 100 },
      owner
    )
  );
  const policy = delegationPolicy(registry, (a) => a === owner.did);

  // Owner op on any path, no delegation, no budget → allowed.
  const ownerOp = {
    author: owner.did,
    path: 'anywhere/x',
    lamport: 1,
    id: 'o1',
    parents: [],
    payload: null,
    sig: new Uint8Array(),
  } as unknown as Op;
  expect(
    (
      await policy({
        into: 'main',
        intoHeads: [],
        incomingHeads: ['o1'],
        mergedHeads: ['o1'],
        incomingOps: [ownerOp],
        conflicts: [],
      })
    ).allow
  ).toBe(true);

  // Non-owner op still requires an in-scope delegation.
  const stranger = Identity.create();
  const strangerOp = { ...ownerOp, author: stranger.did, id: 's1' } as Op;
  expect(
    (
      await policy({
        into: 'main',
        intoHeads: [],
        incomingHeads: ['s1'],
        mergedHeads: ['s1'],
        incomingOps: [strangerOp],
        conflicts: [],
      })
    ).allow
  ).toBe(false);
});
```

> Match the existing `policy.test.ts` imports/helpers (`Identity`,
> `AgentRegistry`, `signDelegation`, `delegationPolicy`, `Op`, the
> `LandProposal` shape). If the file builds a proposal via a helper, reuse it;
> the cast above is a fallback if there is none.

- [ ] **Step 2: Run it — expect FAIL** (`AGENT=1 moon run agent:test`): the
      2-arg `delegationPolicy` is rejected / the owner op is rejected.

- [ ] **Step 3: Add the `exempt` param** — in `packages/agent/src/policy.ts`,
      change the signature and skip exempt authors in BOTH loops:

```ts
export function delegationPolicy(
  registry: AgentRegistry,
  exempt?: (author: string) => boolean
): LandPolicy {
  return (p: LandProposal) => {
    // Authorization + scope: every incoming op must be permitted (exempt skips).
    for (const op of p.incomingOps) {
      const agent = op.author;
      if (exempt?.(agent) === true) {
        continue;
      }
      if (registry.isRevoked(agent)) {
        return { allow: false, reason: `agent ${agent} is revoked` };
      }
      const d = registry.delegationFor(agent);
      if (d === undefined) {
        return { allow: false, reason: `no delegation for agent ${agent}` };
      }
      if (!d.paths.some((glob) => matchGlob(glob, op.path))) {
        return {
          allow: false,
          reason: `${op.path} is outside ${agent}'s delegated scope`,
        };
      }
    }
    // Budget: project this landing's op count per agent (exempt authors excluded).
    const countByAgent = new Map<string, number>();
    for (const op of p.incomingOps) {
      if (exempt?.(op.author) === true) {
        continue;
      }
      countByAgent.set(op.author, (countByAgent.get(op.author) ?? 0) + 1);
    }
    for (const [agent, count] of countByAgent) {
      const d = registry.delegationFor(agent);
      if (d === undefined) {
        continue;
      }
      const u = registry.usage(agent);
      if (u.changes + count > d.maxChanges) {
        return {
          allow: false,
          reason: `agent ${agent} is over its change budget`,
        };
      }
      if (u.spend >= d.maxSpend) {
        return {
          allow: false,
          reason: `agent ${agent} is over its spend budget`,
        };
      }
    }
    return { allow: true };
  };
}
```

(Keep the existing `matchGlob` import and any trailing logic; this replaces the
two loops with exempt-aware versions. Confirm the final `return { allow: true }`
matches the file's existing tail.)

- [ ] **Step 4: Run agent tests — expect PASS** (`AGENT=1 moon run agent:test`):
      the new test + all existing policy tests (the default
      `exempt === undefined` path is unchanged).

- [ ] **Step 5: Typecheck + build** — `moon run agent:typecheck agent:build`.

- [ ] **Step 6: Commit**

```bash
git add packages/agent
git commit -m "feat(agent): delegationPolicy owner-exempt predicate

delegationPolicy(registry, exempt?) skips authors matching exempt in both the
scope and budget checks, so a repo owner is unrestricted while every other
author stays per-op gated. Additive — exempt undefined is unchanged behavior.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 2: Server — durable registry + `grants`/`revoke`/`grants` endpoints

**Files:**

- Modify: `packages/server/package.json` (add `@thaddeus.run/agent` dep),
  `bun.lock`
- Modify: `packages/server/src/dto.ts` (add
  `encodeDelegation`/`decodeDelegation`), `packages/server/src/server.ts`
  (registry + endpoints + routing)
- Test: `packages/server/test/grants.test.ts`

**Interfaces:**

- Consumes: `AgentRegistry`, `verifyDelegation`, `Delegation`
  (`@thaddeus.run/agent`).
- Produces:
  - `encodeDelegation(d: Delegation): string`,
    `decodeDelegation(s: string): Delegation` (from `@thaddeus.run/server`)
  - routes `POST /repos/:name/grants`, `POST /repos/:name/revoke`,
    `GET /repos/:name/grants`
  - an internal `registryFor(name): Promise<AgentRegistry>` (durable, cached)

- [ ] **Step 1: Add the agent dep** — in `packages/server/package.json`, add
      `"@thaddeus.run/agent": "workspace:*"` to `dependencies` (alphabetical).
      `bun install`.

- [ ] **Step 2: Add the delegation wire codec** — in
      `packages/server/src/dto.ts`, add (reusing the existing
      `encodeRecord`/`decodeRecord` imports):

```ts
import type { Delegation } from '@thaddeus.run/agent';

// A single Delegation on the wire: base64 of the persistence record encoding (so
// its sig bytes survive JSON), same convention as the bundle items.
export function encodeDelegation(d: Delegation): string {
  return Buffer.from(encodeRecord(d)).toString('base64');
}
export function decodeDelegation(s: string): Delegation {
  return decodeRecord(new Uint8Array(Buffer.from(s, 'base64'))) as Delegation;
}
```

Export them from `packages/server/src/index.ts`:

```ts
export {
  type Bundle,
  decodeBundle,
  encodeBundle,
  encodeDelegation,
  decodeDelegation,
} from './dto';
```

- [ ] **Step 3: Write the failing test**

`packages/server/test/grants.test.ts`:

```ts
import { signDelegation } from '@thaddeus.run/agent';
import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { beforeAll, describe, expect, test } from 'bun:test';

import { createServer } from '../src/server';
import { decodeDelegation, encodeDelegation } from '../src/dto';
import { signRequest } from '../src/sign';

beforeAll(async () => {
  await ready();
});

function signed(
  method: string,
  path: string,
  bodyObj: unknown,
  signer: Identity
): Request {
  const body = new TextEncoder().encode(JSON.stringify(bodyObj));
  const h = signRequest(method, path, body, signer, new Date().toISOString());
  return new Request(`http://t${path}`, {
    method,
    body,
    headers: {
      'x-thaddeus-did': h.did,
      'x-thaddeus-timestamp': h.timestamp,
      'x-thaddeus-signature': h.signature,
    },
  });
}

describe('grants', () => {
  test('owner grants + lists; non-owner and wrong-operator are rejected; durable', async () => {
    const a = Identity.create(); // owner
    const b = Identity.create(); // grantee
    const backend = new MemoryBackend();
    const srv = createServer({ backend });
    await srv.fetch(signed('POST', '/repos', { name: 'r' }, a));

    const deleg = signDelegation(
      { agent: b.did, paths: ['src/**'], maxChanges: 100, maxSpend: 1000 },
      a
    );

    // Non-owner grant → 403.
    const stranger = Identity.create();
    const f1 = await srv.fetch(
      signed(
        'POST',
        '/repos/r/grants',
        { delegation: encodeDelegation(deleg) },
        stranger
      )
    );
    expect(f1.status).toBe(403);

    // Delegation whose operator ≠ owner → 403 (signed by owner request, but the deleg was issued by someone else).
    const foreign = signDelegation(
      { agent: b.did, paths: ['**'], maxChanges: 1, maxSpend: 1 },
      stranger
    );
    const f2 = await srv.fetch(
      signed(
        'POST',
        '/repos/r/grants',
        { delegation: encodeDelegation(foreign) },
        a
      )
    );
    expect(f2.status).toBe(403);

    // Owner grant → 200; GET /grants lists it.
    const ok = await srv.fetch(
      signed(
        'POST',
        '/repos/r/grants',
        { delegation: encodeDelegation(deleg) },
        a
      )
    );
    expect(ok.status).toBe(200);
    const list = (await (
      await srv.fetch(new Request('http://t/repos/r/grants'))
    ).json()) as { grants: string[] };
    expect(list.grants).toHaveLength(1);
    expect(decodeDelegation(list.grants[0]!).agent).toBe(b.did);

    // Revoke → grants list drops it.
    await srv.fetch(signed('POST', '/repos/r/revoke', { agent: b.did }, a));
    const after = (await (
      await srv.fetch(new Request('http://t/repos/r/grants'))
    ).json()) as { grants: string[] };
    expect(after.grants).toHaveLength(0);

    // Durable: a fresh server over the same backend still has the (revoked) state.
    const srv2 = createServer({ backend });
    const reloaded = (await (
      await srv2.fetch(new Request('http://t/repos/r/grants'))
    ).json()) as { grants: string[] };
    expect(reloaded.grants).toHaveLength(0); // still revoked after reload
  });
});
```

- [ ] **Step 4: Run it — expect FAIL** (`AGENT=1 moon run server:test`).

- [ ] **Step 5: Add the registry + endpoints to `server.ts`**

Add imports:

```ts
import {
  AgentRegistry,
  type Delegation,
  verifyDelegation,
} from '@thaddeus.run/agent';

import {
  decodeBundle,
  encodeBundle,
  decodeDelegation,
  encodeDelegation,
} from './dto';
```

(merge with the existing `./dto` import). Inside `createServer`, add the
registry cache + a `registryFor` builder near `repoCache`:

```ts
const registries = new Map<string, AgentRegistry>();

// Build (or fetch the cached) durable AgentRegistry for a repo: register every
// persisted grant, replay the persisted meters, then apply revocations.
async function registryFor(name: string): Promise<AgentRegistry> {
  const cached = registries.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const reg = new AgentRegistry();
  const b = metaBackend(name);
  for (const key of await b.list('grant/')) {
    const bytes = await b.get(key);
    if (bytes !== undefined) {
      try {
        reg.register(decodeRecord(bytes) as Delegation);
      } catch {
        // skip a corrupt/invalid persisted grant
      }
    }
  }
  for (const key of await b.list('meter/')) {
    const bytes = await b.get(key);
    if (bytes !== undefined) {
      const agent = key.slice('meter/'.length);
      const m = decodeRecord(bytes) as { changes: number; spend: number };
      try {
        reg.record(agent, m.changes, m.spend);
      } catch {
        // a meter for an agent with no grant — skip
      }
    }
  }
  for (const key of await b.list('revoked/')) {
    reg.revoke(key.slice('revoked/'.length));
  }
  registries.set(name, reg);
  return reg;
}
```

Add the three handlers (inside `createServer`, near the other handlers):

```ts
async function grant(
  name: string,
  req: Request,
  body: Uint8Array
): Promise<Response> {
  const signer = verifyRequest(
    'POST',
    new URL(req.url).pathname,
    body,
    headers(req),
    Date.parse(now())
  );
  if (signer === null) {
    return json(401, { error: 'unsigned or invalid request' });
  }
  const meta = await readMeta(name);
  if (meta === undefined) {
    return json(404, { error: `no repo ${name}` });
  }
  if (signer !== meta.owner) {
    return json(403, { error: 'not the repo owner' });
  }
  const parsed = safeParseJson(body);
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
    return json(400, { error: 'invalid JSON body' });
  }
  const { delegation } = parsed as { delegation?: string };
  if (typeof delegation !== 'string') {
    return json(400, { error: 'missing delegation' });
  }
  let d: Delegation;
  try {
    d = decodeDelegation(delegation);
  } catch {
    return json(400, { error: 'malformed delegation' });
  }
  if (d.operator !== meta.owner) {
    return json(403, { error: 'delegation operator is not the repo owner' });
  }
  if (!verifyDelegation(d)) {
    return json(400, { error: 'invalid delegation signature' });
  }
  return withRepoLock(name, async () => {
    const reg = await registryFor(name);
    reg.register(d);
    await metaBackend(name).put(`grant/${d.agent}`, encodeRecord(d));
    return json(200, {
      agent: d.agent,
      paths: [...d.paths],
      maxChanges: d.maxChanges,
      maxSpend: d.maxSpend,
    });
  });
}

async function revoke(
  name: string,
  req: Request,
  body: Uint8Array
): Promise<Response> {
  const signer = verifyRequest(
    'POST',
    new URL(req.url).pathname,
    body,
    headers(req),
    Date.parse(now())
  );
  if (signer === null) {
    return json(401, { error: 'unsigned or invalid request' });
  }
  const meta = await readMeta(name);
  if (meta === undefined) {
    return json(404, { error: `no repo ${name}` });
  }
  if (signer !== meta.owner) {
    return json(403, { error: 'not the repo owner' });
  }
  const parsed = safeParseJson(body);
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
    return json(400, { error: 'invalid JSON body' });
  }
  const { agent } = parsed as { agent?: string };
  if (typeof agent !== 'string') {
    return json(400, { error: 'missing agent' });
  }
  return withRepoLock(name, async () => {
    const reg = await registryFor(name);
    reg.revoke(agent);
    await metaBackend(name).put(`revoked/${agent}`, encodeRecord(true));
    return json(200, { agent, revoked: true });
  });
}

async function listGrants(name: string): Promise<Response> {
  if ((await readMeta(name)) === undefined) {
    return json(404, { error: `no repo ${name}` });
  }
  const reg = await registryFor(name);
  const b = metaBackend(name);
  const grants: string[] = [];
  for (const key of await b.list('grant/')) {
    const bytes = await b.get(key);
    if (bytes !== undefined) {
      const d = decodeRecord(bytes) as Delegation;
      if (!reg.isRevoked(d.agent)) {
        grants.push(encodeDelegation(d));
      }
    }
  }
  return json(200, { grants });
}
```

Wire the routes into `fetch` (before the catch-all, with the other
`/repos/:name/...`):

```ts
const grantsMatch = path.match(/^\/repos\/(.+)\/grants$/);
if (grantsMatch !== null && req.method === 'POST') {
  return grant(decodeURIComponent(grantsMatch[1]!), req, body);
}
if (grantsMatch !== null && req.method === 'GET') {
  return listGrants(decodeURIComponent(grantsMatch[1]!));
}
const revokeMatch = path.match(/^\/repos\/(.+)\/revoke$/);
if (revokeMatch !== null && req.method === 'POST') {
  return revoke(decodeURIComponent(revokeMatch[1]!), req, body);
}
```

> Order the route checks so `/grants` and `/revoke` are matched before any
> generic `/repos/:name`. The path captures use the same `safeDecode`-style
> handling as the existing routes — if the file wraps `decodeURIComponent` in a
> `safeDecode` helper, use it and 400 on failure (match the existing pull/push
> routes).

- [ ] **Step 6: Run the grants test — expect PASS**
      (`AGENT=1 moon run server:test`): the new grants test + all existing
      server tests stay green.

- [ ] **Step 7: Typecheck + build** — `moon run server:typecheck server:build`.

- [ ] **Step 8: Commit**

```bash
git add packages/server bun.lock
git commit -m "feat(server): durable per-repo AgentRegistry + grants/revoke endpoints

A per-repo AgentRegistry rebuilt from the scoped backend (grant/meter/revoked
keys). POST /grants (owner-signed; delegation.operator must be the owner)
registers + persists a P09 Delegation; POST /revoke quarantines + persists
(terminal); GET /grants lists active grants (public). +encodeDelegation/
decodeDelegation wire codec.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 3: Server — owner-or-delegate gate + policy composition + record-after-land

**Files:**

- Modify: `packages/server/src/server.ts` (push gate, land gate + policy +
  record)
- Test: `packages/server/test/multiwriter.test.ts`

**Interfaces:**

- Consumes: `registryFor` (Task 2), `delegationPolicy` (`@thaddeus.run/agent`),
  `reachableOps` (existing), the existing push/land handlers.
- Produces: an `all(...policies)` combinator; widened gates; delegate metering.

- [ ] **Step 1: Write the failing test**

`packages/server/test/multiwriter.test.ts`:

```ts
import { signDelegation } from '@thaddeus.run/agent';
import { Workspace } from '@thaddeus.run/fs';
import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryBackend } from '@thaddeus.run/persist';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { createServer } from '../src/server';
import { encodeBundle, encodeDelegation } from '../src/dto';
import { signRequest } from '../src/sign';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function signed(
  method: string,
  path: string,
  bodyObj: unknown,
  signer: Identity
): Request {
  const body = new TextEncoder().encode(JSON.stringify(bodyObj));
  const h = signRequest(method, path, body, signer, new Date().toISOString());
  return new Request(`http://t${path}`, {
    method,
    body,
    headers: {
      'x-thaddeus-did': h.did,
      'x-thaddeus-timestamp': h.timestamp,
      'x-thaddeus-signature': h.signature,
    },
  });
}

// B authors a commit to `path` locally and returns the push bundle + heads.
async function authored(b: Identity, path: string) {
  const store = new MemoryStore();
  const log = new OpLog(store);
  const ws = Workspace.open(log, store, {
    source: 'main',
    reader: b,
    name: 'w',
  });
  ws.write(path, enc('x'));
  await ws.commit(b);
  const objects = [];
  const caps = [];
  for (const op of log.ops()) {
    const pid = op.payload?.plaintext_id;
    if (pid !== undefined) {
      const cur = store.current(pid);
      if (cur !== undefined) {
        objects.push(cur);
        caps.push(...store.caps(pid));
      }
    }
  }
  return {
    bundle: encodeBundle(log.ops(), objects, caps),
    heads: [...log.heads('w')],
  };
}

describe('multi-writer land enforcement', () => {
  test('delegate lands in scope, is rejected out of scope, and after revoke', async () => {
    const a = Identity.create(); // owner
    const b = Identity.create(); // delegate, src/** only
    const srv = createServer({ backend: new MemoryBackend() });
    await srv.fetch(signed('POST', '/repos', { name: 'r' }, a));
    await srv.fetch(
      signed(
        'POST',
        '/repos/r/grants',
        {
          delegation: encodeDelegation(
            signDelegation(
              {
                agent: b.did,
                paths: ['src/**'],
                maxChanges: 100,
                maxSpend: 1000,
              },
              a
            )
          ),
        },
        a
      )
    );

    // In scope: B pushes src/x and lands.
    const inScope = await authored(b, 'src/x.rs');
    expect(
      (await srv.fetch(signed('POST', '/repos/r/push', inScope.bundle, b)))
        .status
    ).toBe(200);
    const landed = await (
      await srv.fetch(
        signed(
          'POST',
          '/repos/r/land',
          { fromHeads: inScope.heads, into: 'main' },
          b
        )
      )
    ).json();
    expect(landed.landed).toBe(true);

    // Out of scope: B pushes docs/y and the land is rejected.
    const outScope = await authored(b, 'docs/y.md');
    await srv.fetch(signed('POST', '/repos/r/push', outScope.bundle, b));
    const blocked = await (
      await srv.fetch(
        signed(
          'POST',
          '/repos/r/land',
          { fromHeads: outScope.heads, into: 'main' },
          b
        )
      )
    ).json();
    expect(blocked.landed).toBe(false);
    expect(blocked.reason.toLowerCase()).toContain('scope');

    // Revoke: B can no longer push.
    await srv.fetch(signed('POST', '/repos/r/revoke', { agent: b.did }, a));
    const again = await authored(b, 'src/z.rs');
    expect(
      (await srv.fetch(signed('POST', '/repos/r/push', again.bundle, b))).status
    ).toBe(403);
  });

  test('maxChanges budget caps a delegate across lands (durable)', async () => {
    const a = Identity.create();
    const b = Identity.create();
    const backend = new MemoryBackend();
    const srv = createServer({ backend });
    await srv.fetch(signed('POST', '/repos', { name: 'r2' }, a));
    await srv.fetch(
      signed(
        'POST',
        '/repos/r2/grants',
        {
          delegation: encodeDelegation(
            signDelegation(
              { agent: b.did, paths: ['**'], maxChanges: 1, maxSpend: 1000 },
              a
            )
          ),
        },
        a
      )
    );

    const first = await authored(b, 'a.txt');
    await srv.fetch(signed('POST', '/repos/r2/push', first.bundle, b));
    expect(
      (
        await (
          await srv.fetch(
            signed(
              'POST',
              '/repos/r2/land',
              { fromHeads: first.heads, into: 'main' },
              b
            )
          )
        ).json()
      ).landed
    ).toBe(true);

    // A fresh server over the same backend: the meter (1 change used) survives.
    const srv2 = createServer({ backend });
    const second = await authored(b, 'b.txt');
    await srv2.fetch(signed('POST', '/repos/r2/push', second.bundle, b));
    const over = await (
      await srv2.fetch(
        signed(
          'POST',
          '/repos/r2/land',
          { fromHeads: second.heads, into: 'main' },
          b
        )
      )
    ).json();
    expect(over.landed).toBe(false);
    expect(over.reason.toLowerCase()).toContain('budget');
  });
});
```

> Reuse `authored`'s bundle shape from the existing push tests if one exists.
> Note: each `authored` call commits over a fresh empty `main`, so its op
> parents at `[]`; the server ingests then lands `fromHeads`. This matches the
> existing server e2e pattern.

- [ ] **Step 2: Run it — expect FAIL** (`AGENT=1 moon run server:test`): B's
      push is 403 (gate still owner-only) / out-of-scope land still allowed.

- [ ] **Step 3: Add the `all` combinator + `delegationPolicy` import**

In `packages/server/src/server.ts`, add to the agent import:

```ts
import {
  AgentRegistry,
  type Delegation,
  delegationPolicy,
  verifyDelegation,
} from '@thaddeus.run/agent';
```

Add a module-scope combinator (near `reachableOps`):

```ts
// Compose LandPolicies: allow only if every policy allows; the first rejection
// (with its reason) wins.
function all(...policies: LandPolicy[]): LandPolicy {
  return async (p) => {
    for (const policy of policies) {
      const decision = await policy(p);
      if (!decision.allow) {
        return decision;
      }
    }
    return { allow: true };
  };
}
```

- [ ] **Step 4: Widen the push gate** — in the `push` handler, replace the
      owner-only check:

```ts
if (signer !== meta.owner) {
  return json(403, { error: 'not the repo owner' });
}
```

with an owner-or-delegate check:

```ts
const reg = await registryFor(name);
if (
  signer !== meta.owner &&
  !(reg.delegationFor(signer) !== undefined && !reg.isRevoked(signer))
) {
  return json(403, { error: 'not authorized to write this repo' });
}
```

- [ ] **Step 5: Widen the land gate + compose the policy + record after land** —
      in the `land` handler, replace the same owner-only check with the
      owner-or-delegate check above (build
      `const reg = await registryFor(name);` once, before the gate). Then inside
      `withRepoLock`, change the land call to compose the delegation policy and
      record delegate usage afterward:

```ts
const target = into ?? 'main';
const priorInto = [...repo.log.heads(target)];
const src = 'incoming';
repo.log.view(src, fromHeads);
const result = await repo.land({
  from: src,
  into: target,
  author: PublicIdentity.fromDid(signer),
  policy: all(
    policy,
    delegationPolicy(reg, (a) => a === meta.owner)
  ),
});
if (result.landed) {
  // Record each delegate's landed-op count (owner exempt). incomingOps =
  // ops reachable from fromHeads but not from the prior `into` frontier.
  const priorSet = new Set(
    reachableOps(repo.log.ops(), priorInto).map((o) => o.id)
  );
  const incoming = reachableOps(repo.log.ops(), fromHeads).filter(
    (o) => !priorSet.has(o.id)
  );
  const countByAuthor = new Map<string, number>();
  for (const op of incoming) {
    if (op.author !== meta.owner) {
      countByAuthor.set(op.author, (countByAuthor.get(op.author) ?? 0) + 1);
    }
  }
  for (const [agent, count] of countByAuthor) {
    if (reg.delegationFor(agent) !== undefined) {
      reg.record(agent, count, 0);
      const u = reg.usage(agent);
      await metaBackend(name).put(
        `meter/${agent}`,
        encodeRecord({ changes: u.changes, spend: u.spend })
      );
    }
  }
}
return json(200, result);
```

(Remove the old
`const src = 'incoming'; repo.log.view(src, fromHeads); const result = await repo.land({ … policy }); return json(200, result);`
block — the above replaces it. `reg` is the one fetched for the gate.)

- [ ] **Step 6: Run the multi-writer test — expect PASS**
      (`AGENT=1 moon run server:test`): in-scope land, out-of-scope reject,
      revoke-blocks-push, durable budget cap; plus the existing server suite
      (owner-only repos are unchanged — no delegations, owner is exempt and
      always authorized).

- [ ] **Step 7: Typecheck + lint** — `moon run server:typecheck root:lint`.

- [ ] **Step 8: Commit**

```bash
git add packages/server
git commit -m "feat(server): owner-or-delegate gate + delegation-enforced land

push/land now accept the owner OR a non-revoked delegate. land composes
all(basePolicy, delegationPolicy(registry, ownerExempt)) so each non-owner op
is path+budget gated (owner exempt), and records each delegate's landed-op
count to the durable meter after a successful land.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 4: Client SDK — `grant` / `revoke` / `listGrants`

**Files:**

- Modify: `packages/client/package.json` (add `@thaddeus.run/agent` type dep),
  `bun.lock`
- Modify: `packages/client/src/client.ts`, `src/index.ts`
- Test: `packages/client/test/grants.test.ts`

**Interfaces:**

- Consumes: `encodeDelegation`/`decodeDelegation` (server),
  `Delegation`/`signDelegation` (agent).
- Produces:
  - `Client.grant(name, delegation: Delegation): Promise<{ agent: string; paths: string[]; maxChanges: number; maxSpend: number }>`
  - `Client.revoke(name, agent: string): Promise<{ agent: string; revoked: boolean }>`
  - `Client.listGrants(name: string): Promise<Delegation[]>`

- [ ] **Step 1: Add the agent dep** — in `packages/client/package.json`, add
      `"@thaddeus.run/agent": "workspace:*"` to `devDependencies` (the SDK uses
      only the `Delegation` TYPE; tests use `signDelegation`). `bun install`.

> If `isolatedDeclarations` requires the type at the package's runtime type
> surface (it's a return type of a public method), move it to `dependencies`
> instead — a type-only import of `Delegation` is fine either way; choose
> `dependencies` if typecheck complains.

- [ ] **Step 2: Write the failing test**

`packages/client/test/grants.test.ts`:

```ts
import { signDelegation } from '@thaddeus.run/agent';
import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryBackend } from '@thaddeus.run/persist';
import { createServer } from '@thaddeus.run/server';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '../src/client';

beforeAll(async () => {
  await ready();
});

describe('Client grant/revoke/listGrants', () => {
  test('owner grants, lists, and revokes a delegate', async () => {
    const a = Identity.create();
    const b = Identity.create();
    const srv = createServer({ backend: new MemoryBackend() });
    const c = new Client('http://t', a, srv.fetch.bind(srv));
    await c.createRepo('r');

    const d = signDelegation(
      { agent: b.did, paths: ['src/**'], maxChanges: 10, maxSpend: 100 },
      a
    );
    const g = await c.grant('r', d);
    expect(g.agent).toBe(b.did);
    expect(g.paths).toEqual(['src/**']);

    const grants = await c.listGrants('r');
    expect(grants).toHaveLength(1);
    expect(grants[0]?.agent).toBe(b.did);

    const r = await c.revoke('r', b.did);
    expect(r.revoked).toBe(true);
    expect(await c.listGrants('r')).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run it — expect FAIL** (`AGENT=1 moon run client:test`).

- [ ] **Step 4: Add the methods to `client.ts`**

Add imports:

```ts
import type { Delegation } from '@thaddeus.run/agent';
import { decodeDelegation, encodeDelegation } from '@thaddeus.run/server';
```

Add the methods to the `Client` class:

```ts
  // Owner: register an owner-signed delegation granting `delegation.agent` push.
  async grant(
    name: string,
    delegation: Delegation
  ): Promise<{ agent: string; paths: string[]; maxChanges: number; maxSpend: number }> {
    const res = await this.#signed('POST', `/repos/${encodeURIComponent(name)}/grants`, {
      delegation: encodeDelegation(delegation),
    });
    return (await this.#ok(res)) as {
      agent: string;
      paths: string[];
      maxChanges: number;
      maxSpend: number;
    };
  }

  // Owner: revoke a delegate (terminal).
  async revoke(name: string, agent: string): Promise<{ agent: string; revoked: boolean }> {
    const res = await this.#signed('POST', `/repos/${encodeURIComponent(name)}/revoke`, { agent });
    return (await this.#ok(res)) as { agent: string; revoked: boolean };
  }

  // The repo's active (non-revoked) delegations — a public, verifiable list.
  async listGrants(name: string): Promise<Delegation[]> {
    const res = await this.#fetch(new Request(`${this.#server}/repos/${encodeURIComponent(name)}/grants`));
    const body = (await this.#ok(res)) as { grants: string[] };
    return body.grants.map(decodeDelegation);
  }
```

Export the `Delegation` type re-export is not needed; the methods reference it.

- [ ] **Step 5: Run the test — expect PASS** (`AGENT=1 moon run client:test`).

- [ ] **Step 6: Typecheck + build** — `moon run client:typecheck client:build`.

- [ ] **Step 7: Commit**

```bash
git add packages/client bun.lock
git commit -m "feat(client): grant/revoke/listGrants

Client.grant posts an owner-signed Delegation; revoke quarantines an agent;
listGrants returns the repo's active delegations (decoded + verifiable). A
delegate's existing clone/push/land are unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 5: CLI — `grant` / `revoke` / `grants`

**Files:**

- Modify: `packages/cli/package.json` (add `@thaddeus.run/agent` runtime dep),
  `bun.lock`
- Modify: `packages/cli/src/run.ts` (three cases + USAGE)
- Test: `packages/cli/test/grants.test.ts`

**Interfaces:**

- Consumes: `signDelegation` (agent), `Client.grant/revoke/listGrants`, the
  existing `findRoot`/`loadConfig`/`loadIdentity`/`Client`.

- [ ] **Step 1: Add the agent dep** — in `packages/cli/package.json`, add
      `"@thaddeus.run/agent": "workspace:*"` to `dependencies` (the CLI calls
      `signDelegation` at runtime). `bun install`.

- [ ] **Step 2: Write the failing test (headline collaboration flow)**

`packages/cli/test/grants.test.ts`:

```ts
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Identity, ready } from '@thaddeus.run/identity';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { run } from '../src/run';
import { startServer } from '../src/serve';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-grants-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('thaddeus grant/revoke/grants', () => {
  test('owner grants a teammate scoped push; out-of-scope and post-revoke are rejected', async () => {
    const s = startServer({ dataDir: mkdtempSync(join(tmp, 'srv-')), port: 0 });
    try {
      const out: string[] = [];
      const ownerHome = mkdtempSync(join(tmp, 'owner-'));
      const teammateHome = mkdtempSync(join(tmp, 'mate-'));
      const e = (cwd: string, home: string) => ({
        cwd,
        home,
        out: (l: string) => out.push(l),
      });

      await run(['init'], e(ownerHome, ownerHome));
      await run(['init'], e(teammateHome, teammateHome));
      // Read the teammate DID from their identity file.
      const teammateDid = (
        JSON.parse(
          readFileSync(
            join(teammateHome, '.config', 'thaddeus', 'identity.json'),
            'utf8'
          )
        ) as { did: string }
      ).did;

      // Owner creates + clones the repo, then grants the teammate src/**.
      await run(['create', s.url, 'proj'], e(ownerHome, ownerHome));
      const ownerWc = mkdtempSync(join(tmp, 'ownerwc-'));
      await run(['clone', s.url, 'proj', ownerWc], e(ownerWc, ownerHome));
      out.length = 0;
      expect(
        await run(
          ['grant', teammateDid, '--paths', 'src/**'],
          e(ownerWc, ownerHome)
        )
      ).toBe(0);
      expect(out.join('\n')).toContain(teammateDid);

      // Teammate clones, edits in scope → push lands.
      const mateWc = mkdtempSync(join(tmp, 'matewc-'));
      await run(['clone', s.url, 'proj', mateWc], e(mateWc, teammateHome));
      mkdirSync(join(mateWc, 'src'), { recursive: true });
      writeFileSync(join(mateWc, 'src', 'x.rs'), 'fn x() {}');
      out.length = 0;
      expect(await run(['push'], e(mateWc, teammateHome))).toBe(0);
      expect(out.join('\n').toLowerCase()).toContain('published');

      // Out of scope → push reports the blocked land (non-zero exit).
      writeFileSync(join(mateWc, 'readme.md'), 'hi');
      out.length = 0;
      expect(await run(['push'], e(mateWc, teammateHome))).toBe(1);
      expect(out.join('\n').toLowerCase()).toContain('not landed');

      // grants lists the active grant; revoke then blocks the teammate.
      out.length = 0;
      await run(['grants'], e(ownerWc, ownerHome));
      expect(out.join('\n')).toContain(teammateDid);
      await run(['revoke', teammateDid], e(ownerWc, ownerHome));
      mkdirSync(join(mateWc, 'src'), { recursive: true });
      writeFileSync(join(mateWc, 'src', 'z.rs'), 'fn z() {}');
      out.length = 0;
      expect(await run(['push'], e(mateWc, teammateHome))).toBe(1);
    } finally {
      await s.stop();
    }
  });
});
```

> `mkdirSync` is imported statically at the top (no dynamic `import()`). The
> teammate's `clone` materializes the repo; `src/` may not exist yet, so create
> it before writing `src/x.rs`.

- [ ] **Step 3: Run it — expect FAIL** (`CI= AGENT=1 moon run cli:test`).

- [ ] **Step 4: Add the cases to `run.ts`**

Add the import:

```ts
import { signDelegation } from '@thaddeus.run/agent';
```

Add the three cases to the `switch` (before `case 'help'`):

```ts
      case 'grant': {
        const { values, positionals } = parseArgs({
          args: [...rest],
          options: { paths: { type: 'string' }, 'max-changes': { type: 'string' } },
          allowPositionals: true,
        });
        const did = positionals[0];
        if (did === undefined) {
          out('usage: thaddeus grant <did> [--paths a,b] [--max-changes N]');
          return 2;
        }
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const identity = loadIdentity(env.home);
        const paths = values.paths !== undefined ? values.paths.split(',') : ['**'];
        const maxChanges =
          values['max-changes'] !== undefined ? Number(values['max-changes']) : 1_000_000;
        if (!Number.isInteger(maxChanges) || maxChanges < 0) {
          out(`invalid --max-changes: ${values['max-changes']}`);
          return 2;
        }
        const delegation = signDelegation(
          { agent: did, paths, maxChanges, maxSpend: 1_000_000 },
          identity
        );
        const client = new Client(cfg.server, identity, env.fetchImpl);
        const g = await client.grant(cfg.repo, delegation);
        out(`granted ${g.agent} → ${g.paths.join(', ')} (max ${g.maxChanges} changes)`);
        return 0;
      }
      case 'revoke': {
        const did = rest[0];
        if (did === undefined) {
          out('usage: thaddeus revoke <did>');
          return 2;
        }
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const identity = loadIdentity(env.home);
        const client = new Client(cfg.server, identity, env.fetchImpl);
        await client.revoke(cfg.repo, did);
        out(`revoked ${did}`);
        return 0;
      }
      case 'grants': {
        const root = findRoot(env.cwd);
        if (root === undefined) {
          out("not a thaddeus working copy — run 'thaddeus clone' first");
          return 2;
        }
        const cfg = loadConfig(root);
        const identity = loadIdentity(env.home);
        const client = new Client(cfg.server, identity, env.fetchImpl);
        const grants = await client.listGrants(cfg.repo);
        if (grants.length === 0) {
          out('no grants');
          return 0;
        }
        for (const g of grants) {
          out(`${g.agent} → ${g.paths.join(', ')} (max ${g.maxChanges} changes)`);
        }
        return 0;
      }
```

Add to the `USAGE` string (after `land`):

```
  grant  <did> [--paths a,b] [--max-changes N]    grant push to a DID/agent
  revoke <did>                                     revoke a grant
  grants                                           list active grants
```

> `grant`/`revoke` use the existing top-level `try/catch` — a non-owner running
> them gets the server's 403 surfaced as `error: not the repo owner` + exit 1.

- [ ] **Step 5: Run the test — expect PASS** (`CI= AGENT=1 moon run cli:test`).

- [ ] **Step 6: Typecheck + lint** — `moon run cli:typecheck root:lint`.

- [ ] **Step 7: Commit**

```bash
git add packages/cli bun.lock
git commit -m "feat(cli): grant/revoke/grants — delegated push from the terminal

thaddeus grant <did> [--paths] [--max-changes] signs an owner Delegation and
posts it; revoke <did> revokes; grants lists. A delegate then clones + pushes
normally; an out-of-scope push reports the blocked land.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 6: Demo + docs

**Files:**

- Modify: `examples/cli/src/cli-demo.ts` (add a grant/delegate act) or
  `packages/cli/README.md`; `CHANGELOG.md`; `ARCHITECTURE.md`

- [ ] **Step 1: Extend the CLI demo** — in `examples/cli/src/cli-demo.ts`, after
      the existing push flow, add a delegation act: create a second identity
      home (`thaddeus init` in a temp home), read its DID,
      `thaddeus grant <did> --paths     'src/**'` as the owner, then have the
      second identity clone + push an in-scope `src/…` change (lands) and an
      out-of-scope change (blocked), and print each outcome. Then
      `thaddeus revoke <did>` and show the next push blocked. Keep the server
      bound via the existing `startServer`/`Bun.serve`; `stop()` at the end. RUN
      `CI= moon run example-cli:demo` and confirm the acts print truthfully
      (in-scope lands; out-of-scope "not landed"; post-revoke blocked).

> If weaving delegation into the existing demo is awkward, instead add a focused
> `examples/cli/src/grant-demo.ts` + a `grant-demo` moon task; either is fine —
> the bar is a runnable, truthful delegation flow.

- [ ] **Step 2: `CHANGELOG.md` — Added:**

```markdown
- Multi-writer collaboration — a repo owner grants push/land to other DIDs and
  agents via owner-signed P09 `Delegation`s over the wire (`thaddeus grant`/
  `revoke`/`grants`; `POST /grants`, `POST /revoke`, `GET /grants`). The server
  holds a **durable per-repo `AgentRegistry`** (grants/meter/revocations rebuilt
  from the backend), widens push/land to **owner-or-delegate**, and enforces
  `delegationPolicy` per incoming op at land — paths and `maxChanges` (the owner
  is exempt; fail-closed; revocation terminal). `maxSpend` is carried but not
  yet metered (no cost model).
```

- [ ] **Step 3: `ARCHITECTURE.md`** — in the Server / Client & CLI section, add
      a sentence: the remote is now multi-writer — the owner delegates scoped,
      budgeted push to other DIDs/agents (P09 `Delegation`, durable registry,
      fail-closed at land).

- [ ] **Step 4: `packages/cli/README.md`** — add `grant`/`revoke`/`grants` to
      the command list and a short collaboration example (owner grants `src/**`,
      the teammate clones + pushes).

- [ ] **Step 5: Format** — `moon run root:format`.

- [ ] **Step 6: Commit**

```bash
git add examples/cli CHANGELOG.md ARCHITECTURE.md packages/cli/README.md
git commit -m "docs(multi-writer): demo a delegated push + record grant/revoke

The CLI demo now grants a second identity scoped push, shows in-scope land /
out-of-scope reject / post-revoke block; CHANGELOG + ARCHITECTURE + CLI README
record multi-writer collaboration.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

---

### Task 7: Full-workspace verification

**Files:** none (verification only).

- [ ] **Step 1: Build** — `moon run :build` Expected: every package builds.
      (Pre-existing/unrelated: `apps/landing` `missing_outputs`, untouched.)

- [ ] **Step 2: Format + lint** — `moon run root:format root:lint` Expected: 0
      errors (pre-existing warnings only).

- [ ] **Step 3: Typecheck affected** —
      `moon run agent:typecheck server:typecheck client:typecheck cli:typecheck example-cli:typecheck`
      Expected: all PASS.

- [ ] **Step 4: Affected tests** —
      `CI= AGENT=1 moon run agent:test server:test client:test cli:test`
      Expected: all green (exempt policy, grants, multi-writer enforcement, SDK,
      CLI flow).

- [ ] **Step 5: Full suite** — `CI= AGENT=1 moon run :test` Expected: 0 failures
      (owner-only repos unchanged — no delegations, owner exempt).

- [ ] **Step 6: Demo** — `CI= moon run example-cli:demo` (or `grant-demo`)
      Expected: the delegation acts print truthfully.

- [ ] **Step 7: Final commit (only if format/lint produced changes)**

```bash
git add -A
git commit -m "chore(multi-writer): repo-wide format/lint pass

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltrk2Wto4o6XNPcGkUZ6X5"
```

(If `git status` is clean after Step 2, skip this commit.)

---

## Notes for the implementer

- **The owner is exempt; non-owner ops are gated per-op.**
  `delegationPolicy(reg, (a) => a === meta.owner)` is the only correct
  composition — never gate the owner. The push/land gate is
  `owner OR (delegated AND not revoked)`.
- **The registry is durable and the meter accumulates.** `registryFor` rebuilds
  from `grant/`/`meter/`/`revoked/`; the land handler records delegate usage
  AFTER a land allows, then persists `meter/<agent>`. Order on load: register
  grants → replay meters → apply revocations (record requires a registered
  agent).
- **`maxSpend` rides along at `spend = 0`** — `maxChanges` is the enforced
  budget; the CLI defaults both budgets to a large constant so a grant without
  flags is effectively unlimited-but-scoped.
- **Push is verify-don't-trust; scope is enforced at land.** A delegate may push
  ops outside its path scope — they simply never land. Do NOT add a path check
  to push.
- **Grant/revoke are owner-only AND `delegation.operator === owner`.** Both
  gates matter: an owner could otherwise register a delegation issued by a third
  party.
- **New deps:** `@thaddeus.run/agent` is a runtime dep of `server` and `cli`,
  and a (type) dep of `client`. `bun install` after each package.json change.
- **Port-binding CLI tests run with `CI=`** and `await stop()` in `finally`. No
  dynamic `import()` in shipped src or tests — hoist node:fs imports.
