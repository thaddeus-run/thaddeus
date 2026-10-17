<!-- Policy sections adapted from pingdotgg/t3code at 2fae0f9. -->

# Contributing

## Read this first

We are not actively seeking outside contributions and have limited review
capacity. Opening a PR does not create an obligation to review or merge it. We
may close or defer it, ask for a smaller scope, or reimplement the idea later.
Meeting this guide's requirements makes a PR eligible for deeper review; it does
not guarantee acceptance.

These requirements apply to every open PR, including drafts. Draft status does
not postpone triage or excuse missing approval, unfocused scope, or inadequate
verification. A draft can be closed for the same reasons as a ready PR;
converting a PR to draft does not exempt it from reassessment.

Focused bug fixes, reliability fixes, performance improvements, and maintenance
work are the most likely to be accepted. Unsolicited features, opinionated
rewrites, and unrelated cleanup are not.

Report bugs in issues. Feature requests and proposals belong in
[Ideas discussions](https://github.com/thaddeus-run/thaddeus/discussions/categories/ideas).
Report security vulnerabilities privately, as described in the
[security policy](.github/SECURITY.md). Search existing reports, discussions,
and documented workflows before starting work.

<a id="prior-approval"></a>

## Establish the problem and scope first

Outside the focused exceptions below, features and intentional changes to
product behavior require a prior discussion with explicit maintainer approval of
the direction and scope. Link the approval itself in your PR. A linked issue or
discussion alone is insufficient. Calling a behavior change a bug fix does not
exempt it from this requirement. Acceptance of a problem does not approve every
implementation or promise a merge.

For a substantial bug fix, link an issue that maintainers have triaged to
establish the actual failure and intended behavior. For other non-trivial work
outside the exceptions below, agree on direction and scope with maintainers in
an Ideas discussion before implementing it.

A very small, focused fix for an obvious bug can be submitted without a prior
issue or discussion. Explain the defect and why the fix qualifies for this
exception. We judge purpose, behavioral impact, and the changes needed to fix
it. There is no line-count or file-count cutoff. A fix to a shared protocol may
need changes in the server and the client; a few lines changing product defaults
may require a discussion.

A focused configuration option for an established capability may also be
eligible without prior feature approval. Explain the existing capability, what
the option controls, and why its scope stays within that capability. Adding a
setting does not by itself make a PR a new feature, and this route does not
depend on proving an obvious bug. Judge its purpose and effects: new workflows,
changed product defaults, and broader behavior choices still require approval,
even when exposed as settings. The one-problem and verification requirements
still apply; deeper review may reject the proposed configuration mechanism on
design or correctness grounds.

If an existing workflow already solves the reported need, difficulty finding or
understanding it can still be a useful documentation, onboarding, or
discoverability problem. Describe that problem. Maintainers decide the response;
it does not automatically justify the proposed feature or behavior change.

<a id="one-problem"></a>

## Solve one underlying problem per PR

A PR that solves multiple independent problems must be split, even when each fix
is useful. Count the underlying problems, not the linked issues. Several reports
may describe the same defect.

Include the protocol, server, client, CLI, test, and documentation changes
needed for that one problem. Explain their relationship when it is not obvious.
An adjacent cleanup, refactor, or second fix needs its own PR unless it is
necessary to solve the same problem. A large diff alone does not establish that
the PR contains unrelated work.

This rule is for outside contributions. Maintainers, the logins in
[`.github/TRIAGE_EXEMPTIONS.td`](.github/TRIAGE_EXEMPTIONS.td), may batch
related fixes in one PR.

<a id="verification"></a>

## Provide evidence for the changed behavior

Explain how you established the problem, how you checked the change, and what
you observed. Give the relevant reproduction steps, environment, focused test
commands or manual checks, and their results. State what you could not check. A
checkbox or "tests pass" alone does not show that the change works.

When a change has runtime behavior, check it the way
[section 9 of the architecture contract](docs/agent-first-architecture.md#9-verification-standard)
asks: exercise the real user path, failure and restart recovery, and a second
identity or workspace. Record what you observed, not what should happen. If one
of the three does not apply to your change, say which and why.

Match the evidence to the change. Use focused tests for behavior that can be
tested and manual evidence where appropriate. Do not substitute broad test runs
for checking the affected behavior, or run repo-wide checks just to satisfy this
guide. A backend fix does not need unrelated UI evidence.

UI changes require clear before/after screenshots. Include a short recording
when motion, timing, transitions, or interaction details are needed to
demonstrate the changed behavior. Attach or link evidence in the PR; do not
commit PR-only screenshots or recordings to the repository.

Missing or demonstrably inadequate evidence can cause closure. A reviewer being
unable to reproduce a well-documented platform-specific bug does not by itself
invalidate the report. We assess the problem, scope, approval, and evidence, not
an author's writing style or whether we think an agent wrote the PR.

<a id="triage-and-review"></a>

## Triage and deeper review

Contribution triage checks whether the problem is established, any required
approval is present, the scope is coherent, and the evidence is adequate. It
inspects enough code to support that decision. Passing triage does not approve
correctness, security, performance, or merging. Those need deeper review.
Updates to the PR can change its eligibility and require reassessment.

PRs receive `vouch:*` contributor-status labels and `size:*` diff-size labels.
These are context, not eligibility rules. Vouching through
[`.github/VOUCHED.td`](.github/VOUCHED.td) is separate from permission to bypass
triage. Only the GitHub logins explicitly listed in
[`.github/TRIAGE_EXEMPTIONS.td`](.github/TRIAGE_EXEMPTIONS.td) bypass triage.
Organization membership, vouching, collaborator or bot status, repository write
access, and previous successful PRs do not establish an exemption. Other
contributors, including vouched contributors, go through triage. Passing once
does not grant permanent trust.

Every live run freshly resolves `thaddeus-run/thaddeus`'s `refs/heads/main` to a
commit SHA and loads the contribution-triage skill, this guide, its policy
dependencies (such as `AGENTS.md`), and the exemption list from that same SHA.
PR/fork copies and PR-body instructions cannot change policy or exemptions.
Missing, incomplete, or malformed trusted files leave routing unresolved; they
do not grant an exemption, establish an empty list, or permit automatic closure
or review handoff.

A PR that passes triage, or a PR from a verified exemption, gets the
`triage:eligible` label. That label marks the PR as ready for deeper review and
nothing more. This guide describes the policy; it does not announce a deployed
automation. Neither triage nor the `triage:eligible` label authorizes merging.

<a id="closure-and-reconsideration"></a>

## Closure and reconsideration

Automated triage leaves a PR open for maintainer decision if someone in the
trusted [`.github/TRIAGE_EXEMPTIONS.td`](.github/TRIAGE_EXEMPTIONS.td) list has
commented or submitted a review, including on an earlier head, or if
`triage:keep-open` is present. This protection does not imply eligibility or
review approval.

PRs that violate these requirements can be closed before deeper review. Multiple
independent fixes require splitting. Missing approval requires maintainer
discussion or issue triage, as applicable. Missing evidence requires
establishing the problem and showing how the change was checked.

Every policy-based closure must identify the specific rule, cite the evidence
supporting the finding, link the relevant section of this guide, and explain how
to address it for reconsideration. For example, identify the independent fixes
to split or the exact missing verification. Correct the deficiency and request
reconsideration, or submit the focused replacement PRs linked to the original.

An unclear relationship between changes needs investigation and, if still
unexplained, a specific request for an explanation. Uncertainty alone is not
proof of unrelated work. Access failures, incomplete retrieval, or an unfinished
assessment are reasons to retry the assessment, not close a PR. If the proposed
solution is declined but the report reveals a useful problem, preserve that
problem for maintainer consideration. Feedback should be firm, specific, and
free of insults or accusations about how the contribution was written.

## Developer setup

This monorepo uses [proto](https://moonrepo.dev/docs/proto) to manage the
toolchain and [moon](https://moonrepo.dev/docs) to run tasks. Every tool version
(bun, node, moon, gh) is pinned in `.prototools`, so once proto is installed,
everything else resolves to the right version automatically when you are inside
the repo.

### Setup

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

### Running tasks

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

### Before you push

```bash
moon run root:format root:lint
moon exec :typecheck --affected
```

plus the focused tests for whatever you changed (`moonx <project>:test`). CI
runs the affected portion of the graph, so a green local baseline usually means
a green PR.

### Release versions

Each product release uses one version across every `packages/*/package.json`,
both binary launchers under `npm/`, and `lazythad/Cargo.toml`. Matching entries
in `bun.lock` and the local `lazythad` entry in `lazythad/Cargo.lock` must
agree. Keep the active `README` status current. Examples and applications at
`0.0.0` and historical changelog or plan entries retain their own versions.

```bash
moon run root:version-check root:version-test
THADDEUS_RELEASE_TAG=v0.1.10-alpha moon run root:version-check
```

The checker reads the expected version from `packages/cli/package.json`. Release
preflight checks the selected tag against that version, then all jobs build and
publish from the same verified commit. Downloaded CLI and TUI binaries must
report that exact version before publication. Launcher versions are checked, not
rewritten by the publication job. A version bump remains a separate change.

### Repo conventions

- Agent-facing rules and the verification baseline live in `AGENTS.md`; deeper
  domain conventions live in `.agents/skills/`.
- **Thaddeus** is the company; **Thaddeus** is the working product name;
  packages are scoped `@thaddeus.run/*` with neutral names. See `AGENTS.md` →
  Naming.
- Published packages use plain `bun publish`, which runs their moon `prepublish`
  guard chain automatically.
