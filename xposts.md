# The Case Against Git and GitHub

_A detailed outline of the author's argument that Git is the wrong **primitive**
for source control — and that GitHub, built on top of it, is dying. The piece is
a deliberate thought-dump: a provocation meant to get someone to build a
replacement, not a finished proposal._

---

## Framing and context

The author situates the critique inside their own work on AI agents. They
describe themselves as consumed by "fixing clouds for agents" and argue that
source control needs the same kind of ground-up rethink — but they admit they
are too far down the cloud rabbit hole to take it on personally. So the post
functions as a challenge thrown to someone else: pick this up.

Two load-bearing claims appear immediately, and everything else hangs off them:

1. **GitHub is dying.** The dominant platform is treated not as permanent
   infrastructure but as something on its way out.
2. **Git is not the right primitive.** This is the more important claim. The
   problem is framed as _foundational_, not cosmetic. The argument is not "git
   has some annoying features" but "the core abstraction git chose is wrong, and
   everything built on it inherits that wrongness."

A recurring lens runs through the whole piece: **agents**. Several of the
complaints only fully make sense once you picture many AI agents working in
parallel on the same codebase, each needing its own view of the files, each
needing fast and cheap access. The author keeps returning to the idea that
tooling designed for a single human typing in one place is a poor fit for that
future.

---

## The central thesis

The unifying idea behind every individual gripe is this: **git's flaws are hard
to see precisely because we have used it for so long.** Decades of familiarity
have normalized friction that we would never tolerate in a tool designed fresh
today. We have mistaken "the way git works" for "the way source control must
work."

The author's blunt summary is that git "isn't perfect — it's barely even good,"
and that we have simply lived with it long enough that the cracks have become
invisible. The closing ask is therefore less about any one feature and more
about _attitude_: be more introspective, stop treating git's constraints as laws
of nature, and accept that we can do dramatically better.

---

## Argument 1 — "Open source" shouldn't mean "100% public, 100% of the time"

**The claim:** visibility in source control is treated as a crude binary — a
repository is either public or private, and a file is either committed or not —
when it should be **granular** (varying by path) and **dynamic** (varying over
time). The author argues that the all-or-nothing model quietly imposes enormous
costs.

The author makes the case largely through a series of rhetorical questions, each
pointing at wasted effort that exists _only because_ of the binary model:

- **`.env` leaks.** A huge amount of collective energy goes into stopping
  secrets from being committed to source control in the first place — gitignore
  rules, pre-commit hooks, secret scanners, history rewrites after a leak. This
  entire category of work exists because the system has no native concept of
  "this content is sensitive."
- **Reinvented env-var sharing.** Because the VCS won't hold
  sensitive-but-shared values, teams have invented "many miserable ways" to pass
  environment variables around out of band. The author sees this reinvention as
  a symptom of a missing primitive, not a series of independent problems.
- **In-flight PRs.** Some projects would happily be open source if they could
  keep _work in progress_ hidden until it is ready. The inability to hide
  unfinished changes pushes projects toward staying closed.
- **Unpublished security fixes.** This is the sharpest example. A security fix
  becomes an exploit the instant it is visible: as soon as it lands in the
  public tracker, attackers can reverse it into an attack. So fixes sit
  unpublished. The binary visibility model directly harms security.
- **Private sub-packages in a monorepo.** The author wants to keep a single
  monorepo but mark some sub-packages as "private," without being forced to
  split the project into multiple repositories just to draw a visibility
  boundary.

**The underlying point:** source control should let visibility be set per path
and change over time, rather than forcing the whole tree into one of two states.
"Open source" should be able to mean "open _enough_" — most code public, some
parts private, some parts private only _for now_ — all within one repository.

---

## Argument 2 — Commits are a bad primitive, and branches are worse

**The claim:** the commit forces developers to manage history _constantly_, and
the branch makes this worse. This constant history-management is a tax on
attention that should not exist at all.

**Reference point — `jj` (Jujutsu).** The author points to Jujutsu, a newer
version-control system, as getting "much closer to right." (Jujutsu reworks the
model so that the working copy is itself automatically tracked and snapshotted,
removing the explicit "stage, then commit" ritual.) The author is not claiming
jj is the final answer, but using it as proof that a better model already
exists.

**The workflow the author actually wants:**

- Work is **staged continuously**, as you type, without you asking for it.
- **Snapshots happen automatically** whenever you run any command at all —
  history captures itself as a side effect of working.
- You **just edit the code**. How that work is "tracked" is a _later_ concern,
  handled when you care about it, not something forced on you in the moment.

**The contrast with git:** in git, commits make you stop and consciously decide
_how to record history_ at the exact moment you are trying to think about _the
code_. Branches compound this by forcing you to maintain a mental model of your
history's shape at all times. The author calls this "stupid and a waste of our
time" — not because tracking history is worthless, but because being forced to
think about it continuously is.

