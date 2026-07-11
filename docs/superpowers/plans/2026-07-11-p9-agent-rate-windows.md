# P9 Agent Rate Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce an optional per-hour rate window on agent delegations
(`thaddeus grant <did> --max-changes-per-hour N`), composing with the existing
lifetime `maxChanges` cap.

**Architecture:** A nullable `maxChangesPerHour` field on the signed
`Delegation` record with presence-keyed canonicalization (records without the
field sign/verify the exact legacy v1 tuple, so every existing grant keeps
verifying). A sliding one-hour window accounted inside `AgentRegistry`
(injectable clock), enforced by `delegationPolicy` with a distinct rejection
reason. The server's persisted-meter replay bypasses window accounting so a
restart never attributes lifetime totals to the current hour.

**Tech Stack:** TypeScript (Bun workspace), bun:test, moon task runner.

**Spec:** `docs/superpowers/specs/2026-07-11-p9-agent-rate-windows-design.md`

## Global Constraints

- Run `export AGENT=1` at the start of every shell session (AGENTS.md).
- Bun only (no npm/npx); tasks via `moonx <project>:<task>`.
- The window is fixed at ONE hour (`3_600_000` ms); the record field is a count,
  not a `{count, windowMs}` pair.
- `maxChangesPerHour` semantics: `null`/absent = no rate limit; `0` = zero
  changes allowed per hour (legal).
- A record without the field must produce canonical bytes BYTE-IDENTICAL to the
  pre-P9 tuple.
- No new dependencies. Preserve trailing newlines. Conventional Commits.
- Verification baseline after code changes: `moon run root:format root:lint`,
  plus `moonx <project>:typecheck` and focused tests for touched projects.
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  are authored via
  `git -c user.name="Moritz" -c user.email="moritz@devmtkl.com" commit …` (no
  global git identity is configured).

---

### Task 1: Delegation record — `maxChangesPerHour` with presence-keyed canonicalization

**Files:**

- Modify: `packages/agent/src/delegation.ts`
- Test: `packages/agent/test/delegation.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `DelegationFields.maxChangesPerHour?: number | null` (optional
  field; later tasks read `d.maxChangesPerHour`);
  `canonicalDelegation`/`signDelegation`/`verifyDelegation` accept it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/agent/test/delegation.test.ts` (inside the existing
`describe`; the file already imports `Identity`, `signDelegation`,
`verifyDelegation`, `canonicalDelegation` — extend the import if a name is
missing):

```ts
describe('maxChangesPerHour (P9 rate window)', () => {
  const fields = (agent: Identity) =>
    ({
      agent: agent.did,
      paths: ['src/**'],
      maxChanges: 5,
      maxSpend: 100,
    }) as const;

  test('a pre-P9 record and a new no-cap grant sign the identical v1 tuple', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const f = fields(agent);
    // Reproduce the legacy canonical bytes exactly as the old code built them.
    const legacyBytes = new TextEncoder().encode(
      JSON.stringify([
        'thaddeus.delegation.v1',
        operator.did,
        f.agent,
        [...f.paths],
        f.maxChanges,
        f.maxSpend,
      ])
    );
    const legacy = {
      ...f,
      operator: operator.did,
      sig: operator.sign(legacyBytes),
    };
    expect(verifyDelegation(legacy)).toBe(true); // old grant still verifies
    // A new grant without the field verifies against the SAME bytes.
    const fresh = signDelegation(f, operator);
    expect(verifyDelegation({ ...fresh, sig: legacy.sig })).toBe(true);
    // Explicit null is byte-identical to absent.
    const explicit = signDelegation(
      { ...f, maxChangesPerHour: null },
      operator
    );
    expect(verifyDelegation({ ...explicit, sig: legacy.sig })).toBe(true);
  });

  test('a rate-capped grant verifies and rejects tampering with the cap', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    const d = signDelegation(
      { ...fields(agent), maxChangesPerHour: 3 },
      operator
    );
    expect(d.maxChangesPerHour).toBe(3);
    expect(verifyDelegation(d)).toBe(true);
    expect(verifyDelegation({ ...d, maxChangesPerHour: 4 })).toBe(false);
    expect(verifyDelegation({ ...d, maxChangesPerHour: null })).toBe(false);
  });

  test('canonicalization rejects a negative or fractional cap; zero is legal', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    expect(() =>
      signDelegation({ ...fields(agent), maxChangesPerHour: -1 }, operator)
    ).toThrow(TypeError);
    expect(() =>
      signDelegation({ ...fields(agent), maxChangesPerHour: 1.5 }, operator)
    ).toThrow(TypeError);
    expect(
      verifyDelegation(
        signDelegation({ ...fields(agent), maxChangesPerHour: 0 }, operator)
      )
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/agent && AGENT=1 bun test test/delegation.test.ts` Expected:
FAIL — TypeScript/objects reject `maxChangesPerHour` (unknown property) and
tamper test fails because the field is not signed.

