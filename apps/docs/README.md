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