---

## Argument 3 — Worktrees are an abomination

**Context:** git _worktrees_ let you check out multiple branches into separate
directories from a single repository, so you can work on more than one thing
without re-cloning. They are the standard answer to "I need two copies of this
project checked out at once" — which is exactly what parallel work (and parallel
agents) demands.

**The claim:** the entire worktree implementation in git is so bad that it
should be **ignored entirely**. Source control should make _stronger assumptions
about the filesystem_ and handle this for you, rather than leaving you to
assemble it by hand. The author's verdict: "we've been taken for fools."

**The specific grievances:**

- **You implement copy-on-write yourself.** The filesystem is perfectly capable
  of cheap copy-on-write, yet the burden of arranging it lands on the developer.
  Why should this be your job rather than the tool's?
- **You can't check out the same branch in two places at once.** This is treated
  as an artificial, pointless restriction. There is no good reason the same
  branch shouldn't be open in two locations simultaneously.
- **You fight to keep worktrees in sync with `main`.** Keeping multiple
  worktrees updated against the main branch takes constant manual effort —
  effort the author sees as pure overhead.

**The agent angle:** this is where the future-of-agents lens is most explicit —
"our agents deserve better." If you imagine many agents each needing their own
working copy of a codebase, the clumsiness of worktrees stops being a minor
annoyance and becomes a hard blocker. A system designed for that world would
treat "many simultaneous working copies of the same code" as a first-class,
cheap, automatic operation.

---

## Argument 4 — Source control shouldn't require a "real OS" and filesystem

**Reference:** the author invokes tools like _just-bash_ — lightweight
environments that run logic without a full operating system underneath — to make
the point that heavy assumptions are no longer necessary.

**The claim:** needing a full kernel and a real filesystem _just to interface
with git_ is absurd in a world of lightweight, sandboxed, ephemeral execution.
The author argues that **reading and updating files should be doable through
simple API calls**, rather than requiring a complete OS environment to mediate
every interaction.

**Why this matters (and the agent connection again):** git is built on the
assumption that there is always a real machine with a real filesystem to operate
on. But agents and cloud workflows increasingly run in stripped-down sandboxes
where standing up a full OS just to talk to source control is wasteful and slow.
If the source-control layer exposed a clean API for reading and writing files,
it could live natively in those lightweight environments — which is precisely
where the author expects future development (especially agent-driven
development) to happen.

---

## The through-line: source control designed for agents

Read together, the four arguments are not four unrelated complaints — they
converge on a single picture of what source control _should_ be, especially in a
world of AI agents:

- **Granular, time-varying visibility** instead of a public/private binary
  (Argument 1).
- **Automatic, ambient history** instead of manual commit-and-branch management
  (Argument 2).
- **Cheap, unlimited, simultaneous working copies** instead of hand-built
  worktrees (Argument 3).
- **Lightweight API access** instead of a mandatory full OS and filesystem
  (Argument 4).

The common enemy is the same in every case: **git makes the developer (or the
agent) do work that the system itself should be doing** — managing secrets,
managing history, managing copies, managing the environment. The author wants
those burdens absorbed by smarter primitives.

---

## Conclusion — be more introspective

The author closes by stepping back from the specifics. They have "many more
thoughts" but want to get back to work, so the piece is explicitly unfinished —
an invitation rather than a blueprint.

The single takeaway they ask the reader to keep is attitudinal: **git isn't
perfect; it's barely even good. We've dealt with it for decades, so it's hard to
see the cracks. Be more introspective — we can do so much better.**

The deeper message is that the most dangerous flaws in our tools are the ones we
have stopped noticing. Long familiarity is not the same as quality, and the fact
that git has survived for decades is not evidence that it is good — only that we
have adapted around it. The work the author is calling for is first to _see_ the
cracks, and then to build the thing that doesn't have them.

---

### Quick reference: the arguments at a glance

| #   | Target                   | Core complaint                            | What "better" looks like                             |
| --- | ------------------------ | ----------------------------------------- | ---------------------------------------------------- |
| 1   | Public/private model     | Visibility is an all-or-nothing binary    | Per-path, per-time visibility within one repo        |
| 2   | Commits & branches       | Forces constant manual history management | Continuous auto-staging and snapshots (à la `jj`)    |
| 3   | Worktrees                | Clumsy, manual, artificially restricted   | OS-assisted, cheap, unlimited simultaneous checkouts |
| 4   | OS/filesystem dependency | Needs a full kernel + filesystem to use   | Simple API calls to read and update files            |

_Note: jujutsu (`jj`) and just-bash are referenced as existing examples that
point toward the author's preferred direction; they are cited as evidence that
better primitives are possible, not endorsed as the final answer._
