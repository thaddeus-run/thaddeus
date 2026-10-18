# @thaddeus.run/landing

The marketing site for **Thaddeus**, built with
[TanStack Start](https://tanstack.com/start), Tailwind CSS v4, Motion and
Lucide.

## Layout

- `src/routes/` holds the root document and the single index route.
- `src/components/site/` holds one component per page section (nav, hero,
  ledger, how it works, features, security, about, footer) plus the small shared
  pieces (theme toggle, cursor, install command, dot lattice).
- `src/content/` holds the copy and data the sections render, so wording and the
  features list change without touching layout.
- `src/styles.css` defines the palette as CSS custom properties, maps them into
  Tailwind through `@theme`, and holds the ambient CSS loops.

Dark mode is a `dark` class on `<html>`, applied before paint by an inline
script in the root route and persisted under `thaddeus-theme` in localStorage.
State-driven motion (rows arriving, the theme icon, copy feedback) uses Motion;
looping ambient motion uses CSS so it can start mid-cycle. Every animation
pauses or holds a single frame when the reader prefers reduced motion.

## Develop

```bash
CI= moon run landing:dev              # vite dev on PORT (default 3001), loopback only
CI= HOST=0.0.0.0 moon run landing:dev  # also reachable from other devices (Tailscale)
moon run landing:build      # production build into .output/
CI= moon run landing:start  # preview the build
moon run landing:typecheck
```

The TanStack Start Vite plugin generates `src/routeTree.gen.ts` from
`src/routes/` on first run (it is gitignored). See the repo root
`CONTRIBUTING.md` for toolchain setup.

## Deploy

The site deploys to Vercel as a TanStack Start app. Nitro (`nitro/vite` in
`vite.config.ts`) detects Vercel at build time and emits the Build Output API
layout; a local `vite build` emits a plain Node server under `.output/` instead,
which `node .output/server/index.mjs` runs.

Vercel project settings:

- Root Directory: `apps/landing`
- Framework preset: TanStack Start (also pinned in `vercel.json`, since
  detection can fail in a monorepo)
- Node.js version: 24.x (`engines.node` in `package.json`; Nitro needs 24+)
- Install and build commands come from `vercel.json`:
  `bun install --frozen-lockfile` at the workspace root and `bunx vite build`.

`vercel.json` also holds the short-link redirects: `/install.sh` goes to the raw
install script on `main`, and `/docs` goes to the getting-started guide until
the docs site is live.
