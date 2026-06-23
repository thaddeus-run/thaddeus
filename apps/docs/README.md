# @thaddeus.run/docs

The documentation site for **Strata** (working name) — built with Next.js.

> **Status: scaffold.** A single home page that wires in `@thaddeus.run/store`
> and `@thaddeus.run/theme`. Add MDX content, navigation, and component examples
> here.

## Develop

```bash
moon run docs:dev      # next dev on PORT (default 3000)
moon run docs:build    # production build
```

Workspace packages are transpiled via `transpilePackages` in `next.config.mjs`.
See the repo root `CONTRIBUTING.md` for toolchain setup.

## Known issue — `docs:build` (production) is currently broken upstream

`moon run docs:dev` works; `moon run docs:build` fails during static-export
prerendering with
`TypeError: Cannot read properties of null (reading 'useContext')` on Next's
internal `/_global-error` / `/_not-found` pages. This is a **known Next.js 16
bug**, not in our app code — it reproduces with the error pages removed, and was
verified independent of bundler (Turbopack _and_ webpack), React version (19.1.8
_and_ 19.2.3), Next patch (16.2.3 _and_ 16.2.9), and runtime (bun _and_ node).
Tracking upstream:

- https://github.com/vercel/next.js/issues/85668
- https://github.com/vercel/next.js/issues/86178
- https://github.com/vercel/next.js/issues/84994

Until an upstream fix lands, develop and verify pages with `docs:dev`. Pages
themselves are sound (they typecheck and render in dev); only the production
static export is blocked.