- [ ] **Step 3: Implement the field + presence-keyed canonicalization**

In `packages/agent/src/delegation.ts`:

Add to `DelegationFields` (after `maxSpend`):

```ts
  // Per-hour rate window (P9): max ops the agent may land within any trailing
  // hour. `null`/absent = no rate limit. Optional so records signed before the
  // field existed — and their many constructor sites — stay valid.
  readonly maxChangesPerHour?: number | null;
```

Add to `assertCanonical` (after the `maxSpend` check):

```ts
const rate = core.maxChangesPerHour;
if (
  rate !== undefined &&
  rate !== null &&
  (!Number.isInteger(rate) || rate < 0)
) {
  throw new TypeError(
    'delegation.maxChangesPerHour must be a non-negative integer or null'
  );
}
```

Replace the body of `canonicalDelegation`'s return with a presence-keyed tuple:

```ts
export function canonicalDelegation(core: DelegationCore): Uint8Array {
  assertCanonical(core);
  const v1 = [
    DELEGATION_DOMAIN,
    core.operator,
    core.agent,
    [...core.paths],
    core.maxChanges,
    core.maxSpend,
  ];
  // Presence-keyed compatibility: a record without a rate cap signs the exact
  // legacy v1 tuple, so pre-P9 grants and new no-limit grants verify
  // identically everywhere; only a real cap extends the signed tuple.
  return new TextEncoder().encode(
    JSON.stringify(
      core.maxChangesPerHour == null ? v1 : [...v1, core.maxChangesPerHour]
    )
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent && AGENT=1 bun test` Expected: PASS (all agent tests,
old and new).

- [ ] **Step 5: Typecheck and commit**

Run: `AGENT=1 moonx agent:typecheck` — expected clean.

```bash
git add packages/agent/src/delegation.ts packages/agent/test/delegation.test.ts
git -c user.name="Moritz" -c user.email="moritz@devmtkl.com" commit -m "feat(agent): add signed per-hour rate cap to delegations

Presence-keyed canonicalization keeps every pre-P9 grant verifying.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Registry — injectable clock, sliding window, `replayMeter`

**Files:**

- Modify: `packages/agent/src/registry.ts`
- Test: `packages/agent/test/registry.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `new AgentRegistry(now?: () => number)`;
  `recentChanges(agent: string): number`;
  `replayMeter(agent: string, changes: number, spend?: number): void`.
  `record()` signature unchanged but now also feeds the window.

- [ ] **Step 1: Write the failing tests**

Append to `packages/agent/test/registry.test.ts` (reuses the existing
`grant(operator, agent)` helper):

