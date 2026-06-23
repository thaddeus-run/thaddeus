# Pillar 02 — Membrane (timed reveal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scheduled, withheld key-release to `@thaddeus.run/store` so an encrypted object's payload reveals to a well-known `public` identity at a chosen time T — the brief's coordinated-disclosure "membrane."

**Architecture:** A scheduled reveal is just a `Capability` sealed to a well-known `public` identity, parked in a private `#pending` queue the mirror never sees. A trigger — lazy on `get` when `now ≥ T`, or an explicit `reveal()` — promotes it into the served `#caps` set (the "key-release event"). Reads take an injected `now` so outcomes never depend on hidden wall-clock. Reuses the existing `Capability` / `not_before` / rotation machinery from Pillar 01.

**Tech Stack:** TypeScript, Bun (test runner), moon (task runner), libsodium-wrappers-sumo (sealed boxes, ed25519, seeded keypair), `@noble/hashes/blake3` (addressing). Spec: `docs/specs/2026-06-23-thaddeus-pillar-02-membrane-design.md`.

## Global Constraints

- **Runtime/tooling:** Bun only — never `npm`/`pnpm`/`npx`. Run tasks through moon: `moonx <project>:<task>` (alias for `moon run`). Set `export AGENT=1` at the start of every shell so Bun emits AI-friendly test output.
- **Focused test runs** use Bun directly from the package dir, e.g. `cd packages/store && bun test test/membrane.test.ts`. Full gate per project: `moonx store:test`.
- **Dependencies** use the root `workspaces.catalog`; never add versions to package-level `package.json`. New cross-package deps use `workspace:*`.
- **Files end with a trailing newline.** Match the surrounding code's comment density and idiom (function-level comments explaining what/why for new helpers).
- **Commits** follow Conventional Commits 1.0.0. Every commit message ends with these two trailers (verbatim):
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01E36LFqTRe1FRrMNmxMLuLk
  ```
  (Shown below as "+ standard trailers" to avoid repetition.)
- **Time values** are ISO-8601 strings (e.g. `2030-01-01T00:00:00.000Z`), matching `Capability.not_before`. Internally compare via `Date.parse(...)` (ms).
- **Verification baseline** after code changes: `moon run root:format root:lint`, plus the affected `moonx <project>:typecheck` and `moonx <project>:test`.
- **Scope:** payload timed-reveal only. No metadata-gating, no `release(tag)`/`event` triggers, no time-lock crypto, in-memory only.
- **Branch:** work on `feat/docs-pillar-02-membrane-spec` (already checked out) or a fresh `feat/pillar-02-membrane` off `origin/main`.

---

## File Structure

**`@thaddeus.run/identity`**
- Modify `packages/identity/src/identity.ts` — add `Identity.fromSeed(seed)` (deterministic keypair).
- Modify `packages/identity/test/identity.test.ts` — determinism test.

**`@thaddeus.run/store`**
- Create `packages/store/src/membrane.ts` — `PUBLIC_SEED`, memoized `publicIdentity()`, `publicDid()`.
- Modify `packages/store/src/store.ts` — `#pending` queue; `get(ref, reader, now?)` (injected clock + lazy release); `scheduleReveal`; `reveal`; `caps()` accessor; `#releaseDue` helper; `revoke` re-keys/cancels pending and preserves `not_before`.
- Modify `packages/store/src/index.ts` — export the membrane surface.
- Create `packages/store/test/membrane.test.ts` — the P02 acceptance criteria.
- Modify `packages/store/test/store.test.ts` — injected-clock `get` test.

**Demo + integration + docs**
- Create `examples/disclosure/{package.json,moon.yml,tsconfig.json,src/disclosure.ts}` — the CVE timeline CLI.
- Modify `integration/test/one-edit-end-to-end.test.ts` — swap the P02 `test.todo` for a real assertion.
- Modify `ARCHITECTURE.md` — flip the Pillar 02 row `planned → built`.
- Modify `CHANGELOG.md` — add the membrane under `[Unreleased] → Added`; graduate the in-design line.

---

### Task 1: `Identity.fromSeed` (deterministic identities)

**Files:**
- Modify: `packages/identity/src/identity.ts` (add a static method to `class Identity`, after `create()` ~line 73)
- Test: `packages/identity/test/identity.test.ts`

