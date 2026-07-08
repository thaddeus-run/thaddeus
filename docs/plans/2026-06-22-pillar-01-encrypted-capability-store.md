# Pillar 01 — Encrypted Capability Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two standalone, npm-publishable foundation packages —
`@thaddeus.run/identity` (did:key) and `@thaddeus.run/store` (encrypted
objects + per-object capabilities) — plus an offboarding CLI demo and the seeded
convergence machinery (ARCHITECTURE.md, CHANGELOG.md, a north-star integration
test).

**Architecture:** A value is stored as an encrypted, content-addressed
`EncryptedObject` (xchacha20poly1305, addressed by `blake3(ciphertext)`). Access
is a `Capability`: the object's content key sealed (libsodium anonymous sealed
box) to one identity's did:key. `grant` appends a capability; `revoke` rotates
the key, re-encrypts, and re-issues capabilities for the remaining grantees
only. The store never holds a plaintext content key — keys live only inside
capabilities. Stable seams (the public APIs + record shapes), playground
interiors (the in-memory implementation is a spike).

**Tech Stack:** TypeScript, Bun (runtime + `bun test`), moon (task runner),
tsdown (library build), `libsodium-wrappers-sumo` (ed25519, x25519, sealed box,
xchacha20poly1305), `@noble/hashes` (blake3), `@scure/base` (base58btc for
did:key).

## Global Constraints

- **Toolchain:** `export AGENT=1` at session start. Use **bun** and **moon**
  only — never npm/pnpm/npx. Run tasks via `moon run <project>:<task>` (or
  `moonx`). Tool versions come from `.prototools` (proto).
- **Dependencies:** declared in the **root** `package.json`
  `workspaces.catalog`, referenced from packages as `"catalog:"`. Never pin
  versions in package-level manifests.
- **Crypto:** only `libsodium-wrappers-sumo` + `@noble/hashes` + `@scure/base`.
  No hand-rolled crypto.
- **Platform-neutral published code:** in `packages/*/src` use `Uint8Array` only
  — no `Buffer` or other Node-only APIs (builds are `platform: 'neutral'`).
  `examples/` and `integration/` may use Bun/Node APIs.
- **`isolatedDeclarations: true`:** every _exported_ binding needs explicit type
  annotations and explicit function/method return types. (Locals may be
  inferred.)
- **Imports:** extensionless relative imports (`./object`, not `./object.ts`);
  cross-package via the package name (`@thaddeus.run/identity`).
- **libsodium is async:** call `await ready()` once before any identity/store
  crypto (tests/demos do this in `beforeAll`/at startup).
- **Preserve trailing newlines** at end of files.
- **Verification baseline after code changes:**
  `moon run root:format root:lint`, plus `moonx <project>:typecheck` and
  `moonx <project>:test` for the changed area. The git pre-commit hook also runs
  affected typecheck + format + lint-staged — let it.
- **Git:** work on branch `feat/pillar-01-encrypted-capability-store` off `main`
  (never commit on `main`). Conventional Commits. When an agent makes a commit,
  append the harness footer (`Co-Authored-By: Claude …` and
  `Claude-Session: …`).
- **Names:** npm scope `@thaddeus.run/*`; "Thaddeus" is the product name and
  appears in copy only.

---

### Task 1: Re-scope the workspace, rename `core` → `store`, add deps, seed docs

Mechanical foundation: rename the scope to `@thaddeus.run/*`, rename the `core`
package to `store`, register crypto deps, and create the tracked planning docs.
No behavior yet.

**Files:**

- Rename: `packages/core/` → `packages/store/` (via `git mv`)
- Modify: `package.json` (root — name, catalog), `moon.yml` (root — `dependsOn`,
  comment), `.moon/workspace.yml` (unchanged here), `AGENTS.md`,
  `CONTRIBUTING.md`, and every file matching `@thaddeus/`
- Modify: `packages/store/package.json` (`prepublishOnly` script `core:` →
  `store:`)
- Create:
  `docs/specs/2026-06-22-thaddeus-pillar-01-encrypted-capability-store-design.md`
  (copy of the approved spec), `ARCHITECTURE.md`, `CHANGELOG.md`

**Interfaces:**

- Consumes: nothing.
- Produces: the `@thaddeus.run/*` scope; the `store` project name; catalog
  entries `libsodium-wrappers-sumo`, `@types/libsodium-wrappers-sumo`,
  `@noble/hashes`, `@scure/base`.

- [ ] **Step 1: Create the feature branch**

```bash
cd thaddeus
git checkout -b feat/pillar-01-encrypted-capability-store
export AGENT=1
```

- [ ] **Step 2: Rename the package directory**

```bash
git mv packages/core packages/store
```

- [ ] **Step 3: Re-scope and re-name across all source/text files**

macOS `sed` (note the `-i ''`). First map `core` → `store`, then the scope:

```bash
# Exclude docs/ — specs and plans intentionally mention both old and new names.
grep -rl --include="*.json" --include="*.ts" --include="*.tsx" --include="*.md" --include="*.yml" \
  "@thaddeus/" . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next --exclude-dir=.output --exclude-dir=docs \
  | xargs sed -i '' -e 's#@thaddeus/core#@thaddeus.run/store#g' -e 's#@thaddeus/#@thaddeus.run/#g'
sed -i '' 's#core:prepublish#store:prepublish#' packages/store/package.json
sed -i '' "s#- 'core'#- 'store'#" moon.yml
```

- [ ] **Step 4: Update the AGENTS.md naming example**

In `AGENTS.md`, change the naming-example line so it reads:

```markdown
- Packages live under the `@thaddeus.run/*` npm scope with neutral,
  product-agnostic names (e.g. `store`, `identity`, `theme`) — not `Thaddeus-*`
  — so a product rename never forces a package rename.
```

- [ ] **Step 5: Verify no stale references remain**

```bash
grep -rn "@thaddeus/" . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next --exclude-dir=.output --exclude-dir=docs
grep -rn "'core'" moon.yml
```

Expected: no output from either (root `moon.yml` now
`dependsOn: ['store', 'theme']`).

- [ ] **Step 6: Add crypto dependencies to the root catalog**

In root `package.json`, add these entries to `workspaces.catalog` (keep it
alphabetical-ish; exact placement is not significant):

```json
"@noble/hashes": "^1.8.0",
"@scure/base": "^1.2.4",
"@types/libsodium-wrappers-sumo": "^0.7.8",
"libsodium-wrappers-sumo": "^0.7.15",
```

- [ ] **Step 7: Confirm the root lint dependencies**

After Step 3, root `moon.yml` `dependsOn` reads `['store', 'theme']` (the `core`
→ `store` rename). Leave it as-is — `identity` is added in Task 2, once that
project exists, so `moon` never references a missing project here.

- [ ] **Step 8: Reinstall the workspace**

```bash
bun install
```

Expected: resolves with no errors; `packages/store` is linked as
`@thaddeus.run/store`.

- [ ] **Step 9: Seed the tracked planning docs**

```bash
mkdir -p docs/specs docs/plans
cp "../docs/superpowers/specs/2026-06-22-thaddeus-pillar-01-encrypted-capability-store-design.md" docs/specs/
```

Create `ARCHITECTURE.md`:

```markdown
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
| Op (operation log entry)              | _(planned)_              | P03 · P04 · P08 · P10                                   |

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

| Pillar                                | Package              | Status      | Resolves         |
| ------------------------------------- | -------------------- | ----------- | ---------------- |
| 01 Encrypted objects + capabilities   | `identity` + `store` | in progress | P1 P2 P4 P18 P21 |
| 02 Membrane (time-varying visibility) | _(planned)_          | planned     | P2 P3 P4         |
| 03 Operation log                      | _(planned)_          | planned     | P5 P6 P12        |
| 04 Provenance ("why")                 | _(planned)_          | planned     | P12              |
| 05 Virtual FS                         | _(planned)_          | planned     | P6 P7 P8 P11     |
| 06 Platform                           | _(planned)_          | planned     | P9 P10 P11       |
| 07 Identity federation / reputation   | _(planned)_          | planned     | P13 P19 P20      |
| 08 Semantic graph                     | _(planned)_          | planned     | P14 P5 P18       |
| 09 Agents as principals               | _(planned)_          | planned     | P16 P3 P21       |
| 10 Review as policy                   | `platform`           | in progress | P15 P12          |
| 11 Live database                      | _(planned)_          | planned     | P17 P10          |

## Per-primitive loop

read `ARCHITECTURE.md` → brainstorm → spec (`docs/specs/`) → plan
(`docs/plans/`) → build (TDD) → extend the north-star flow → update
`CHANGELOG.md` + this table.
```

Create `CHANGELOG.md`:

```markdown
# Changelog

All notable changes to Thaddeus. Format follows
[Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added

- (in progress) `@thaddeus.run/identity` — self-owned `did:key` identity:
  sign/verify, anonymous seal/unseal.
- (in progress) `@thaddeus.run/store` — encrypted, content-addressed objects
  with per-object capabilities (grant/revoke = key rotation). Pillar 01.

### Changed

- Re-scoped packages `@thaddeus/*` → `@thaddeus.run/*`; renamed the `core`
  placeholder package to `store`.
```

- [ ] **Step 10: Verify the workspace still builds and lints**

```bash
moon run :build
moon run root:format root:lint
```

Expected: build succeeds for `store` and `theme`; format and lint pass.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: re-scope to @thaddeus.run, rename core->store, seed architecture docs"
```

---

### Task 2: `@thaddeus.run/identity` — did:key, sign/verify, seal/unseal

The portable cryptographic identity reused by every later pillar.

**Files:**

- Create: `packages/identity/package.json`, `packages/identity/tsconfig.json`,
  `packages/identity/tsdown.config.ts`, `packages/identity/moon.yml`,
  `packages/identity/README.md`, `packages/identity/LICENSE.md`
- Create: `packages/identity/src/index.ts`, `packages/identity/src/did.ts`,
  `packages/identity/src/identity.ts`
- Test: `packages/identity/test/identity.test.ts`

**Interfaces:**

- Consumes: `libsodium-wrappers-sumo`, `@scure/base` (catalog).
- Produces:
  - `ready(): Promise<void>`
  - `encodeDidKey(ed25519PublicKey: Uint8Array): string`,
    `decodeDidKey(did: string): Uint8Array`
  - `class PublicIdentity { readonly did: string; static fromDid(did: string): PublicIdentity; verify(bytes: Uint8Array, sig: Uint8Array): boolean; seal(bytes: Uint8Array): Uint8Array }`
  - `class Identity { static create(): Identity; get did(): string; sign(bytes: Uint8Array): Uint8Array; unseal(box: Uint8Array): Uint8Array; toPublic(): PublicIdentity }`

- [ ] **Step 1: Create the package manifest and config**

`packages/identity/package.json`:

```json
{
  "name": "@thaddeus.run/identity",
  "version": "0.0.0",
  "license": "apache-2.0",
  "files": ["dist", "LICENSE.md", "README.md"],
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "publishConfig": { "access": "public" },
  "scripts": { "prepublishOnly": "moon run identity:prepublish" },
  "dependencies": {
    "@scure/base": "catalog:",
    "libsodium-wrappers-sumo": "catalog:"
  },
  "devDependencies": {
    "@types/libsodium-wrappers-sumo": "catalog:",
    "@typescript/native-preview": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:"
  }
}
```

`packages/identity/tsconfig.json` (identical to `packages/store/tsconfig.json`):

```json
{
  "extends": "../../tsconfig.options.json",
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx",
    "src/**/*.json",
    "test/**/*.ts",
    "tsdown.config.ts"
  ],
  "exclude": ["node_modules", "dist"],
  "compilerOptions": {
    "isolatedDeclarations": true,
    "allowJs": false,
    "checkJs": false,
    "emitDeclarationOnly": true,
    "outDir": "dist",
    "lib": ["ES2023"],
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "rootDir": "."
  }
}
```

`packages/identity/tsdown.config.ts` (identical to store's):

```ts
import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig([
  {
    entry: ['src/**/*.ts'],
    tsconfig: './tsconfig.json',
    clean: true,
    dts: { sourcemap: true, tsgo: true },
    unbundle: true,
    platform: 'neutral',
  },
]);

export default config;
```

`packages/identity/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

language: 'typescript'
layer: 'library'
tags: ['tsdown', 'publishable']
```

Now add `identity` to the root lint dependencies (it exists as of this task). In
root `moon.yml`, `dependsOn` becomes:

```yaml
dependsOn:
  - 'store'
  - 'theme'
  - 'identity'