```ts
describe('hourly rate window (P9)', () => {
  test('record feeds the trailing-hour window; entries expire after an hour', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    let t = 1_000_000;
    const reg = new AgentRegistry(() => t);
    reg.register(grant(operator, agent));
    expect(reg.recentChanges(agent.did)).toBe(0);
    reg.record(agent.did, 2);
    t += 30 * 60_000; // +30min
    reg.record(agent.did, 1);
    expect(reg.recentChanges(agent.did)).toBe(3);
    t += 31 * 60_000; // first entry is now 61min old
    expect(reg.recentChanges(agent.did)).toBe(1);
    t += 60 * 60_000; // everything expired
    expect(reg.recentChanges(agent.did)).toBe(0);
    // Lifetime totals are unaffected by window expiry.
    expect(reg.usage(agent.did).changes).toBe(3);
  });

  test('replayMeter restores lifetime totals without touching the window', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    let t = 1_000_000;
    const reg = new AgentRegistry(() => t);
    reg.register(grant(operator, agent));
    reg.replayMeter(agent.did, 4, 10);
    expect(reg.usage(agent.did)).toEqual({ changes: 4, spend: 10 });
    expect(reg.recentChanges(agent.did)).toBe(0);
    expect(() => reg.replayMeter('did:key:zUnknown', 1)).toThrow(TypeError);
  });

  test('re-registering preserves both the lifetime meter and the window', () => {
    const operator = Identity.create();
    const agent = Identity.create();
    let t = 1_000_000;
    const reg = new AgentRegistry(() => t);
    reg.register(grant(operator, agent));
    reg.record(agent.did, 2);
    reg.register(grant(operator, agent));
    expect(reg.usage(agent.did).changes).toBe(2);
    expect(reg.recentChanges(agent.did)).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/agent && AGENT=1 bun test test/registry.test.ts` Expected:
FAIL — constructor takes no argument / `recentChanges` and `replayMeter` are not
functions.

- [ ] **Step 3: Implement clock, window, replayMeter**

In `packages/agent/src/registry.ts`:

Add above the class:

```ts
// The fixed P9 rate-window span. The Delegation field is a count per trailing
// hour, not a configurable window — see the design doc's non-goals.
const HOUR_MS = 3_600_000;
```

Add fields + constructor to `AgentRegistry` (after the existing `#meter` field):

```ts
  // Timestamped landings inside the trailing hour, per agent — the P9 rate
  // window. Pruned lazily on record/read; never persisted (a restart forgets
  // the current hour, documented spike behavior).
  readonly #window: Map<string, { at: number; changes: number }[]> = new Map();
  readonly #now: () => number;

  // The clock is injectable so window expiry is testable without sleeping.
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }
```

Extract the current `record()` body into a private `#accumulate`, then make
`record` also feed the window and add `replayMeter` and `recentChanges`:

```ts
  // Shared validation + lifetime accumulation for record/replayMeter.
  #accumulate(agent: string, changes: number, spend: number): void {
    if (!this.#grants.has(agent)) {
      throw new TypeError(
        `cannot record usage for unregistered agent ${agent}`
      );
    }
    if (!Number.isInteger(changes) || changes < 0) {
      throw new TypeError('changes must be a non-negative integer');
    }
    if (!Number.isFinite(spend) || spend < 0) {
      throw new TypeError('spend must be a finite number >= 0');
    }
    const u = this.#meter.get(agent) ?? { changes: 0, spend: 0 };
    this.#meter.set(agent, {
      changes: u.changes + changes,
      spend: u.spend + spend,
    });
  }

  // After a successful land: += `changes` (the number of ops landed, matching
  // what delegationPolicy counts) and += spend for the agent. The policy never
  // calls this — recording is the caller's post-land step. Re-registering a
  // delegation does NOT reset the meter (the budget is a lifetime cap).
  record(agent: string, changes: number, spend = 0): void {
    this.#accumulate(agent, changes, spend);
    if (changes > 0) {
      const entries = this.#window.get(agent) ?? [];
      entries.push({ at: this.#now(), changes });
      this.#window.set(agent, this.#prune(entries));
    }
  }

  // Restore persisted lifetime totals WITHOUT window accounting. The server's
  // registry rebuild replays durable meters through this — recording them via
  // record() would stamp an agent's whole history into the current hour and
  // block it until the window slides.
  replayMeter(agent: string, changes: number, spend = 0): void {
    this.#accumulate(agent, changes, spend);
  }

  // Changes landed within the trailing hour (the P9 rate-window numerator).
  recentChanges(agent: string): number {
    const entries = this.#window.get(agent);
    if (entries === undefined) {
      return 0;
    }
    const pruned = this.#prune(entries);
    this.#window.set(agent, pruned);
    return pruned.reduce((sum, e) => sum + e.changes, 0);
  }

  #prune(
    entries: readonly { at: number; changes: number }[]
  ): { at: number; changes: number }[] {
    const cutoff = this.#now() - HOUR_MS;
    return entries.filter((e) => e.at > cutoff);
  }
```

