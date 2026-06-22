# @thaddeus.run/theme

Shared design tokens for [Thaddeus](https://thaddeus.dev)'s open-source UI — one
source of truth for color so every app and package resolves to the same palette.

> **Status: scaffold.** Ships a small token set + matching CSS variables. Expand
> with mode controllers and theme-resolution helpers as the UI grows.

## Install

```bash
bun add @thaddeus.run/theme
```

## Usage

```ts
import { resolveTokens } from '@thaddeus.run/theme';
import '@thaddeus.run/theme/style.css';

const { accent } = resolveTokens('dark');
```

## Development

```bash
moon run theme:build
moon run theme:dev
```

See the repo root `CONTRIBUTING.md` for toolchain setup.
