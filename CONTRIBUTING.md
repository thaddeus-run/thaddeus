# Contributing

This monorepo uses [proto](https://moonrepo.dev/docs/proto) to manage the
toolchain and [moon](https://moonrepo.dev/docs) to run tasks. Every tool version
(bun, node, moon, gh) is pinned in `.prototools`, so once proto is installed,
everything else resolves to the right version automatically when you are inside
the repo.

## Setup

1. **Install proto**
   ([official guide](https://moonrepo.dev/docs/proto/install)):

   ```bash
   curl -fsSL https://moonrepo.dev/install/proto.sh | bash
   ```

   Restart your shell afterwards so proto's shims are on your `PATH`.

2. **Install the toolchain** — from the repo root, proto reads `.prototools` and
   installs the pinned bun, node, moon, and gh:

   ```bash
   proto use
   ```

   (`.prototools` has `auto-install = true`, so simply running `bun` or `moon`
   also installs them on demand.)

3. **Install dependencies**:

   ```bash
   bun install
   ```

   Dependency versions live in the root `package.json` `workspaces.catalog`;
   packages reference them with `"catalog:"`. Don't add versions directly to
   package-level manifests.

4. **Git hooks** are managed by moon (`vcs.hooks` in `.moon/workspace.yml`) and
   are generated automatically by the first moon command you run — no install
   step. Pre-commit typechecks the projects affected by your staged files and
   runs lint-staged.

## Running tasks

moon is the only task runner; `package.json` scripts exist solely for npm
lifecycle hooks. Tasks run from anywhere in the repo:

```bash
moon run <project>:<task>      # e.g. moon run store:build
moonx <project>:<task>         # shorthand
moon run :test                 # run a task across every project that has it
moon tasks <project>           # discover a project's tasks
moon project <project>         # inspect a project's config and dependencies
```

moon builds dependency projects first, caches outputs, and skips tasks whose
inputs haven't changed.

Common entry points:

| Task                             | What it does                                      |
| -------------------------------- | ------------------------------------------------- |
| `moonx docs:dev`                 | Docs site (Next.js) dev server                    |
| `CI= moonx landing:dev`          | Landing site (TanStack Start) dev server          |
| `moonx store:build`              | Build a package (bundle dist + type declarations) |
| `moonx <project>:typecheck`      | Typecheck (builds workspace deps first)           |
| `moon run root:format root:lint` | Repo-wide format + type-aware lint                |

## Before you push

```bash
moon run root:format root:lint
moon exec :typecheck --affected
```

plus the focused tests for whatever you changed (`moonx <project>:test`). CI
runs the affected portion of the graph, so a green local baseline usually means
a green PR.

## Repo conventions

- Agent-facing rules and the verification baseline live in `AGENTS.md`; deeper
  domain conventions live in `.agents/skills/`.
- **Thaddeus** is the company; **Strata** is the working product name; packages
  are scoped `@thaddeus.run/*` with neutral names. See `AGENTS.md` → Naming.
- Published packages use plain `bun publish`, which runs their moon `prepublish`
  guard chain automatically.