(The old `record()` body is replaced by the `#accumulate` + new `record` pair
above; keep its doc comment on `record`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent && AGENT=1 bun test` Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `AGENT=1 moonx agent:typecheck` — expected clean.

```bash
git add packages/agent/src/registry.ts packages/agent/test/registry.test.ts
git -c user.name="Moritz" -c user.email="moritz@devmtkl.com" commit -m "feat(agent): meter a sliding one-hour window in the registry

replayMeter restores durable lifetime totals without poisoning the
window on server restart.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Policy — enforce the hourly window

**Files:**

- Modify: `packages/agent/src/policy.ts`
- Test: `packages/agent/test/policy.test.ts`

**Interfaces:**

- Consumes: `Delegation.maxChangesPerHour` (Task 1),
  `AgentRegistry.recentChanges` / injectable clock (Task 2).
- Produces: rejection reason string
  `agent <did> is over its hourly rate window`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/agent/test/policy.test.ts` (reuses the existing
`proposal(ops)` and `op(agent, path)` helpers):

```ts
describe('hourly rate window (P9)', () => {
  test('rejects a landing that exceeds the cap inside the window, allows it after the window slides', async () => {
    const operator = Identity.create();
    const agent = Identity.create();
    let t = 1_000_000;
    const reg = new AgentRegistry(() => t);
    reg.register(
      signDelegation(
        {
          agent: agent.did,
          paths: ['src/**'],
          maxChanges: 100,
          maxSpend: 100,
          maxChangesPerHour: 2,
        },
        operator
      )
    );
    const policy = delegationPolicy(reg);
    // Two ops land and are recorded — the window is now full.
    reg.record(agent.did, 2);
    const third = proposal([await op(agent, 'src/a.rs')]);
    const rejected = await policy(third);
    expect(rejected.allow).toBe(false);
    expect(rejected).toMatchObject({
      reason: `agent ${agent.did} is over its hourly rate window`,
    });
    // An hour later the window is empty; the same landing is allowed.
    t += 61 * 60_000;
    expect((await policy(third)).allow).toBe(true);
  });

  test('lifetime and hourly caps compose; a null cap never rate-limits', async () => {
    const operator = Identity.create();
    const capped = Identity.create();
    const uncapped = Identity.create();
    let t = 1_000_000;
    const reg = new AgentRegistry(() => t);
    // Lifetime nearly exhausted, hourly cap generous → lifetime trips first.
    reg.register(
      signDelegation(
        {
          agent: capped.did,
          paths: ['**'],
          maxChanges: 1,
          maxSpend: 100,
          maxChangesPerHour: 10,
        },
        operator
      )
    );
    reg.record(capped.did, 1);
    const lifetime = await delegationPolicy(reg)(
      proposal([await op(capped, 'src/a.rs')])
    );
    expect(lifetime.allow).toBe(false);
    expect(lifetime).toMatchObject({
      reason: `agent ${capped.did} is over its change budget`,
    });
    // No hourly cap → heavy recent usage does not rate-limit.
    reg.register(
      signDelegation(
        { agent: uncapped.did, paths: ['**'], maxChanges: 100, maxSpend: 100 },
        operator
      )
    );
    reg.record(uncapped.did, 50);
    expect(
      (await delegationPolicy(reg)(proposal([await op(uncapped, 'src/a.rs')])))
        .allow
    ).toBe(true);
  });

  test('an exempt author skips the hourly window', async () => {
    const owner = Identity.create();
    let t = 1_000_000;
    const reg = new AgentRegistry(() => t);
    const policy = delegationPolicy(reg, (a) => a === owner.did);
    expect((await policy(proposal([await op(owner, 'src/a.rs')]))).allow).toBe(
      true
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/agent && AGENT=1 bun test test/policy.test.ts` Expected: FAIL
— the first test's rejection comes back `allow: true` (no hourly check exists
yet).

- [ ] **Step 3: Implement the check**

In `packages/agent/src/policy.ts`, inside the
`for (const [agent, count] of countByAgent)` loop, immediately after the
existing lifetime `maxChanges` rejection block and before the spend check, add:

```ts
// P9 rate window: reject a landing that would push the agent past its
// per-hour cap. `null`/absent = no rate limit; composes with (does not
// replace) the lifetime cap above.
const rate = d.maxChangesPerHour;
if (rate != null && registry.recentChanges(agent) + count > rate) {
  return {
    allow: false,
    reason: `agent ${agent} is over its hourly rate window`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent && AGENT=1 bun test` Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `AGENT=1 moonx agent:typecheck` — expected clean.

```bash
git add packages/agent/src/policy.ts packages/agent/test/policy.test.ts
git -c user.name="Moritz" -c user.email="moritz@devmtkl.com" commit -m "feat(agent): enforce the per-hour rate window at land

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Server — replay durable meters outside the window; field rides the wire

**Files:**

- Modify: `packages/server/src/server.ts` (one call in `buildRegistry`, around
  line 373)
- Test: `packages/server/test/grants.test.ts`

**Interfaces:**

- Consumes: `AgentRegistry.replayMeter` (Task 2), `Delegation.maxChangesPerHour`
  (Task 1).
- Produces: no new API — `encodeDelegation`/`decodeDelegation` already serialize
  the whole record via `encodeRecord`, so the new field rides the wire with no
  DTO change (this task proves it).

- [ ] **Step 1: Write the failing test**

Append inside the `describe('grants', …)` block of
`packages/server/test/grants.test.ts` (reuses the `signed()` helper):

```ts
test('a rate-capped delegation rides the wire intact', async () => {
  const owner = Identity.create();
  const agent = Identity.create();
  const backend = new MemoryBackend();
  const srv = createServer({ backend });
  await srv.fetch(signed('POST', '/repos', { name: 'rw' }, owner));
  const capped = signDelegation(
    {
      agent: agent.did,
      paths: ['src/**'],
      maxChanges: 100,
      maxSpend: 1000,
      maxChangesPerHour: 2,
    },
    owner
  );
  const ok = await srv.fetch(
    signed(
      'POST',
      '/repos/rw/grants',
      { delegation: encodeDelegation(capped) },
      owner
    )
  );
  expect(ok.status).toBe(200);
  const list = (await (
    await srv.fetch(new Request('http://t/repos/rw/grants'))
  ).json()) as { grants: string[] };
  const roundTripped = decodeDelegation(list.grants[0]);
  expect(roundTripped.maxChangesPerHour).toBe(2);
  expect(verifyDelegation(roundTripped)).toBe(true);
});
```

Add `verifyDelegation` to the `@thaddeus.run/agent` import at the top of the
file.

- [ ] **Step 2: Run test to verify current state**

Run: `cd packages/server && AGENT=1 bun test test/grants.test.ts` Expected: PASS
already (the codec is generic) — this is a pin-the-behavior test. If it fails,
the codec drops unknown fields and the DTO needs an explicit field; investigate
before proceeding.

- [ ] **Step 3: Switch the meter replay to replayMeter**

In `packages/server/src/server.ts`, in `buildRegistry`, the meter replay loop
currently reads:

```ts
        const m = decodeRecord(bytes) as { changes: number; spend: number };
        try {
          reg.record(agent, m.changes, m.spend);
```

Change the call to:

```ts
        const m = decodeRecord(bytes) as { changes: number; spend: number };
        try {
          // replayMeter, not record: restoring durable lifetime totals must not
          // stamp them into the current hour's rate window (P9).
          reg.replayMeter(agent, m.changes, m.spend);
```

- [ ] **Step 4: Run the server suite**

Run: `cd packages/server && AGENT=1 bun test` Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `AGENT=1 moonx server:typecheck` — expected clean.

```bash
git add packages/server/src/server.ts packages/server/test/grants.test.ts
git -c user.name="Moritz" -c user.email="moritz@devmtkl.com" commit -m "feat(server): replay durable meters outside the rate window

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: CLI — `--max-changes-per-hour`, `grants` output, end-to-end rejection

**Files:**

- Modify: `packages/cli/src/run.ts` (the `case 'grant'` block around line 2546
  and `case 'grants'` around line 2682)
- Modify: `packages/cli/src/help.ts` (lines 37 and 257: the `grant` summary row
  and detail entry)
- Test: `packages/cli/test/grants.test.ts`

**Interfaces:**

- Consumes: `signDelegation` with `maxChangesPerHour` (Task 1); server
  enforcement (Tasks 3–4).
- Produces: user-facing flag `--max-changes-per-hour N`; `grants` text output
  appends `, N/h` and JSON output gains `maxChangesPerHour`.

- [ ] **Step 1: Write the failing test**

Append inside the `describe('thaddeus grant/revoke/grants', …)` block of
`packages/cli/test/grants.test.ts` (mirror the existing test's setup idioms —
`startServer`, per-identity homes, `run([...], e(cwd, home))`):

```ts
test('an hourly rate cap rejects the landing that exceeds it', async () => {
  const s = startServer({ dataDir: mkdtempSync(join(tmp, 'srv2-')), port: 0 });
  try {
    const out: string[] = [];
    const ownerHome = mkdtempSync(join(tmp, 'owner2-'));
    const mateHome = mkdtempSync(join(tmp, 'mate2-'));
    const e = (cwd: string, home: string) => ({
      cwd,
      home,
      out: (l: string) => out.push(l),
    });
    await run(['init'], e(ownerHome, ownerHome));
    await run(['init'], e(mateHome, mateHome));
    const mateDid = (
      JSON.parse(
        readFileSync(
          join(mateHome, '.config', 'thaddeus', 'identity.json'),
          'utf8'
        )
      ) as { did: string }
    ).did;

    await run(['create', s.url, 'proj2'], e(ownerHome, ownerHome));
    const ownerWc = mkdtempSync(join(tmp, 'ownerwc2-'));
    await run(['clone', s.url, 'proj2', ownerWc], e(ownerWc, ownerHome));
    mkdirSync(join(ownerWc, 'src'), { recursive: true });
    writeFileSync(join(ownerWc, 'src', 'seed.rs'), 'fn seed() {}\n');
    expect(await run(['push', '-m', 'seed'], e(ownerWc, ownerHome))).toBe(0);

    // Bad flag value → exit 2 with a terse message.
    out.length = 0;
    expect(
      await run(
        ['grant', mateDid, '--max-changes-per-hour', 'nope'],
        e(ownerWc, ownerHome)
      )
    ).toBe(2);
    expect(out.join('\n')).toContain('invalid --max-changes-per-hour');

    // Grant one landed op per hour.
    out.length = 0;
    expect(
      await run(
        ['grant', mateDid, '--paths', 'src/**', '--max-changes-per-hour', '1'],
        e(ownerWc, ownerHome)
      )
    ).toBe(0);

    // grants output shows the cap.
    out.length = 0;
    expect(await run(['grants'], e(ownerWc, ownerHome))).toBe(0);
    expect(out.join('\n')).toContain('1/h');

    // First in-scope landing fits the window.
    const mateWc = mkdtempSync(join(tmp, 'matewc2-'));
    await run(['clone', s.url, 'proj2', mateWc], e(mateWc, mateHome));
    writeFileSync(join(mateWc, 'src', 'a.rs'), 'fn a() {}');
    out.length = 0;
    expect(await run(['push', '-m', 'a'], e(mateWc, mateHome))).toBe(0);
    expect(out.join('\n').toLowerCase()).toContain('published');

    // Second landing within the hour exceeds the cap → rejected.
    writeFileSync(join(mateWc, 'src', 'b.rs'), 'fn b() {}');
    out.length = 0;
    const code = await run(['push', '-m', 'b'], e(mateWc, mateHome));
    expect(code).not.toBe(0);
    expect(out.join('\n')).toContain('hourly rate window');
  } finally {
    await s.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && AGENT=1 bun test test/grants.test.ts` Expected: FAIL —
`parseArgs` throws on the unknown `--max-changes-per-hour` option (surfaced as a
thrown error or non-2 exit).

- [ ] **Step 3: Implement flag, signing, and output**

In `packages/cli/src/run.ts`, `case 'grant'`:

Add to the `parseArgs` options object:

```ts
            'max-changes-per-hour': { type: 'string' },
```

Update the usage line:

```ts
out(
  'usage: thaddeus grant <did> [--paths a,b] [--max-changes N] [--max-changes-per-hour N]'
);
```

After the existing `maxChanges` validation block, add:

```ts
// P9 rate window: absent = no hourly cap (null); 0 is legal (zero
// changes per hour).
const maxChangesPerHour =
  values['max-changes-per-hour'] !== undefined
    ? Number(values['max-changes-per-hour'])
    : null;
if (
  maxChangesPerHour !== null &&
  (!Number.isInteger(maxChangesPerHour) || maxChangesPerHour < 0)
) {
  out(`invalid --max-changes-per-hour: ${values['max-changes-per-hour']}`);
  return 2;
}
```

Pass it to `signDelegation`:

```ts
const delegation = signDelegation(
  { agent: did, paths, maxChanges, maxSpend: 1_000_000, maxChangesPerHour },
  identity
);
```

Update the confirmation line to include the cap when present:

```ts
out(
  `granted ${g.agent} → ${g.paths.join(', ')} (max ${g.maxChanges} changes${
    g.maxChangesPerHour == null ? '' : `, ${g.maxChangesPerHour}/h`
  })`
);
```

In `case 'grants'`: add `maxChangesPerHour: g.maxChangesPerHour ?? null,` to the
JSON mapping object, and update the text line:

```ts
out(
  `${g.agent} → ${g.paths.join(', ')} (max ${g.maxChanges} changes${
    g.maxChangesPerHour == null ? '' : `, ${g.maxChangesPerHour}/h`
  })`
);
```

In `packages/cli/src/help.ts`: line 37's summary becomes
`grant  <did> [--paths a,b] [--max-changes N] [--max-changes-per-hour N]  grant push to a DID/agent`
(keep column alignment with the neighboring rows), and extend the `grant:`
detail entry (line 257) usage string the same way, adding one sentence:
`--max-changes-per-hour caps how many ops the agent may land within any trailing hour (default: no hourly cap); the server forgets the current hour on restart.`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && AGENT=1 bun test test/grants.test.ts` Expected: PASS.
Then the full suite: `AGENT=1 bun test` — expected PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `AGENT=1 moonx cli:typecheck` — expected clean.

```bash
git add packages/cli/src/run.ts packages/cli/src/help.ts packages/cli/test/grants.test.ts
git -c user.name="Moritz" -c user.email="moritz@devmtkl.com" commit -m "feat(cli): grant per-hour rate caps with --max-changes-per-hour

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs — CHANGELOG, roadmap (with backfill), README, getting-started

**Files:**

- Modify: `CHANGELOG.md` (top `### Added` section)
- Modify: `docs/plans/2026-07-09-post-p3-roadmap.md` (P4, P5, P9 sections)
- Modify: `packages/cli/README.md` (grant row in the command table + the
  delegation paragraph if one exists)
- Modify: `docs/getting-started.md` (the collaborate/grant section)

**Interfaces:** none — prose only, but copy the exact flag name
`--max-changes-per-hour` and reason string `over its hourly rate window` from
earlier tasks.

- [ ] **Step 1: CHANGELOG entry**

Add under the current `### Added` heading:

```markdown
- **P9 agent rate windows.** Delegations accept an optional signed
  `maxChangesPerHour`; `thaddeus grant <did> --max-changes-per-hour N` caps how
  many ops the agent may land within any trailing hour, composing with the
  lifetime `--max-changes` cap. Enforcement is server-side at land with a
  distinct rejection reason. Records without the field sign the exact legacy
  tuple, so every existing grant keeps verifying. The hourly window is
  in-memory: durable lifetime meters replay outside it, and a server restart
  forgets the current hour.
```

- [ ] **Step 2: Roadmap updates**

In `docs/plans/2026-07-09-post-p3-roadmap.md`:

Append to the P4 section:

```markdown
**Shipped:** repos persist a policy record selectable over the wire; the four
gates are enforced at land without a restart.
```

Append to the P5 section:

```markdown
**Shipped:** typed, signed `Release` records with a server route,
`thaddeus release`/`releases`, and a lazythad view, gated by P4 policy.
```

Replace the P9 section body (keep the heading) with:

```markdown
Add per-hour rate windows on delegations; today `--max-changes` is a lifetime
cap. Make `revoke` perform real key rotation and recall.

**Shipped (rotate-and-recall, pulled forward):** `thaddeus revoke <did>` rotates
every reachable content key and re-wraps for the remaining members; recall
preserves pending reveals across key changes.

**Shipped (budgets):** delegations carry an optional signed `maxChangesPerHour`;
`thaddeus grant <did> --max-changes-per-hour N` bounds ops landed within any
trailing hour, composing with the lifetime cap and enforced server-side at land.
The window is in-memory; durable lifetime meters replay outside it on restart.
```

- [ ] **Step 3: README + getting-started**

`packages/cli/README.md`: extend the `grant` row's syntax column to
`grant <did> [--paths a,b] [--max-changes N] [--max-changes-per-hour N]` (match
the table's existing escaping style).

`docs/getting-started.md`: in the collaborate section where `thaddeus grant` is
introduced, add one sentence:

```markdown
Add `--max-changes-per-hour N` to also bound how many ops the agent may land
within any trailing hour; the lifetime `--max-changes` cap still applies.
```

- [ ] **Step 4: Format, lint, commit**

Run: `AGENT=1 moon run root:format root:lint` — expected clean.

```bash
git add CHANGELOG.md docs/plans/2026-07-09-post-p3-roadmap.md packages/cli/README.md docs/getting-started.md
git -c user.name="Moritz" -c user.email="moritz@devmtkl.com" commit -m "docs: mark P9 shipped and backfill P4/P5 roadmap markers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Full verification + real-surface smoke

**Files:** none created (scratchpad script only).

**Interfaces:** consumes everything above.

- [ ] **Step 1: Repo verification baseline**

Run, from the repo root:

```bash
AGENT=1 moon run root:format root:lint
AGENT=1 moonx agent:typecheck && AGENT=1 moonx server:typecheck && AGENT=1 moonx cli:typecheck
cd packages/agent && AGENT=1 bun test; cd ../server && AGENT=1 bun test; cd ../cli && AGENT=1 bun test; cd ../..
cd integration && AGENT=1 bun test; cd ..
```

Expected: all PASS, format/lint clean.

- [ ] **Step 2: Real-process smoke (per the project smoke recipe)**

Drive the real CLI end-to-end (adapt the session smoke recipe: real
`bun packages/cli/src/bin.ts`, isolated `HOME`s, real `serve` on a spare port).
Choreography: owner `init`/`create`/`clone`/seed/`push`; agent `init`; owner
`grant <agentDid> --paths 'src/**' --max-changes-per-hour 1`; agent `clone`,
edit one file, `push` (expect `published`); agent edits a second file, `push`
(expect non-zero exit and `hourly rate window` on output); owner `grants`
(expect `1/h`). Capture stdout/stderr as evidence.

Expected: second agent push rejected with the hourly reason; owner unaffected.

- [ ] **Step 3: Confirm clean tree**

Run: `git status --short` — expected empty. All commits made per-task above.