```

Copy `packages/store/LICENSE.md` to `packages/identity/LICENSE.md`. Create
`packages/identity/README.md`:

````markdown
# @thaddeus.run/identity

Self-owned cryptographic identity (`did:key`) for the Thaddeus substrate. One
key signs, verifies, and receives sealed messages.

```bash
bun add @thaddeus.run/identity
```
````

```ts
import { Identity, ready } from '@thaddeus.run/identity';

await ready();
const me = Identity.create();
const sig = me.sign(new TextEncoder().encode('hello'));
me.toPublic().verify(new TextEncoder().encode('hello'), sig); // true
```

Apache-2.0.

````

- [ ] **Step 2: Write the failing test**

`packages/identity/test/identity.test.ts`:

```ts
import { test, expect, describe, beforeAll } from 'bun:test';
import { Identity, PublicIdentity, ready } from '../src/index';

beforeAll(async () => {
  await ready();
});

describe('Identity', () => {
  test('create() produces a did:key', () => {
    expect(Identity.create().did.startsWith('did:key:z')).toBe(true);
  });

  test('sign/verify round-trips and rejects tampering', () => {
    const id = Identity.create();
    const msg = new TextEncoder().encode('hello');
    const sig = id.sign(msg);
    expect(id.toPublic().verify(msg, sig)).toBe(true);
    expect(id.toPublic().verify(new TextEncoder().encode('hellp'), sig)).toBe(false);
  });

  test('seal/unseal round-trips for the recipient only', () => {
    const a = Identity.create();
    const b = Identity.create();
    const secret = new TextEncoder().encode('top-secret');
    const box = a.toPublic().seal(secret);
    expect(a.unseal(box)).toEqual(secret);
    expect(() => b.unseal(box)).toThrow();
  });

  test('PublicIdentity.fromDid reconstructs a verifying key', () => {
    const id = Identity.create();
    const msg = new TextEncoder().encode('m');
    const sig = id.sign(msg);
    expect(PublicIdentity.fromDid(id.did).verify(msg, sig)).toBe(true);
  });
});
````

- [ ] **Step 3: Run the test to verify it fails**

```bash
moon run identity:test -- test/identity.test.ts
```

Expected: FAIL — `Cannot find module '../src/index'` (no source yet).

- [ ] **Step 4: Implement did:key encoding**

`packages/identity/src/did.ts`:

```ts
import { base58 } from '@scure/base';

// multicodec prefix for an ed25519 public key (varint 0xed01).
const ED25519_PREFIX: Uint8Array = new Uint8Array([0xed, 0x01]);

export function encodeDidKey(ed25519PublicKey: Uint8Array): string {
  const bytes = new Uint8Array(ED25519_PREFIX.length + ed25519PublicKey.length);
  bytes.set(ED25519_PREFIX, 0);
  bytes.set(ed25519PublicKey, ED25519_PREFIX.length);
  return `did:key:z${base58.encode(bytes)}`;
}

export function decodeDidKey(did: string): Uint8Array {
  const prefix = 'did:key:z';
  if (!did.startsWith(prefix)) {
    throw new Error(`not a did:key: ${did}`);
  }
  const bytes = base58.decode(did.slice(prefix.length));
  if (bytes[0] !== ED25519_PREFIX[0] || bytes[1] !== ED25519_PREFIX[1]) {
    throw new Error('unsupported did:key multicodec (expected ed25519)');
  }
  return bytes.slice(ED25519_PREFIX.length);
}
```

- [ ] **Step 5: Implement the identity classes**

`packages/identity/src/identity.ts`:

```ts
import sodium from 'libsodium-wrappers-sumo';
import { decodeDidKey, encodeDidKey } from './did';

let initialized = false;

// libsodium loads its wasm asynchronously; call once before using this module.
export async function ready(): Promise<void> {
  await sodium.ready;
  initialized = true;
}

function assertReady(): void {
  if (!initialized) {
    throw new Error('call `await ready()` before using @thaddeus.run/identity');
  }
}

// The shareable half of an identity: a did:key plus the keys it encodes.
export class PublicIdentity {
  readonly did: string;
  readonly #edPk: Uint8Array;
  readonly #xPk: Uint8Array;

  constructor(did: string, edPk: Uint8Array, xPk: Uint8Array) {
    this.did = did;
    this.#edPk = edPk;
    this.#xPk = xPk;
  }

  static fromDid(did: string): PublicIdentity {
    assertReady();
    const edPk = decodeDidKey(did);
    const xPk = sodium.crypto_sign_ed25519_pk_to_curve25519(edPk);
    return new PublicIdentity(did, edPk, xPk);
  }

  verify(bytes: Uint8Array, sig: Uint8Array): boolean {
    return sodium.crypto_sign_verify_detached(sig, bytes, this.#edPk);
  }

  // Anonymous sealed box: only the matching secret key can open it.
  seal(bytes: Uint8Array): Uint8Array {
    return sodium.crypto_box_seal(bytes, this.#xPk);
  }
}

// A full identity: signs, unseals, and yields its shareable PublicIdentity.
export class Identity {
  readonly #xPk: Uint8Array;
  readonly #xSk: Uint8Array;
  readonly #edSk: Uint8Array;
  readonly #public: PublicIdentity;

  private constructor(
    edPk: Uint8Array,
    edSk: Uint8Array,
    xPk: Uint8Array,
    xSk: Uint8Array
  ) {
    this.#edSk = edSk;
    this.#xPk = xPk;
    this.#xSk = xSk;
    this.#public = new PublicIdentity(encodeDidKey(edPk), edPk, xPk);
  }

  static create(): Identity {
    assertReady();
    const ed = sodium.crypto_sign_keypair();
    const xPk = sodium.crypto_sign_ed25519_pk_to_curve25519(ed.publicKey);
    const xSk = sodium.crypto_sign_ed25519_sk_to_curve25519(ed.privateKey);
    return new Identity(ed.publicKey, ed.privateKey, xPk, xSk);
  }

  get did(): string {
    return this.#public.did;
  }

  sign(bytes: Uint8Array): Uint8Array {
    return sodium.crypto_sign_detached(bytes, this.#edSk);
  }

  unseal(box: Uint8Array): Uint8Array {
    return sodium.crypto_box_seal_open(box, this.#xPk, this.#xSk);
  }

  toPublic(): PublicIdentity {
    return this.#public;
  }
}
```