**Interfaces:**
- Produces: `Identity.fromSeed(seed: Uint8Array): Identity` — a deterministic keypair from a 32-byte seed; same seed ⇒ same `did` and same keys.

- [ ] **Step 1: Write the failing test**

Add inside the `describe('Identity', …)` block in `packages/identity/test/identity.test.ts`:

```ts
test('fromSeed is deterministic and signs verifiably', () => {
  const seed = new Uint8Array(32).fill(1);
  const a = Identity.fromSeed(seed);
  const b = Identity.fromSeed(seed);
  expect(a.did).toBe(b.did);
  const msg = new TextEncoder().encode('x');
  // b's signature verifies under a's public half ⇒ identical keypair.
  expect(a.toPublic().verify(msg, b.sign(msg))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/identity && AGENT=1 bun test test/identity.test.ts -t 'fromSeed'`
Expected: FAIL — `Identity.fromSeed is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `packages/identity/src/identity.ts`, add this method to `class Identity` immediately after the `create()` method:

```ts
  // Deterministic identity from a 32-byte seed (crypto_sign_SEEDBYTES). Same
  // seed ⇒ same keys — for reproducible/well-known identities and tests.
  static fromSeed(seed: Uint8Array): Identity {
    assertReady();
    const ed = sodium.crypto_sign_seed_keypair(seed);
    const xPk = sodium.crypto_sign_ed25519_pk_to_curve25519(ed.publicKey);
    const xSk = sodium.crypto_sign_ed25519_sk_to_curve25519(ed.privateKey);
    return new Identity(ed.publicKey, ed.privateKey, xPk, xSk);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/identity && AGENT=1 bun test test/identity.test.ts`
Expected: PASS — all identity tests green (5 pass).

- [ ] **Step 5: Commit**

```bash
git add packages/identity/src/identity.ts packages/identity/test/identity.test.ts
git commit -m "feat(identity): deterministic Identity.fromSeed"   # + standard trailers
```

---

### Task 2: The well-known `public` identity

**Files:**
- Create: `packages/store/src/membrane.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/test/membrane.test.ts` (new file)

**Interfaces:**
- Consumes: `Identity.fromSeed` (Task 1).
- Produces:
  - `PUBLIC_SEED: Uint8Array` — the fixed, published 32-byte seed.
  - `publicIdentity(): Identity` — memoized; the world-readable identity (secret key is world-known by design).
  - `publicDid(): string` — its `did:key` string.

- [ ] **Step 1: Write the failing test**

Create `packages/store/test/membrane.test.ts`:

```ts
import { ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { publicDid, publicIdentity } from '../src/membrane';

beforeAll(async () => {
  await ready();
});

describe('public identity', () => {
  test('is stable and world-constructible', () => {
    expect(publicIdentity().did).toBe(publicDid());
    expect(publicDid().startsWith('did:key:z')).toBe(true);
    // Memoized: same instance every call.
    expect(publicIdentity()).toBe(publicIdentity());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/store && AGENT=1 bun test test/membrane.test.ts`
Expected: FAIL — cannot resolve `../src/membrane`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/store/src/membrane.ts`:

```ts
import { Identity } from '@thaddeus.run/identity';

// A fixed, PUBLISHED seed. The secret key derived from it is world-known on
// purpose: a capability sealed to this identity is readable by anyone, which is
// how "becomes world-readable at T" is expressed. Spike-only — a real protocol
// would post the released key to an open mirror, not hardcode a seed.
export const PUBLIC_SEED: Uint8Array = new Uint8Array(32).fill(7);

let cached: Identity | undefined;

// Memoized so callers share one instance (and we build it only after ready()).
export function publicIdentity(): Identity {
  cached ??= Identity.fromSeed(PUBLIC_SEED);
  return cached;
}

export function publicDid(): string {
  return publicIdentity().did;
}
```

Add to `packages/store/src/index.ts` (after the existing exports):

```ts
export { PUBLIC_SEED, publicDid, publicIdentity } from './membrane';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/store && AGENT=1 bun test test/membrane.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/membrane.ts packages/store/src/index.ts packages/store/test/membrane.test.ts
git commit -m "feat(store): well-known public identity for timed reveal"   # + standard trailers
```

---

### Task 3: Injected clock on `get`

**Files:**
- Modify: `packages/store/src/store.ts` (the `Store` interface ~lines 29-37; `get` ~lines 63-68; `#capabilityFor` ~lines 128-136; `#contentKeyVia` ~lines 140-146; call sites in `grant`/`revoke`)
- Test: `packages/store/test/store.test.ts`

**Interfaces:**
- Produces: `get(ref: Ref, reader: Identity, now?: string): Promise<Uint8Array>` — `now` is an optional ISO-8601 string; defaults to the current time. `not_before` is enforced against `now`.

- [ ] **Step 1: Write the failing test**

Add to `packages/store/test/store.test.ts` (inside its top-level `describe`; if it imports differ, match the existing file's imports — it already imports `Identity`, `ready`, `MemoryStore`):

```ts
test('get honors an injected now against a future not_before', async () => {
  const store = new MemoryStore();
  const alice = Identity.create();
  const bob = Identity.create();
  const ref = await store.put(new TextEncoder().encode('hi'), alice);

  // Grant Bob, then forge the grant's start time into the future by re-issuing
  // via a scheduled reveal is Task 4; here we test the clock directly: a read
  // with now before EPOCH+... Always-valid grant reads fine with an early now.
  await store.grant(ref, bob.toPublic(), alice);
  const early = '2000-01-01T00:00:00.000Z';
  expect(new TextDecoder().decode(await store.get(ref, bob, early))).toBe('hi');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/store && AGENT=1 bun test test/store.test.ts -t 'injected now'`
Expected: FAIL — `get` accepts only 2 args / TypeScript error on the third argument.

- [ ] **Step 3: Write minimal implementation**

In `packages/store/src/store.ts`:

(a) Update the `Store` interface `get` signature:

```ts
  get(ref: Ref, reader: Identity, now?: string): Promise<Uint8Array>;
```

(b) Replace `get` (currently lines ~63-68):

```ts
  async get(ref: Ref, reader: Identity, now?: string): Promise<Uint8Array> {
    const nowMs = now === undefined ? Date.now() : Date.parse(now);
    return decrypt(
      this.#currentObject(ref.plaintext_id),
      this.#contentKeyVia(ref.plaintext_id, reader, nowMs)
    );
  }
```

(c) Replace `#capabilityFor` and `#contentKeyVia` to take `nowMs`:

```ts
  // Returns the capability for did within the plaintext object, if valid at nowMs.
  #capabilityFor(
    plaintextId: string,
    did: string,
    nowMs: number
  ): Capability | undefined {
    return (this.#caps.get(plaintextId) ?? []).find(
      (c) =>
        c.grantee === did &&
        verifyCapability(c) &&
        Date.parse(c.not_before) <= nowMs
    );
  }

  // Resolves the content key for who by locating and unwrapping their capability.
  // Throws AccessDenied if who has no valid capability at nowMs.
  #contentKeyVia(plaintextId: string, who: Identity, nowMs: number): Uint8Array {
    const cap = this.#capabilityFor(plaintextId, who.did, nowMs);
    if (cap === undefined) {
      throw new AccessDenied(who.did);
    }
    return unwrapKey(cap, who);
  }
```

(d) Update the two existing call sites in `grant` and `revoke` (they act as the live granter — pass `Date.now()`):

In `grant`, change `this.#contentKeyVia(ref.plaintext_id, by)` to `this.#contentKeyVia(ref.plaintext_id, by, Date.now())`.
In `revoke`, change `this.#contentKeyVia(ref.plaintext_id, by)` to `this.#contentKeyVia(ref.plaintext_id, by, Date.now())`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/store && AGENT=1 bun test test/store.test.ts`
Expected: PASS — all existing store tests still green plus the new one.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/store.ts packages/store/test/store.test.ts
git commit -m "refactor(store): thread an injected clock through get"   # + standard trailers
```

---

### Task 4: `scheduleReveal`, `reveal`, and the withheld `#pending` queue

**Files:**
- Modify: `packages/store/src/store.ts` (imports; `Store` interface; `MemoryStore` fields and methods)
- Test: `packages/store/test/membrane.test.ts`

**Interfaces:**
- Consumes: `publicIdentity`, `publicDid` (Task 2); `issueCapability` (existing); the injected-clock internals (Task 3).
- Produces:
  - `Store.scheduleReveal(ref: Ref, at: string, by: Identity): Promise<void>` — seals the content key to `publicIdentity()` with `not_before = at`, parked in `#pending`.
  - `Store.reveal(ref: Ref, now?: string): Promise<boolean>` — promotes due pending reveals into the served set; returns `true` if anything was released.
  - `Store.caps(plaintextId: string): readonly Capability[]` — the served (mirror-visible) capabilities for an object; pending reveals are excluded.

- [ ] **Step 1: Write the failing test**

Add to `packages/store/test/membrane.test.ts` (add the imports it needs at the top: `Identity` from `@thaddeus.run/identity`, and `MemoryStore` from `../src/store`):

```ts
describe('scheduled reveal (manual trigger)', () => {
  const T = '2030-01-01T00:00:00.000Z';
  const beforeT = '2026-06-23T00:00:00.000Z';

  test('withheld until released, then public can read', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const ref = await store.put(new TextEncoder().encode('fix'), author);
    await store.scheduleReveal(ref, T, author);

    // Withheld: no served capability is wrapped to the public identity.
    expect(
      store.caps(ref.plaintext_id).some((c) => c.grantee === publicDid())
    ).toBe(false);
    // And the public identity cannot read before release, even at a far-future now.
    await expect(store.get(ref, publicIdentity(), T)).rejects.toThrow();

    // Releasing before T does nothing.
    expect(await store.reveal(ref, beforeT)).toBe(false);

    // Release at T: the public capability is now served and readable.
    expect(await store.reveal(ref, T)).toBe(true);
    expect(
      store.caps(ref.plaintext_id).some((c) => c.grantee === publicDid())
    ).toBe(true);
    expect(new TextDecoder().decode(await store.get(ref, publicIdentity(), T))).toBe(
      'fix'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/store && AGENT=1 bun test test/membrane.test.ts -t 'withheld until released'`
Expected: FAIL — `store.scheduleReveal is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `packages/store/src/store.ts`:

(a) Add to the membrane import — add `publicIdentity` is NOT needed here if we import from `./membrane`. Add this import near the top (after the `./object` import):

```ts
import { publicIdentity } from './membrane';
```

(b) Add to the `Store` interface (after `revoke`):

```ts
  scheduleReveal(ref: Ref, at: string, by: Identity): Promise<void>;
  reveal(ref: Ref, now?: string): Promise<boolean>;
  caps(plaintextId: string): readonly Capability[];
```

(c) Add the `#pending` field to `MemoryStore` (next to `#caps`):

```ts
  readonly #pending: Map<string, Capability[]> = new Map();
```

(d) Add these methods to `MemoryStore` (after `revoke`):

```ts
  // Schedule a withheld reveal: `by` (who must hold the content key) seals it to
  // the well-known public identity with not_before = at, parked in #pending.
  // Nothing is served or mirror-visible until a trigger fires (#releaseDue).
  async scheduleReveal(ref: Ref, at: string, by: Identity): Promise<void> {
    const contentKey = this.#contentKeyVia(ref.plaintext_id, by, Date.now());
    const cap = issueCapability({
      object: ref.plaintext_id,
      contentKey,
      grantee: publicIdentity().toPublic(),
      grantedBy: by,
      notBefore: at,
    });
    const pend = this.#pending.get(ref.plaintext_id) ?? [];
    pend.push(cap);
    this.#pending.set(ref.plaintext_id, pend);
  }

  // Manual trigger: promote due pending reveals into the served set.
  async reveal(ref: Ref, now?: string): Promise<boolean> {
    const nowMs = now === undefined ? Date.now() : Date.parse(now);
    return this.#releaseDue(ref.plaintext_id, nowMs);
  }

  // The served (mirror-visible) capabilities for an object. Pending reveals are
  // withheld and never appear here until released.
  caps(plaintextId: string): readonly Capability[] {
    return this.#caps.get(plaintextId) ?? [];
  }

  // The key-release event: move pending reveals whose not_before <= nowMs into
  // the served #caps set. Returns true if anything was released.
  #releaseDue(plaintextId: string, nowMs: number): boolean {
    const pend = this.#pending.get(plaintextId);
    if (pend === undefined || pend.length === 0) {
      return false;
    }
    const due = pend.filter((c) => Date.parse(c.not_before) <= nowMs);
    if (due.length === 0) {
      return false;
    }
    this.#pending.set(
      plaintextId,
      pend.filter((c) => Date.parse(c.not_before) > nowMs)
    );
    const served = this.#caps.get(plaintextId) ?? [];
    served.push(...due);
    this.#caps.set(plaintextId, served);
    return true;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/store && AGENT=1 bun test test/membrane.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/store.ts packages/store/test/membrane.test.ts
git commit -m "feat(store): scheduleReveal + manual reveal via withheld pending queue"   # + standard trailers
```

---

### Task 5: Lazy reveal-on-`get` (the timestamp trigger)

**Files:**
- Modify: `packages/store/src/store.ts` (`get`)
- Test: `packages/store/test/membrane.test.ts`

**Interfaces:**
- Consumes: `#releaseDue` (Task 4), injected-clock `get` (Task 3).
- Produces: no signature change — `get` now promotes due pending reveals before resolving the key, so a read at/after T succeeds with no explicit `reveal()` call.

- [ ] **Step 1: Write the failing test**

Add to `packages/store/test/membrane.test.ts`, inside a new describe:

```ts
describe('scheduled reveal (timestamp trigger, lazy on get)', () => {
  const T = '2030-01-01T00:00:00.000Z';
  const beforeT = '2026-06-23T00:00:00.000Z';

  test('public read fires the reveal at or after T without a manual call', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const ref = await store.put(new TextEncoder().encode('fix'), author);
    await store.scheduleReveal(ref, T, author);

    // Before T: still denied (the read attempt releases nothing).
    await expect(store.get(ref, publicIdentity(), beforeT)).rejects.toThrow();
    // At/after T: the get itself triggers the key-release.
    expect(new TextDecoder().decode(await store.get(ref, publicIdentity(), T))).toBe(
      'fix'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/store && AGENT=1 bun test test/membrane.test.ts -t 'lazy on get'`
Expected: FAIL — at `now = T` the public capability is still in `#pending` (never released), so `get` throws `AccessDenied`.

- [ ] **Step 3: Write minimal implementation**

In `packages/store/src/store.ts`, update `get` to release due reveals first:

```ts
  async get(ref: Ref, reader: Identity, now?: string): Promise<Uint8Array> {
    const nowMs = now === undefined ? Date.now() : Date.parse(now);
    this.#releaseDue(ref.plaintext_id, nowMs);
    return decrypt(
      this.#currentObject(ref.plaintext_id),
      this.#contentKeyVia(ref.plaintext_id, reader, nowMs)
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/store && AGENT=1 bun test test/membrane.test.ts`
Expected: PASS — both manual and lazy reveal tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/store.ts packages/store/test/membrane.test.ts
git commit -m "feat(store): lazy reveal-on-get timestamp trigger"   # + standard trailers
```

---

### Task 6: `revoke` interaction — survive rotation, cancel a pending reveal

**Files:**
- Modify: `packages/store/src/store.ts` (`revoke`)
- Test: `packages/store/test/membrane.test.ts`

**Interfaces:**
- Produces: `revoke` now (a) preserves each re-issued capability's original `not_before`, (b) re-keys pending reveals to the new content key (a pending reveal survives rotation), and (c) cancels a still-pending reveal when the revoked grantee is the public identity.

- [ ] **Step 1: Write the failing test**

Add to `packages/store/test/membrane.test.ts`, in a new describe:

```ts
describe('reveal interaction with revoke', () => {
  const T = '2030-01-01T00:00:00.000Z';

  test('a scheduled reveal survives a key rotation', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const bob = Identity.create();
    const ref = await store.put(new TextEncoder().encode('fix'), author);
    await store.scheduleReveal(ref, T, author);
    await store.grant(ref, bob.toPublic(), author);
    await store.revoke(ref, bob.toPublic(), author); // rotates the content key

    // The pending reveal was re-keyed; at T the public reads the live object.
    expect(new TextDecoder().decode(await store.get(ref, publicIdentity(), T))).toBe(
      'fix'
    );
  });

  test('revoking the public identity cancels a pending reveal', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const ref = await store.put(new TextEncoder().encode('fix'), author);
    await store.scheduleReveal(ref, T, author);
    await store.revoke(ref, publicIdentity().toPublic(), author); // cancel

    await expect(store.get(ref, publicIdentity(), T)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/store && AGENT=1 bun test test/membrane.test.ts -t 'revoke'`
Expected: FAIL — the "survives a key rotation" test throws `AccessDenied` at T, because the pending reveal still wraps the old (now-inert) key.

- [ ] **Step 3: Write minimal implementation**

In `packages/store/src/store.ts`, replace the `revoke` method body. The two changes vs. the current implementation: re-issue served caps **preserving `not_before`**, and re-key (and filter) the `#pending` reveals too.

```ts
  async revoke(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void> {
    const oldKey = this.#contentKeyVia(ref.plaintext_id, by, Date.now());
    const plaintext = decrypt(this.#currentObject(ref.plaintext_id), oldKey);

    // Rotate: new key, re-encrypt, supersede the current object.
    const newKey = newContentKey();
    const rotated = encrypt(plaintext, newKey);
    this.#objects.set(rotated.id, rotated);
    this.#current.set(ref.plaintext_id, rotated.id);

    // Re-wrap each remaining capability (served and pending) to the new key,
    // preserving its original start time. The revoked grantee is dropped from
    // both sets — so revoking the public identity cancels a pending reveal.
    const rewrap = (caps: Capability[]): Capability[] =>
      caps
        .filter((c) => c.grantee !== grantee.did)
        .map((c) =>
          issueCapability({
            object: ref.plaintext_id,
            contentKey: newKey,
            grantee: PublicIdentity.fromDid(c.grantee),
            grantedBy: by,
            notBefore: c.not_before,
          })
        );

    this.#caps.set(ref.plaintext_id, rewrap(this.#caps.get(ref.plaintext_id) ?? []));
    this.#pending.set(
      ref.plaintext_id,
      rewrap(this.#pending.get(ref.plaintext_id) ?? [])
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/store && AGENT=1 bun test test/membrane.test.ts`
Expected: PASS — all membrane tests green.

Also confirm no regression in the existing suite:
Run: `cd packages/store && AGENT=1 bun test`
Expected: PASS — store, capability, object, membrane tests all green.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/store.ts packages/store/test/membrane.test.ts
git commit -m "feat(store): reveals survive rotation; revoke(public) cancels a pending reveal"   # + standard trailers
```

---

### Task 7: Disclosure CLI demo

**Files:**
- Create: `examples/disclosure/package.json`
- Create: `examples/disclosure/moon.yml`
- Create: `examples/disclosure/tsconfig.json`
- Create: `examples/disclosure/src/disclosure.ts`

**Interfaces:**
- Consumes: `MemoryStore`, `address`, `publicIdentity`, `publicDid` from `@thaddeus.run/store`; `Identity`, `ready` from `@thaddeus.run/identity`.

- [ ] **Step 1: Create the package scaffold**

Create `examples/disclosure/package.json`:

```json
{
  "name": "@thaddeus.run/example-disclosure",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/store": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "catalog:"
  }
}
```

Create `examples/disclosure/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

language: 'typescript'
layer: 'application'

tasks:
  # No test suite yet; keep `moon run :test` green repo-wide.
  test:
    args: '--pass-with-no-tests'

  # Build-graph-connected, so CI-skipped; run in agent shells with a CI= prefix.
  demo:
    command: 'bun src/disclosure.ts'
    deps:
      - '^:build'
    options:
      cache: false
      runInCI: 'skip'
```

Create `examples/disclosure/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.options.json",
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules"],
  "compilerOptions": {
    "noEmit": true,
    "lib": ["ES2023"],
    "types": ["@types/bun"],
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler"
  }
}
```

- [ ] **Step 2: Write the demo script**

Create `examples/disclosure/src/disclosure.ts`:

```ts
// Coordinated-disclosure demo for @thaddeus.run/store (Pillar 02 — the membrane).
// Run: CI= moon run disclosure:demo
//
// One CVE, private merge to public reveal: the fix is ciphertext at rest, sits
// on an untrusted mirror the whole embargo, and becomes world-readable at a
// scheduled time T via a key-release — not a flag flip, not a scramble.

import { Identity, ready } from '@thaddeus.run/identity';
import { address, MemoryStore, publicDid, publicIdentity } from '@thaddeus.run/store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const hex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
const rule = (): void => console.log('—'.repeat(60));

await ready();
const store = new MemoryStore();
const maintainer = Identity.create();

const REVEAL_AT = '2026-07-05T00:00:00.000Z'; // the disclosure deadline T
const beforeT = '2026-07-01T00:00:00.000Z';

const patch = 'fix(auth): constant-time token compare — CVE-2026-1234';
const ref = await store.put(enc(patch), maintainer);
console.log('1. Maintainer commits the fix. object id =', `${ref.id.slice(0, 16)}…`);

const raw = store.rawObject(ref.id)!;
console.log('2. Stored bytes (first 32):', hex(raw.ciphertext.slice(0, 32)));
console.log('   mirror verifies blake3(ciphertext) === id, no key:', address(raw.ciphertext) === ref.id);
rule();

await store.scheduleReveal(ref, REVEAL_AT, maintainer);
console.log('3. Reveal scheduled for', REVEAL_AT);
console.log(
  '   served capability wrapped to public yet?',
  store.caps(ref.plaintext_id).some((c) => c.grantee === publicDid()),
  '← withheld: the mirror holds only ciphertext'
);
rule();

try {
  await store.get(ref, publicIdentity(), beforeT);
} catch (err) {
  console.log('4. Public reads before T:', (err as Error).name);
}

console.log(
  '5. At T, public reads:',
  JSON.stringify(dec(await store.get(ref, publicIdentity(), REVEAL_AT)))
);
console.log(
  '   served capability wrapped to public now?',
  store.caps(ref.plaintext_id).some((c) => c.grantee === publicDid()),
  '← key-release fired'
);
rule();
console.log(
  'ciphertext on the mirror the whole embargo · reveal = a scheduled key-release the maintainer owns'
);
```

- [ ] **Step 3: Register the new workspace package**

Run: `bun install`
Expected: completes; `@thaddeus.run/example-disclosure` is linked (resolves `workspace:*`).

- [ ] **Step 4: Run the demo**

Run: `AGENT=1 CI= moon run disclosure:demo`
Expected: prints steps 1–5; step 3 shows `false` (withheld), step 4 prints `AccessDenied`, step 5 prints the patch string and `true` (released).

- [ ] **Step 5: Commit**

```bash
git add examples/disclosure
git commit -m "feat(examples): coordinated-disclosure CLI demo for the membrane"   # + standard trailers
```

---

### Task 8: North-star integration swap (P02 stub → real)

**Files:**
- Modify: `integration/test/one-edit-end-to-end.test.ts` (replace the P02 `test.todo` at lines ~42-43; keep the P03/P04 todos)

**Interfaces:**
- Consumes: `MemoryStore`, `publicIdentity` from `@thaddeus.run/store`; `Identity` (already imported).

- [ ] **Step 1: Update imports**

In `integration/test/one-edit-end-to-end.test.ts`, change the store import (line 2) to include `publicIdentity`:

```ts
import { MemoryStore, publicIdentity } from '@thaddeus.run/store';
```

- [ ] **Step 2: Replace the P02 todo with a real test**

Replace these two lines (the P02 `// @ts-expect-error` comment and its `test.todo`):

```ts
  // @ts-expect-error bun-types@1.3.12 requires a fn arg, but the runtime supports label-only todo
  test.todo('P02: a scheduled reveal re-wraps the content key to public at T');
```

with:

```ts
  test('P02: a scheduled reveal re-wraps the content key to public at T', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const ref = await store.put(new TextEncoder().encode('fn refresh() {}'), author);

    const T = '2030-01-01T00:00:00.000Z';
    await store.scheduleReveal(ref, T, author);

    // Embargo: ciphertext is mirror-verifiable; the public cannot read before T.
    expect(store.verify(ref.id)).toBe(true);
    await expect(
      store.get(ref, publicIdentity(), '2026-06-23T00:00:00.000Z')
    ).rejects.toThrow();

    // At T the content key re-wraps to public and the world can read.
    expect(
      new TextDecoder().decode(await store.get(ref, publicIdentity(), T))
    ).toBe('fn refresh() {}');
  });
```

Leave the P03 and P04 `// @ts-expect-error` + `test.todo` lines unchanged.

- [ ] **Step 3: Run the integration test**

Run: `AGENT=1 moonx integration:test`
Expected: PASS — `3 pass, 2 todo, 0 fail` (was `2 pass, 3 todo`).

- [ ] **Step 4: Commit**

```bash
git add integration/test/one-edit-end-to-end.test.ts
git commit -m "test(integration): north-star P02 reveal now runs for real"   # + standard trailers
```

---

### Task 9: Docs — flip status and changelog

**Files:**
- Modify: `ARCHITECTURE.md` (the Pillar 02 row, ~line 39)
- Modify: `CHANGELOG.md` (`[Unreleased] → Added`; the Deferred ledger's in-design line)

**Interfaces:** none (docs only).

- [ ] **Step 1: Flip the Pillar 02 status row**

In `ARCHITECTURE.md`, replace the Pillar 02 row:

```
| 02 Membrane (time-varying visibility) | _(planned)_          | planned | P2 P3 P4         |
```

with:

```
| 02 Membrane (time-varying visibility) | `store`              | built   | P2 P4            |
```

(P3 is intentionally dropped from this row: only the payload half of P02 shipped; metadata-gating that resolves P3 is deferred — tracked in `CHANGELOG.md`.)

- [ ] **Step 2: Add the membrane to the changelog Added section**

In `CHANGELOG.md`, under `## [Unreleased] → ### Added`, append:

```
- `@thaddeus.run/store` — scheduled timed reveal ("the membrane", Pillar 02):
  `scheduleReveal`/`reveal` release an object's payload to a well-known public
  identity at time T via a withheld key-release. Payload only; metadata-gating
  deferred (see below). `@thaddeus.run/identity` gains `Identity.fromSeed`.
```

- [ ] **Step 3: Graduate the in-design line in the Deferred ledger**

In `CHANGELOG.md`, under `### Scope-cut`, remove this line (the membrane payload half has shipped):

```
- **P02 membrane** — time-varying visibility / scheduled reveal. _(In design.)_
```

The two P02 research items (trustless timed reveal, metadata-gating) stay in the **Research** bucket unchanged — they are still owed.

- [ ] **Step 4: Verify the full baseline**

Run:
```bash
AGENT=1 moon run root:format root:lint
AGENT=1 moonx identity:test store:test integration:test
AGENT=1 moonx identity:typecheck store:typecheck
```
Expected: format/lint clean; all tests green (`identity: 5 pass`, `store: all pass incl. membrane`, `integration: 3 pass 2 todo`); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: mark Pillar 02 membrane built; changelog + ledger update"   # + standard trailers
```

---

## Self-Review

**1. Spec coverage** (spec §5 In / §6 / §7 / §9 / §10 / §12):
- `scheduleReveal` / `reveal` → Task 4. ✔
- `get(ref, reader, now?)` injected clock + lazy release → Tasks 3, 5. ✔
- Well-known `public` identity → Task 2. ✔
- `Identity.fromSeed` → Task 1. ✔
- `revoke` re-keys pending + cancel via `revoke(public)` → Task 6. ✔
- Disclosure CLI demo → Task 7. ✔
- North-star P02 swap → Task 8. ✔
- `ARCHITECTURE.md` + `CHANGELOG.md` → Task 9. ✔
- Acceptance criteria §10: embargo holds (T4), reveal fires lazy+manual (T4/T5), withheld-not-honor-system via `caps()` (T4), survives rotation (T6), cancellable (T6), determinism via injected now (T3/T4/T5/T6), signed/verifiable (reuses `issueCapability`/`verifyCapability`, exercised in T4), composition (T8). ✔ The `caps()` accessor is the testable surface for the "withheld" property — added in Task 4, used by the demo (T7) too.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✔

**3. Type consistency:** `now?: string` (ISO) consistently parsed via `Date.parse`; `#releaseDue(plaintextId, nowMs)`, `#capabilityFor(plaintextId, did, nowMs)`, `#contentKeyVia(plaintextId, who, nowMs)` all take `nowMs: number`; `scheduleReveal(ref, at, by)` / `reveal(ref, now?)` / `caps(plaintextId)` match the `Store` interface and `MemoryStore`; `publicIdentity()`/`publicDid()` names consistent across membrane, store, demo, integration. `issueCapability` re-issue in `revoke` now passes `notBefore: c.not_before` (preserves start time) — consistent with Task 4's use. ✔

> Note: Task 3's `get honors an injected now` test verifies the clock plumbing with an always-valid (EPOCH) grant read at an early `now`; the future-`not_before` enforcement is covered end-to-end by the embargo tests in Tasks 4–5 (public cap with `not_before = T`). This avoids needing a public `issueCapability`-with-future-time path before the membrane exists.
