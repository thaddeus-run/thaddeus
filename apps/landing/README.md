# @thaddeus/landing

The marketing/landing site for **Strata** (working name) — built with
[TanStack Start](https://tanstack.com/start).

> **Status: scaffold.** A root route + a single index route showing the Strata
> wordmark and deck. The full narrative from
> `the-new-age-of-source-control.html` can be ported in here later.

## Develop

```bash
moon run landing:dev      # vite dev on PORT (default 3001)
moon run landing:build    # production build
moon run landing:start    # preview the build
```

The TanStack Start Vite plugin generates `src/routeTree.gen.ts` from
`src/routes/` on first run (it is gitignored). See the repo root
`CONTRIBUTING.md` for toolchain setup.