`packages/identity/src/index.ts`:

```ts
export { decodeDidKey, encodeDidKey } from './did';
export { Identity, PublicIdentity, ready } from './identity';
```

- [ ] **Step 6: Install the new dependencies**

```bash
bun install
```

Expected: `libsodium-wrappers-sumo`, `@scure/base`,
`@types/libsodium-wrappers-sumo` resolve.

- [ ] **Step 7: Run the test to verify it passes**

```bash
moon run identity:test -- test/identity.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 8: Verify and commit**

```bash
moon run identity:typecheck
moon run root:format root:lint
git add -A
git commit -m "feat(identity): did:key identity with sign/verify and sealed-box seal/unseal"
```

---

### Task 3: `@thaddeus.run/store` — encrypted, content-addressed objects

The object layer: encrypt a value, address it by `blake3(ciphertext)`, decrypt
with the content key.

**Files:**

- Create: `packages/store/src/object.ts`
- Test: `packages/store/test/object.test.ts`
- Modify: `packages/store/package.json` (add deps)

**Interfaces:**

- Consumes: `libsodium-wrappers-sumo`, `@noble/hashes` (catalog); `ready()` from
  `@thaddeus.run/identity` for tests.
- Produces:
  - `const ALG: string`
  - `interface EncryptedObject { readonly id: string; readonly plaintext_id: string; readonly alg: string; readonly nonce: Uint8Array; readonly ciphertext: Uint8Array }`
  - `address(bytes: Uint8Array): string`
  - `newContentKey(): Uint8Array`
  - `encrypt(plaintext: Uint8Array, contentKey: Uint8Array): EncryptedObject`
  - `decrypt(object: EncryptedObject, contentKey: Uint8Array): Uint8Array`

- [ ] **Step 1: Add store dependencies**

In `packages/store/package.json`, set `dependencies` to:

```json
"dependencies": {
  "@noble/hashes": "catalog:",
  "@thaddeus.run/identity": "workspace:*",
  "libsodium-wrappers-sumo": "catalog:"
},
```

And add to `devDependencies`: `"@types/libsodium-wrappers-sumo": "catalog:"`.
Then:

```bash
bun install
```

- [ ] **Step 2: Write the failing test**

`packages/store/test/object.test.ts`:

```ts
import { test, expect, describe, beforeAll } from 'bun:test';
import { ready } from '@thaddeus.run/identity';
import { address, decrypt, encrypt, newContentKey } from '../src/object';

beforeAll(async () => {
  await ready();
});

