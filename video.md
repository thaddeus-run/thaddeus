# Why Git and GitHub Are Bad — Theo's Argument, in Detail

A structured breakdown of the "reinventing source control from scratch" section
of the talk. The framing throughout is blunt: _"GitHub is dying and Git is not
the right primitive."_ Below is every distinct line of argument he makes,
organized thematically rather than in the order he says them.

---

## 1. The core thesis: Git is the wrong abstraction for how we work now

Theo's starting position is not that Git is bad software — he's careful to
acknowledge it was a massive leap forward. Git became the standard _because_ it
was so much better than everything that came before it, and it earned that
position for good reason.

The problem is that "much better than the alternatives in its era" is not the
same as "the right tool today." His claim is that a lot has changed since Git
was introduced, and that both Git _and_ GitHub now feel like they're "rotting at
the core." The needs they were designed around are fundamentally different from
the needs developers actually have in 2026 — especially once you add agents
writing and reading code at scale into the picture. So the critique is less "Git
is buggy" and more "Git is solving a problem we mostly don't have anymore, while
failing at the problems we now have constantly."

## 2. The root cause: it was built for the Linux kernel

A recurring explanation he returns to is _why_ Git lacks the features he wants.
The answer, in his telling, is that Git was built for Linux kernel development,
and for that use case none of the modern conveniences he's asking for were
necessary.

This matters because it reframes the missing features as design assumptions
baked in at the foundation, not bugs that can be patched later. Git assumes a
single open project, fully public, where the _repository_ is the unit that
carries permissions. That assumption sits so deep in the architecture that the
things he wants can't simply be bolted on — they'd require rethinking the
primitive itself.

## 3. The biggest complaint: there is no granular permissioning

This is the heart of his argument and where he spends the most energy. Git has
essentially no concept of permissioning at the level of _contents_. Permission
is an all-or-nothing property of the whole repo.

### The `.env` file as the canonical example

He uses a deliberately naive-sounding question as the wedge: **why can't you
commit `.env` files?** Everyone "knows" the answer — because then everyone with
repo access gets your secrets — but he wants you to sit with _why_ that's the
only option. The real reason is just "that's how Git works": once something is
in the repo, everyone with access has it, and once it's in there, it's in there
forever (in history).

He walks through the cascade of consequences this creates:

- If you open source the project later, those environment variables are sitting
  in the history.
- If you hire and then fire someone, they had the env vars — and probably still
  do, because you likely never handed them the file properly anyway.
- If you let another team work on the project, they get the secrets even when
  they don't need them, simply because the secrets live in the repo.

His sharpest point here is about the _industry_ that has grown up to paper over
this gap. There are many companies and services built purely to manage secrets
and environment variables on top of your codebase. But what every one of those
solutions ultimately resolves to is "just a random file on your computer." The
fact that an entire category of tooling exists to solve this — and that it all
collapses back down to a file — is, to him, proof that **Git itself is failing
us**. The need for that ecosystem is the symptom.

### Permissions belong on changes and files, not the whole repo

Generalizing from secrets, he asks why none of the following are possible:

- Private files inside an otherwise-shared repo.
- Files that only certain people can access while everyone else can't.
- A private branch.
- A pull request that stays private until it merges.
- The ability to _delay_ when merges go public or become visible to the rest of
  the team.

His conclusion is that treating public-versus-private as a **repo-level setting
instead of a change-level option is insane**. Git is built deeply around the
assumption that the repo is what carries permissions, not the contents of the
repo — and that assumption is exactly what blocks all of the above.

## 4. The security dimension: hidden fixes and instant zero-days

He escalates the permissioning argument into a security argument, and this is
where he gets most heated (he even apologizes for "the slight crash out").

The dynamic he's worried about: because everything in Git is public the moment
it lands, anyone — increasingly, _agents_ — can read every patch as it appears.
For something like Linux, people now have agents reading every patch and
flagging anything that looks like a security fix. The result is that attackers
can derive zero-days from a fix _before the fix is even announced_, just by
diffing the public commit.

