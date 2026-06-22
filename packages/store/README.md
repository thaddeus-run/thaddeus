# @thaddeus.run/store

The first substrate primitive for **Strata** (working name) — the live,
permissioned, agent-native code substrate from [Thaddeus](https://thaddeus.dev).

> **Status: scaffold.** This package currently ships a buildable stub
> (`createSubstrate()`) so the workspace build/typecheck/lint graph resolves.
> Real behavior — content-addressed encrypted objects, the operation log, the
> visibility membrane — lands incrementally, and the package will likely be
> renamed to its real primitive name.

## Install

```bash
bun add @thaddeus.run/store
```

## Usage

```ts
import { createSubstrate } from '@thaddeus.run/store';

const substrate = createSubstrate({ name: 'demo' });
console.log(substrate.name, substrate.version());
```

## Development

This package builds with [tsdown](https://tsdown.dev) and is driven through
[moon](https://moonrepo.dev):

```bash
moon run core:build       # bundle dist/ + type declarations
moon run core:dev         # watch mode
moon run core:typecheck   # type-check
```

See the repo root `CONTRIBUTING.md` for toolchain setup.