describe('object', () => {
  test('encrypt → decrypt round-trips with the content key', () => {
    const key = newContentKey();
    const plaintext = new TextEncoder().encode('DATABASE_URL=postgres://x');
    const obj = encrypt(plaintext, key);
    expect(decrypt(obj, key)).toEqual(plaintext);
  });

  test('id is blake3(ciphertext); plaintext_id is blake3(plaintext)', () => {
    const key = newContentKey();
    const plaintext = new TextEncoder().encode('secret');
    const obj = encrypt(plaintext, key);
    expect(obj.id).toBe(address(obj.ciphertext));
    expect(obj.plaintext_id).toBe(address(plaintext));
  });

  test('ciphertext holds no plaintext', () => {
    const key = newContentKey();
    const obj = encrypt(new TextEncoder().encode('postgres-password'), key);
    expect(new TextDecoder().decode(obj.ciphertext).includes('postgres')).toBe(
      false
    );
  });

  test('decrypt with the wrong key throws', () => {
    const obj = encrypt(new TextEncoder().encode('secret'), newContentKey());
    expect(() => decrypt(obj, newContentKey())).toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
moon run store:test -- test/object.test.ts
```

Expected: FAIL — `Cannot find module '../src/object'`.

- [ ] **Step 4: Implement the object layer**

`packages/store/src/object.ts`:

```ts
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import sodium from 'libsodium-wrappers-sumo';

export const ALG = 'xchacha20poly1305';

export interface EncryptedObject {
  readonly id: string;
  readonly plaintext_id: string;
  readonly alg: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

// Content address: hex blake3. Used for object ids (over ciphertext) and
// plaintext ids (over plaintext).
export function address(bytes: Uint8Array): string {
  return bytesToHex(blake3(bytes));
}

export function newContentKey(): Uint8Array {
  return sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
}

export function encrypt(
  plaintext: Uint8Array,
  contentKey: Uint8Array
): EncryptedObject {
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  );
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    null,
    null,
    nonce,
    contentKey
  );
  return {
    id: address(ciphertext),
    plaintext_id: address(plaintext),
    alg: ALG,
    nonce,
    ciphertext,
  };
}

export function decrypt(
  object: EncryptedObject,
  contentKey: Uint8Array
): Uint8Array {
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    object.ciphertext,
    null,
    object.nonce,
    contentKey
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
moon run store:test -- test/object.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 6: Verify and commit**

```bash
moon run root:format root:lint
git add -A
git commit -m "feat(store): encrypted, content-addressed objects (xchacha20poly1305 + blake3)"
```

---

### Task 4: `@thaddeus.run/store` — capabilities

A capability is the content key sealed to one identity, signed by the granter.

**Files:**

- Create: `packages/store/src/capability.ts`
- Test: `packages/store/test/capability.test.ts`

**Interfaces:**

- Consumes: `Identity`, `PublicIdentity` from `@thaddeus.run/identity`.
- Produces:
  - `interface Capability { readonly object: string; readonly grantee: string; readonly wrapped_key: Uint8Array; readonly granted_by: string; readonly not_before: string; readonly sig: Uint8Array }`
  - `interface IssueParams { readonly object: string; readonly contentKey: Uint8Array; readonly grantee: PublicIdentity; readonly grantedBy: Identity; readonly notBefore?: string }`
  - `issueCapability(params: IssueParams): Capability`
  - `verifyCapability(cap: Capability): boolean`
  - `unwrapKey(cap: Capability, reader: Identity): Uint8Array`

- [ ] **Step 1: Write the failing test**

`packages/store/test/capability.test.ts`:

```ts
import { test, expect, describe, beforeAll } from 'bun:test';
import { Identity, ready } from '@thaddeus.run/identity';
import {
  issueCapability,
  unwrapKey,
  verifyCapability,
} from '../src/capability';
import { newContentKey } from '../src/object';

beforeAll(async () => {
  await ready();
});

describe('capability', () => {
  test('grantee can unwrap the content key; signature verifies', () => {
    const alice = Identity.create();
    const bob = Identity.create();
    const key = newContentKey();
    const cap = issueCapability({
      object: 'pid',
      contentKey: key,
      grantee: bob.toPublic(),
      grantedBy: alice,
    });
    expect(verifyCapability(cap)).toBe(true);
    expect(unwrapKey(cap, bob)).toEqual(key);
  });

  test('a tampered grantee fails signature verification', () => {
    const alice = Identity.create();
    const bob = Identity.create();
    const cap = issueCapability({
      object: 'pid',
      contentKey: newContentKey(),
      grantee: bob.toPublic(),
      grantedBy: alice,
    });
    const forged = { ...cap, grantee: Identity.create().did };
    expect(verifyCapability(forged)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
moon run store:test -- test/capability.test.ts
```

Expected: FAIL — `Cannot find module '../src/capability'`.

- [ ] **Step 3: Implement capabilities**

`packages/store/src/capability.ts`:

```ts
import { Identity, PublicIdentity } from '@thaddeus.run/identity';

export interface Capability {
  readonly object: string;
  readonly grantee: string;
  readonly wrapped_key: Uint8Array;
  readonly granted_by: string;
  readonly not_before: string;
  readonly sig: Uint8Array;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

// Bytes signed by the granter: binds object, grantee, and start time so none
// can be swapped without breaking the signature.
function canonical(
  object: string,
  grantee: string,
  notBefore: string
): Uint8Array {
  return new TextEncoder().encode(`${object}\n${grantee}\n${notBefore}`);
}

export interface IssueParams {
  readonly object: string;
  readonly contentKey: Uint8Array;
  readonly grantee: PublicIdentity;
  readonly grantedBy: Identity;
  readonly notBefore?: string;
}

export function issueCapability(params: IssueParams): Capability {
  const notBefore = params.notBefore ?? EPOCH;
  return {
    object: params.object,
    grantee: params.grantee.did,
    wrapped_key: params.grantee.seal(params.contentKey),
    granted_by: params.grantedBy.did,
    not_before: notBefore,
    sig: params.grantedBy.sign(
      canonical(params.object, params.grantee.did, notBefore)
    ),
  };
}

export function verifyCapability(cap: Capability): boolean {
  return PublicIdentity.fromDid(cap.granted_by).verify(
    canonical(cap.object, cap.grantee, cap.not_before),
    cap.sig
  );
}

export function unwrapKey(cap: Capability, reader: Identity): Uint8Array {
  return reader.unseal(cap.wrapped_key);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
moon run store:test -- test/capability.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Verify and commit**

```bash
moon run root:format root:lint
git add -A
git commit -m "feat(store): per-object capabilities (sealed content key + granter signature)"
```

---

### Task 5: `@thaddeus.run/store` — MemoryStore, public API, replace the stub

The store: put/get/grant/revoke over capabilities, plus the mirror view. This
task also retires the `createSubstrate` stub and points the docs app at a real
export.

**Files:**

- Create: `packages/store/src/store.ts`
- Modify: `packages/store/src/index.ts` (replace stub with real exports)
- Modify: `packages/store/README.md` (real usage)
- Modify: `apps/docs/app/page.tsx` (use `address`, not the removed stub)
- Test: `packages/store/test/store.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 2–4.
- Produces:
  - `interface Ref { readonly id: string; readonly plaintext_id: string }`
  - `class AccessDenied extends Error`
  - `interface Store { put(plaintext: Uint8Array, owner: Identity): Promise<Ref>; get(ref: Ref, reader: Identity): Promise<Uint8Array>; grant(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void>; revoke(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void>; rawObject(id: string): EncryptedObject | undefined; verify(id: string): boolean }`
  - `class MemoryStore implements Store`

- [ ] **Step 1: Write the failing test (the acceptance criteria)**

`packages/store/test/store.test.ts`:

```ts
import { test, expect, describe, beforeAll } from 'bun:test';
import { Identity, ready } from '@thaddeus.run/identity';
import { AccessDenied, MemoryStore, address } from '../src/index';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

beforeAll(async () => {
  await ready();
});

describe('MemoryStore', () => {
  test('owner reads; stored bytes are ciphertext (zero plaintext at rest)', async () => {
    const store = new MemoryStore();
    const alice = Identity.create();
    const secret = 'DATABASE_URL=postgres://app/prod';
    const ref = await store.put(enc(secret), alice);
    expect(dec(await store.get(ref, alice))).toBe(secret);
    const raw = store.rawObject(ref.id);
    expect(raw).toBeDefined();
    expect(dec(raw!.ciphertext).includes('postgres')).toBe(false);
  });

  test('a non-grantee cannot decrypt', async () => {
    const store = new MemoryStore();
    const ref = await store.put(enc('s3cret'), Identity.create());
    expect(store.get(ref, Identity.create())).rejects.toBeInstanceOf(
      AccessDenied
    );
  });

  test('grant lets a grantee read', async () => {
    const store = new MemoryStore();
    const alice = Identity.create();
    const bob = Identity.create();
    const ref = await store.put(enc('s3cret'), alice);
    await store.grant(ref, bob.toPublic(), alice);
    expect(dec(await store.get(ref, bob))).toBe('s3cret');
  });

  test('revoke is forward-only: revoked loses access, others keep it', async () => {
    const store = new MemoryStore();
    const alice = Identity.create();
    const bob = Identity.create();
    const ref = await store.put(enc('s3cret'), alice);
    await store.grant(ref, bob.toPublic(), alice);
    await store.revoke(ref, bob.toPublic(), alice);
    expect(store.get(ref, bob)).rejects.toBeInstanceOf(AccessDenied);
    expect(dec(await store.get(ref, alice))).toBe('s3cret');
  });

  test('addressing + integrity: id is blake3(ciphertext); verify detects it', async () => {
    const store = new MemoryStore();
    const ref = await store.put(enc('s3cret'), Identity.create());
    const raw = store.rawObject(ref.id)!;
    expect(address(raw.ciphertext)).toBe(ref.id);
    expect(store.verify(ref.id)).toBe(true);
  });

  test('plaintext_id is stable across rotation', async () => {
    const store = new MemoryStore();
    const alice = Identity.create();
    const bob = Identity.create();
    const ref = await store.put(enc('s3cret'), alice);
    const before = ref.plaintext_id;
    await store.grant(ref, bob.toPublic(), alice);
    await store.revoke(ref, bob.toPublic(), alice);
    expect(ref.plaintext_id).toBe(before);
    expect(dec(await store.get(ref, alice))).toBe('s3cret');
  });

  test('revoke completes well under a second', async () => {
    const store = new MemoryStore();
    const alice = Identity.create();
    const bob = Identity.create();
    const ref = await store.put(enc('s3cret'), alice);
    await store.grant(ref, bob.toPublic(), alice);
    const t0 = performance.now();
    await store.revoke(ref, bob.toPublic(), alice);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
moon run store:test -- test/store.test.ts
```

Expected: FAIL — `MemoryStore`/`AccessDenied` not exported from `../src/index`.

- [ ] **Step 3: Implement the store**

`packages/store/src/store.ts`:

```ts
import { Identity, PublicIdentity } from '@thaddeus.run/identity';
import {
  Capability,
  issueCapability,
  unwrapKey,
  verifyCapability,
} from './capability';
import {
  EncryptedObject,
  address,
  decrypt,
  encrypt,
  newContentKey,
} from './object';

export interface Ref {
  readonly id: string;
  readonly plaintext_id: string;
}

export class AccessDenied extends Error {
  constructor(did: string) {
    super(`access denied for ${did}`);
    this.name = 'AccessDenied';
  }
}

export interface Store {
  put(plaintext: Uint8Array, owner: Identity): Promise<Ref>;
  get(ref: Ref, reader: Identity): Promise<Uint8Array>;
  grant(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void>;
  revoke(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void>;
  rawObject(id: string): EncryptedObject | undefined;
  verify(id: string): boolean;
}

// In-memory reference store. Never holds a plaintext content key: keys live
// only inside capabilities, sealed to each grantee. Spike — not durable, not
// concurrency-safe.
export class MemoryStore implements Store {
  readonly #objects: Map<string, EncryptedObject> = new Map();
  readonly #current: Map<string, string> = new Map();
  readonly #caps: Map<string, Capability[]> = new Map();

  async put(plaintext: Uint8Array, owner: Identity): Promise<Ref> {
    const contentKey = newContentKey();
    const object = encrypt(plaintext, contentKey);
    this.#objects.set(object.id, object);
    this.#current.set(object.plaintext_id, object.id);
    this.#caps.set(object.plaintext_id, [
      issueCapability({
        object: object.plaintext_id,
        contentKey,
        grantee: owner.toPublic(),
        grantedBy: owner,
      }),
    ]);
    return { id: object.id, plaintext_id: object.plaintext_id };
  }

  async get(ref: Ref, reader: Identity): Promise<Uint8Array> {
    return decrypt(
      this.#currentObject(ref.plaintext_id),
      this.#contentKeyVia(ref.plaintext_id, reader)
    );
  }

  async grant(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void> {
    const contentKey = this.#contentKeyVia(ref.plaintext_id, by);
    const caps = this.#caps.get(ref.plaintext_id) ?? [];
    caps.push(
      issueCapability({
        object: ref.plaintext_id,
        contentKey,
        grantee,
        grantedBy: by,
      })
    );
    this.#caps.set(ref.plaintext_id, caps);
  }

  async revoke(ref: Ref, grantee: PublicIdentity, by: Identity): Promise<void> {
    const oldKey = this.#contentKeyVia(ref.plaintext_id, by);
    const plaintext = decrypt(this.#currentObject(ref.plaintext_id), oldKey);

    // Rotate: new key, re-encrypt, supersede the current object.
    const newKey = newContentKey();
    const rotated = encrypt(plaintext, newKey);
    this.#objects.set(rotated.id, rotated);
    this.#current.set(ref.plaintext_id, rotated.id);

    // Re-issue capabilities for everyone except the revoked grantee.
    const remaining = (this.#caps.get(ref.plaintext_id) ?? []).filter(
      (c) => c.grantee !== grantee.did
    );
    this.#caps.set(
      ref.plaintext_id,
      remaining.map((c) =>
        issueCapability({
          object: ref.plaintext_id,
          contentKey: newKey,
          grantee: PublicIdentity.fromDid(c.grantee),
          grantedBy: by,
        })
      )
    );
  }

  rawObject(id: string): EncryptedObject | undefined {
    return this.#objects.get(id);
  }

  verify(id: string): boolean {
    const object = this.#objects.get(id);
    return object !== undefined && address(object.ciphertext) === id;
  }

  #capabilityFor(plaintextId: string, did: string): Capability | undefined {
    const now = Date.now();
    return (this.#caps.get(plaintextId) ?? []).find(
      (c) =>
        c.grantee === did &&
        verifyCapability(c) &&
        Date.parse(c.not_before) <= now
    );
  }

  #contentKeyVia(plaintextId: string, who: Identity): Uint8Array {
    const cap = this.#capabilityFor(plaintextId, who.did);
    if (cap === undefined) {
      throw new AccessDenied(who.did);
    }
    return unwrapKey(cap, who);
  }

  #currentObject(plaintextId: string): EncryptedObject {
    const id = this.#current.get(plaintextId);
    const object = id === undefined ? undefined : this.#objects.get(id);
    if (object === undefined) {
      throw new Error(`no object for ${plaintextId}`);
    }
    return object;
  }
}
```

- [ ] **Step 4: Replace the package barrel (remove the stub)**

Replace the entire contents of `packages/store/src/index.ts` with:

```ts
export { ALG, address, decrypt, encrypt, newContentKey } from './object';
export type { EncryptedObject } from './object';
export { issueCapability, unwrapKey, verifyCapability } from './capability';
export type { Capability, IssueParams } from './capability';
export { AccessDenied, MemoryStore } from './store';
export type { Ref, Store } from './store';
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
moon run store:test -- test/store.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 6: Point the docs app at a real export**

Replace the entire contents of `apps/docs/app/page.tsx` with:

```tsx
import { address } from '@thaddeus.run/store';
import type { ReactNode } from 'react';

// Touch the workspace package so the build/typecheck graph exercises the
// cross-package resolution (docs -> @thaddeus.run/store) end to end.
const sample = address(new TextEncoder().encode('Thaddeus'));

export default function HomePage(): ReactNode {
  return (
    <main
      style={{ maxWidth: '42rem', margin: '0 auto', padding: '6rem 1.5rem' }}
    >
      <h1
        style={{
          fontSize: '2.5rem',
          fontWeight: 700,
          letterSpacing: '-0.02em',
        }}
      >
        Thaddeus Docs
      </h1>
      <p style={{ color: 'var(--thaddeus-muted)', fontSize: '1.125rem' }}>
        Documentation for Thaddeus — the live, permissioned, agent-native code
        substrate from Thaddeus.
      </p>
      <p style={{ marginTop: '2rem', fontFamily: 'ui-monospace, monospace' }}>
        content address of &ldquo;Thaddeus&rdquo;: {sample.slice(0, 16)}…
      </p>
    </main>
  );
}
```

- [ ] **Step 7: Rewrite the store README for the real API**

Replace `packages/store/README.md` with:

````markdown
# @thaddeus.run/store

Encrypted, content-addressed objects with per-object capabilities. A value is
ciphertext at rest; access is a key sealed to an identity; offboarding is a
single key rotation.

```bash
bun add @thaddeus.run/store @thaddeus.run/identity
```

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryStore } from '@thaddeus.run/store';

await ready();
const store = new MemoryStore();
const alice = Identity.create();
const bob = Identity.create();

const ref = await store.put(new TextEncoder().encode('DATABASE_URL=…'), alice);
await store.grant(ref, bob.toPublic(), alice); // bob can now read
await store.revoke(ref, bob.toPublic(), alice); // key rotation — bob cannot
```

Apache-2.0.
````

- [ ] **Step 8: Verify the whole graph and commit**

```bash
moon run store:typecheck
moon run docs:typecheck
moon run root:format root:lint
git add -A
git commit -m "feat(store): MemoryStore put/get/grant/revoke; retire createSubstrate stub"
```

---

### Task 6: Offboarding CLI demo

The thesis-proving demo — the `.env` / "fire someone" story, end to end.

**Files:**

- Create: `examples/offboarding/package.json`, `examples/offboarding/moon.yml`,
  `examples/offboarding/tsconfig.json`,
  `examples/offboarding/src/offboarding.ts`
- Modify: `package.json` (root — add `examples/*` to workspaces),
  `.moon/workspace.yml` (add `examples/*` glob)

**Interfaces:**

- Consumes: `@thaddeus.run/identity`, `@thaddeus.run/store`.
- Produces: a runnable demo (no exported API).

- [ ] **Step 1: Register the examples workspace glob**

In root `package.json`, add `"examples/*"` to `workspaces.packages`. In
`.moon/workspace.yml`, add `'examples/*'` to `projects.globs`.

- [ ] **Step 2: Create the demo project**

`examples/offboarding/package.json`:

```json
{
  "name": "@thaddeus.run/example-offboarding",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/store": "workspace:*"
  }
}
```

`examples/offboarding/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.options.json",
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules"],
  "compilerOptions": {
    "noEmit": true,
    "lib": ["ES2023"],
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler"
  }
}
```

`examples/offboarding/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

language: 'typescript'
layer: 'application'

tasks:
  # Build-graph-connected, so CI-skipped; run in agent shells with a CI= prefix.
  demo:
    command: 'bun src/offboarding.ts'
    deps:
      - '^:build'
    options:
      cache: false
      runInCI: 'skip'
```

- [ ] **Step 3: Write the demo script**

`examples/offboarding/src/offboarding.ts`:

```ts
// Offboarding demo for @thaddeus.run/store (Pillar 01).
// Run: CI= moon run offboarding:demo
//
// The .env / "fire someone" story: a secret is only ever ciphertext at rest,
// access is a key sealed to an identity, and offboarding is one key rotation.

import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryStore, address } from '@thaddeus.run/store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const hex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
const rule = (): void => console.log('—'.repeat(60));

await ready();
const store = new MemoryStore();
const alice = Identity.create();
const bob = Identity.create();

console.log('Alice:', alice.did);
console.log('Bob:  ', bob.did);
rule();

const secret = 'DATABASE_URL=postgres://app:hunter2@db.internal/prod';
const ref = await store.put(enc(secret), alice);
console.log('1. Alice stored a secret. object id =', `${ref.id.slice(0, 16)}…`);

const raw = store.rawObject(ref.id)!;
console.log('2. Stored bytes (first 32):', hex(raw.ciphertext.slice(0, 32)));
console.log(
  '   contains "postgres"?',
  dec(raw.ciphertext).includes('postgres')
);
console.log(
  '3. Mirror verifies blake3(ciphertext) === id without a key:',
  address(raw.ciphertext) === ref.id
);
rule();

try {
  await store.get(ref, bob);
} catch (err) {
  console.log(
    '4. Bob reads it:',
    (err as Error).name,
    '(holds only ciphertext)'
  );
}

await store.grant(ref, bob.toPublic(), alice);
console.log(
  '5. Alice grants Bob. Bob reads:',
  JSON.stringify(dec(await store.get(ref, bob)))
);
rule();

const t0 = performance.now();
await store.revoke(ref, bob.toPublic(), alice);
console.log(
  `6. Fire Bob → revoke (key rotation) took ${(performance.now() - t0).toFixed(1)} ms`
);
try {
  await store.get(ref, bob);
} catch (err) {
  console.log(
    '   Bob now:',
    (err as Error).name,
    '— his old key opens nothing'
  );
}
console.log(
  '   Alice still reads:',
  JSON.stringify(dec(await store.get(ref, alice)))
);
rule();
console.log(
  'zero plaintext at rest · access = a sealed key · offboarding = one rotation'
);
```

- [ ] **Step 4: Install, build deps, run the demo**

```bash
bun install
CI= moon run offboarding:demo
```

Expected: the six numbered steps print; step 2 shows
`contains "postgres"? false`; step 4 and the post-revoke line show
`AccessDenied`; Alice still reads the secret.

- [ ] **Step 5: Verify and commit**

```bash
moon run offboarding:typecheck
moon run root:format root:lint
git add -A
git commit -m "feat(examples): offboarding CLI demo for the encrypted capability store"
```

---

### Task 7: North-star integration test

The continuous convergence test: real Tier 0 today, `test.todo` for higher
pillars.

**Files:**

- Create: `integration/package.json`, `integration/moon.yml`,
  `integration/tsconfig.json`, `integration/test/one-edit-end-to-end.test.ts`
- Modify: `package.json` (root — add `integration` to workspaces),
  `.moon/workspace.yml` (add `integration` glob)

**Interfaces:**

- Consumes: `@thaddeus.run/identity`, `@thaddeus.run/store`.
- Produces: the north-star test suite.

- [ ] **Step 1: Register the integration workspace glob**

In root `package.json`, add `"integration"` to `workspaces.packages`. In
`.moon/workspace.yml`, add `'integration'` to `projects.globs`.

- [ ] **Step 2: Create the integration project**

`integration/package.json`:

```json
{
  "name": "@thaddeus.run/integration",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@thaddeus.run/identity": "workspace:*",
    "@thaddeus.run/store": "workspace:*"
  }
}
```

`integration/tsconfig.json`:

```json
{
  "extends": "../tsconfig.options.json",
  "include": ["test/**/*.ts"],
  "exclude": ["node_modules"],
  "compilerOptions": {
    "noEmit": true,
    "lib": ["ES2023"],
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler"
  }
}
```

`integration/moon.yml`:

```yaml
$schema: 'https://moonrepo.dev/schemas/project.json'

language: 'typescript'
layer: 'application'
```

- [ ] **Step 3: Write the north-star test**

`integration/test/one-edit-end-to-end.test.ts`:

```ts
import { test, expect, describe, beforeAll } from 'bun:test';
import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryStore } from '@thaddeus.run/store';

// The brief's "one edit, end to end" flow. Tier 0 (identity + store) is real
// today; higher pillars are test.todo and become real as each ships. See
// ARCHITECTURE.md → north-star flow.
beforeAll(async () => {
  await ready();
});

describe('north-star: one edit, end to end', () => {
  test('P05/P01: write an object → stored as ciphertext a mirror can verify', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const ref = await store.put(
      new TextEncoder().encode('fn refresh() {}'),
      author
    );
    expect(store.verify(ref.id)).toBe(true);
    expect(store.rawObject(ref.id)).toBeDefined();
  });

  test('P01/P02: grant releases the content key to a named grantee', async () => {
    const store = new MemoryStore();
    const author = Identity.create();
    const reviewer = Identity.create();
    const ref = await store.put(
      new TextEncoder().encode('fn refresh() {}'),
      author
    );
    await store.grant(ref, reviewer.toPublic(), author);
    expect(new TextDecoder().decode(await store.get(ref, reviewer))).toBe(
      'fn refresh() {}'
    );
  });

  test.todo('P03: the edit is recorded as a signed Op in the operation log');
  test.todo('P04: a signed Provenance record attaches the why to the Op');
  test.todo('P02: a scheduled reveal re-wraps the content key to public at T');
});
```

- [ ] **Step 4: Install and run the integration suite**

```bash
bun install
moon run integration:test
```

Expected: 2 tests PASS, 3 todo.

- [ ] **Step 5: Verify and commit**

```bash
moon run integration:typecheck
moon run root:format root:lint
git add -A
git commit -m "test(integration): seed the north-star one-edit-end-to-end flow"
```

---

### Task 8: Flip status, full verification, finalize

Mark Pillar 01 built and prove the whole repo is green.

**Files:**

- Modify: `ARCHITECTURE.md` (status table), `CHANGELOG.md` (drop "in progress")

- [ ] **Step 1: Update the status table**

In `ARCHITECTURE.md`, change the Pillar 01 row status from `in progress` to
`built`.

- [ ] **Step 2: Finalize the changelog**

In `CHANGELOG.md`, remove the `(in progress)` prefixes from the two `Added`
entries.

- [ ] **Step 3: Full repository verification**

```bash
moon run :build
moon run :typecheck
moon run :test
moon run root:format-check root:lint root:lint-css
```

Expected: build, typecheck, and all suites pass; format-check and lint clean.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: mark Pillar 01 (encrypted capability store) built"
```

- [ ] **Step 5: Final review of the branch**

```bash
git log --oneline main..HEAD
```

Expected: eight commits, one per task. The branch is ready for review/merge.

---

## Self-Review

**Spec coverage:** §1 wedge → Tasks 2–5 (the primitive). §2 stable-seams →
public APIs fixed in Interfaces blocks, internals free. §2.1 language → TS
throughout, crypto in compiled libs. §4.1 doc system → ARCHITECTURE.md +
CHANGELOG.md + spec move (Task 1). §4.2 build order → Tier table in
ARCHITECTURE.md. §4.3 north-star → Task 7. §4.5 dual-purpose → packages
publishable + Thaddeus-agnostic; standalone READMEs. §4.6 repo layout → Task 1
(re-scope/rename), Tasks 6–7 (examples/integration), names/license. §5 scope in
→ Tasks 2–7; scope out → not implemented (no P02–P11). §6 packages → Tasks 2–5.
§7 data model → object.ts/capability.ts. §8 crypto → libsodium + noble + scure.
§9 demo → Task 6. §10 acceptance (7 criteria) → Task 5 tests + Task 8 full run.
§11 limitations → in-memory, forward-only revoke, no recovery (encoded in
comments/tests). §12 seeded docs → Task 1. All covered.

**Placeholder scan:** No TBD/TODO-as-work. The `test.todo` lines in Task 7 are
intentional north-star stubs (the design), not plan gaps. Every code step shows
complete code.

**Type consistency:** `Identity`/`PublicIdentity` API (`create`, `did`, `sign`,
`unseal`, `toPublic`, `verify`, `seal`, `fromDid`) consistent across Tasks 2–7.
`EncryptedObject` fields (`id`, `plaintext_id`, `alg`, `nonce`, `ciphertext`)
consistent in Tasks 3, 5, 6. `Capability` fields and
`issueCapability`/`verifyCapability`/`unwrapKey` consistent in Tasks 4–5. `Ref`
(`id`, `plaintext_id`) and `MemoryStore`/`AccessDenied` consistent in Tasks 5–7.
`address` exported (Task 3), consumed (Tasks 5, 6). Demo/integration use the
package barrel exports defined in Task 5 Step 4.

---

## Execution Handoff

Plan complete and saved to
`thaddeus/docs/plans/2026-06-22-pillar-01-encrypted-capability-store.md`. Two
execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, two-stage
   review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for
   review.

Which approach?