His proposed alternative shows what Git can't currently do: imagine the Linux
maintainers could merge a security fix, cut a release, ship it to all the
downstream distributions that are vulnerable, and get everyone patched **before
the code itself becomes public**. He concedes this isn't "true open source" in
spirit — and explicitly says he no longer cares, because we're in the middle of
a security crisis and still arguing about where to store files.

The summarizing question from his earlier thread: how many security fixes are
sitting unpublished right now precisely because they'd be exploited the instant
they showed up in the tracker? We need a way to securely merge and cut releases
without that code being visible to the entire world.

## 5. "Open source should not mean 100% of the code is public 100% of the time"

This is the philosophical core he keeps circling back to, taken from a thread he
wrote weeks earlier. His claim is that a lot of software _would_ be open source
if developers weren't forced into total, permanent transparency.

His arguments under this banner:

- **In-flight work is exposing.** Many projects would open source if they could
  hide PRs that are still in progress. You want to hide work that isn't done
  yet, and Git doesn't let you. He gives Claude Code as a hypothetical example:
  it would be far more likely to be open source if the team didn't have to show
  everything they're working on all the time — because half of it never ships,
  and people would have seen the abandoned work and been annoyed.
- **Monorepos are penalized.** He wants to be able to keep a monorepo with some
  sub-packages private, without splitting into multiple repos. He's personally
  had to break projects apart into multiple repos because he wanted to open
  source some of it but couldn't open source the whole thing.
- **The tool dictates the work, not the other way around.** His most general
  framing: having to shape the way you do work around what you want to share —
  instead of using your tools to shape what gets shared — is just stupid. The
  granularity should be yours to control.

He admits it sounds silly to fixate so hard on the env-var example, but his
point is that we've all become normalized to these constraints as
obviously-correct when there's no good reason for them. It's dumb, but it's how
it works, so we accept it.

## 6. Commits are bad, branches are worse — and JJ points the way

Moving from permissions to the underlying data model, he argues the basic units
are wrong:

- **Commits** aren't terrible. He calls them a "reasonable base unit," but says
  they don't work well for how we build today.
- **Branches** are worse than commits.

His positive reference point is **JJ (Jujutsu)**. He's openly resisting the urge
to go all-in on it, because JJ doesn't actually solve the problems he cares most
about (the permissioning issues above). But what it _does_ solve, it solves so
well that it just feels better to use. JJ fixed a lot of the day-to-day
ergonomic pain of source control management.

The specific idea he praises is **snapshots and tags instead of branches and
commits**. In a world where developers are constantly thinking about commits and
worrying about their history, JJ was a breath of fresh air that showed how much
time we waste thinking about things that ultimately don't matter. It's what got
him thinking seriously about what an "un-fucked" Git would look like.

## 7. Work trees are atrocious

He singles out Git work trees for particular contempt — "it is actually
hilarious how bad work trees are."

His concrete anecdote: he had a cloned repo where one of the work trees, driven
by an agent, checked out `main`. Because of how work trees handle branch
checkouts, he then _couldn't_ check out `main` in the actual main directory — a
random work tree had effectively taken the branch hostage. He describes the work
tree as a Git primitive he simply doesn't like at all. (This is increasingly
relevant because spinning up work trees is a common pattern for letting multiple
agents work in parallel.)

## 8. Source control shouldn't require real file systems or operating systems

This is where he flags the argument gets more controversial. He doesn't think
interacting with source control should require a real OS and real files on disk
at all.

The expectation that you interface with Git through a CLI in a real environment
with real files looks outdated to him given tools like **just bash** — a full
JavaScript/TypeScript layer that emulates bash, so an agent (a Claude Code /
Codex-style tool) can run without a real Linux kernel or file system, entirely
in memory inside JavaScript, none the wiser. His point: it's far easier to clone
things around inside memory than to physically move large numbers of files
around on a real system.

## 9. The file system performance problem (APFS is the villain)

He spends a long tangent justifying the "move away from file systems" position
with a concrete benchmark (shared with him by "Novox Populi"). The benchmark
measures disk performance for tools like Git across platforms.

How it works: clone a project containing several boilerplate sub-frameworks with
a lot of dependencies, run a `pnpm install` entirely from cache (so **no network
access** — it's purely recreating files in directories), and measure how long
the file creation takes.

The numbers that "haunt" him:

| Setup                                                                                | Time for the same clean install |
| ------------------------------------------------------------------------------------ | ------------------------------- |
| Mid-range, older AMD CPU + lots of RAM + ordinary Western Digital SSD, on **Ubuntu** | **~6.8 seconds**                |
| **M4** chip with Apple's fancy SSD, on macOS                                         | **~31 seconds**                 |
| **M1 Ultra**, on macOS                                                               | **up to ~140 seconds**          |

So a task that a comparable MacBook running Ubuntu does in roughly 3–12 seconds
can take an M1 Ultra around 140 seconds. His conclusion: **APFS (Apple's file
system) is garbage** at creating lots of small files — these small-file
read/writes are where it falls apart, even with extremely fast hardware. He
suspects `fsync` is the culprit but admits he isn't deep enough to be sure, and
says he doesn't care — all he knows is it sucks.

The downstream implications he draws:

- This makes spinning up lots of small environments for agents to work in
  genuinely painful.
- It makes otherwise "crazy" solutions — like a RAM disk using a different file
  system technology — actually make sense.
- It's a platform-specific rat's nest: something that runs great on Ubuntu can
  run terribly on a Mac purely because of weird file-system-layer behavior.
- In-memory representations (he gestures at Node.js here) avoid all of this,
  because you never touch the platform-specific implementation details of the
  file system on your machine.

This is the practical, performance-based half of his "I'm done with file
systems" stance, complementing the architectural argument in section 8.

## 10. Existing attempts don't address the fundamental problem

He's aware people are already working in this space, but argues they're all
aiming at the wrong target:

- **Delta DB** (from Zed) and the new **Origin** stuff Cursor just released are
  the examples he names.
- But most of these efforts are about _adding context for agents to use_, or
  making it _easier to clone a repo_ so multiple agents can work in parallel.
- **None of them are trying to address the fundamental flaw within Git** — the
  permissioning model. They're improving the experience around Git, not
  rethinking the primitive.

He frames his own attention as split: he's "using his AI psychosis to fix clouds
for agents" and wants someone else to use theirs to fix source control, because
he's too deep on the cloud problem to do it himself.

## 11. What he actually wants (and why now)

The critique points toward a wishlist rather than a finished design. In short,
he wants a source-control system where:

- **Public/private is a property of changes, files, and branches** — not the
  whole repo.
- You can keep secrets, in-flight PRs, and private sub-packages inside a single
  repo without leaking them or splitting into multiple repos.
- You can **merge and cut releases privately**, then reveal the code on your own
  schedule (critically, for security patches).
- The base units are rethought along JJ's lines (snapshots/tags over
  branches/commits), with the ergonomic wins JJ already demonstrates.
- The whole thing doesn't depend on a real OS or file system, sidestepping
  problems like APFS's small-file performance.

His meta-point — the reason he's bothering to publish all this — is that
rebuilding something as large as Git/GitHub _used_ to make no economic sense:
too expensive to build, unlikely to win users. With modern agents, the cost has
dropped enough that it might finally be worth attempting. He notes this requires
building a lot of pieces (he started a project he called **FS2 / "file system
two"** but felt even that didn't go far enough), and he openly hopes someone in
his audience takes it on rather than waiting for the duopoly to fix itself.

---

### One-line summary of the whole argument

> Git won because it beat its predecessors, but it was built for fully-public
> Linux kernel development, so it treats the _repository_ as the unit of
> permission. In a world of secrets, in-flight work, security patches,
> monorepos, agents, and cross-platform performance traps, that single
> assumption is the root cause of almost everything wrong with both Git and
> GitHub — and no one is fixing the primitive itself.
