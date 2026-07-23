# Safe Agent Mode Design

**Date:** 2026-07-23 **Status:** Approved

## Context

Thaddeus's core product idea is a capability-based permission model: an agent
should receive explicit, limited authority before it acts instead of broad
repository access followed by review after the fact. The existing substrate
already has signed agent delegations, path and change budgets, an isolated
virtual filesystem, signed provenance, policy-gated landing, and a remote
client/server. Those primitives currently assume a native Thaddeus repository.

Adoption has a separate constraint. Individual developers already keep their
projects and collaboration workflows in Git and GitHub. Asking them to migrate
before they experience the permission model makes the product's most important
idea harder to discover.

Safe Agent Mode is the acquisition wedge. It lets a developer run Claude Code,
Codex, or any local command inside an enforced Thaddeus permission sandbox while
remaining in an ordinary Git checkout. The result may stay local or become a
normal GitHub pull request with a signed permission proof. That GitHub proof is
the "aha": the agent was restricted before execution. Native Thaddeus and
ThadHub remain the destination for persistent identity, permissions, provenance,
semantic history, and hosted workflows.

## Product thesis

GitHub controls what may merge. Safe Agent Mode controls what an agent may read
and write while it works.

The initial experience must prove one narrow capability well:

> The launched command and all of its descendants could read and write only the
> filesystem authority the developer explicitly approved.

Network access is unrestricted in the first version and must be disclosed
wherever the filesystem guarantee appears.

## Goals

- Run a generic local command inside enforced read and write boundaries from an
  ordinary Git checkout without migrating the repository.
- Provide polished Claude Code and Codex presets over the generic command
  wrapper.
- Suggest a small permission set interactively and require explicit approval
  before execution.
- Enforce the same grant against the command and every child process on Linux
  and macOS.
- Keep the agent away from the real checkout, `.git`, Git credentials, and host
  user files outside the approved runtime inputs.
- Safely keep, discard, or publish the resulting patch.
- Produce a signed, content-free proof of the approved grant and resulting
  changes.
- Display that proof in a GitHub pull request, preferably as a first-class
  `Thaddeus / Safe Agent` check.
- Reuse the local grant, execution, and proof contracts for a later hosted
  GitHub issue workflow.
- Create a clear, explicit path from one Safe Agent run into native Thaddeus and
  ThadHub without silently migrating or uploading the repository.

## Non-goals

- Windows support in the first version.
- Network isolation, domain allowlists, or network-attempt auditing.
- Making GitHub or Git the long-term source of truth for native Thaddeus
  metadata.
- Bidirectional Git-to-Thaddeus synchronization.
- Giving the sandboxed process access to `.git`, GitHub tokens, branch creation,
  commits, pushes, or pull-request APIs.
- Automatically migrating a Git repository, changing its remotes, or uploading
  source code to ThadHub.
- Claiming a complete log of denied filesystem attempts. Native platform
  sandboxes enforce the boundary but do not portably expose every denied access
  attempt.
- Treating agent-provided tool logs as the security proof.
- An unsandboxed compatibility fallback inside `thad agent`.

## Chosen approach

Safe Agent Mode uses native operating-system process isolation around a
permission-projected copy of the working tree:

- Linux uses user and mount namespaces plus explicit read-only and read-write
  mounts.
- macOS uses a generated process sandbox policy over the same logical
  projection.
- A common sandbox-driver interface and conformance suite hold both
  implementations to the same behavior.
- A future container driver may implement the same interface, but is outside the
  first version.

Native isolation was chosen over a container requirement because local agent
authentication, terminals, Git credentials, and host tooling must remain easy
for an individual developer. It was chosen over "copy and validate afterward"
because final-diff validation cannot prevent a generic process from reading
files elsewhere on the machine.

Post-run validation remains defense in depth. A result is never applied merely
because the platform sandbox reported success.

## Product surface

### Generic wrapper

```sh
thad agent -- <command> [args...]
```

Everything after `--` is an exact argument vector. It is not reconstructed as a
shell command. A developer who intentionally wants a shell may invoke one
explicitly:

```sh
thad agent -- sh -lc 'my-agent --flag'
```

### Presets

```sh
thad agent claude
thad agent codex
```

Presets resolve the executable, select recommended invocation arguments, expose
only the minimum known configuration and credential inputs, label the agent in
the proof, and provide agent-specific diagnostics. They do not bypass the
generic grant or sandbox engine.

Unknown preset names are not interpreted as arbitrary commands. Arbitrary
commands require the explicit `--` separator.

### Explicit permission flags

Interactive suggestions are the default. Repeatable explicit flags provide a
scriptable alternative:

```sh
thad agent claude \
  --read 'src/**' \
  --read 'test/**' \
  --write 'src/auth/**' \
  --write 'test/auth/**'
```

Exact flag spelling and configuration-file syntax belong in the implementation
plan, but the underlying grant must distinguish read, write, and deny patterns.
Write authority implies read authority. Deny always wins.

### Completion modes

An interactive run offers:

1. keep verified changes in the current checkout;
2. create a branch and GitHub pull request;
3. discard the isolated result.

Non-interactive modes provide equivalent `--keep`, `--pr`, and `--discard`
behavior. A failed or interrupted agent never publishes automatically.

## First-run flow

### 1. Preflight

Before asking for permissions, Safe Agent Mode:

- confirms it is inside a supported Git working tree;
- identifies the repository root without exposing `.git` to the agent;
- checks that the selected platform driver can enforce the contract;
- resolves the command or preset without executing it;
- captures the task from an argument or interactive prompt;
- inspects the repository layout and existing project instructions;
- detects existing working-tree changes;
- creates or loads the developer's local Thaddeus signing identity.

Creating the local identity does not initialize or migrate the repository. It is
the stable device identity that signs approved trial grants and can later be
reused by native Thaddeus.

### 2. Permission proposal

The planner suggests the smallest practical grant from:

- task text and paths explicitly mentioned in it;
- repository layout;
- selected preset;
- common manifest, lockfile, source, and test conventions;
- existing project instructions;
- sensitive-path defaults.

The suggestion is advisory. It cannot expand after approval. The planner may
inspect repository paths, conventional manifest metadata, and explicit
project-instruction files. It does not read the contents of sensitive-path
defaults merely to make a suggestion.

Example:

```text
Task: Fix password-reset validation
Agent: Claude Code

Read
  src/**
  test/**
  package.json
  bun.lock

Write
  src/auth/**
  test/auth/**

Denied
  .env*
  secrets/**
  .git/**
  .github/**

Network
  unrestricted

The command and all child processes receive these permissions.
Start? [y/N]
```

The developer may approve, edit, or cancel. The default answer is no. An
approved canonical grant is signed before the command starts.

### 3. Existing changes

Safe Agent Mode never edits the real checkout during execution. It snapshots the
current working tree and asks whether existing uncommitted content should be
included in the agent's starting view.

The snapshot records content fingerprints for every destination the agent may
write. This enables conflict-safe application if the developer edits the real
checkout while the agent is running.

### 4. Execution

The snapshot is projected into an isolated execution root. The selected native
driver launches the exact argument vector with:

- approved repository paths read-only or read-write;
- denied repository paths absent;
- `.git` absent;
- a synthetic minimal home directory;
- preset-specific credentials and configuration read-only;
- the minimum system executables, runtime libraries, certificates, and device
  resources required to run the selected command;
- a private writable runtime scratch and cache area that is discarded rather
  than imported into the repository;
- an interactive pseudo-terminal when the selected command needs one;
- unrestricted network access.

The process and all descendants inherit the boundary. The trusted parent retains
control of lifecycle, signal forwarding, proof construction, Git operations, and
result import.

### 5. Review and disposition

When execution ends, Safe Agent Mode compares the isolated result with its
starting snapshot and constructs a patch. Before any real-checkout mutation it:

- rejects paths outside the approved write set;
- rejects unsafe symlinks and unsupported special filesystem objects;
- verifies original destination fingerprints;
- shows a patch summary;
- labels nonzero or interrupted results as incomplete.

The developer may inspect and keep a verified incomplete result, but it is never
published automatically.

## Canonical grant

The permission planner emits a versioned canonical record. Its exact wire
encoding belongs with the implementation, but its semantic fields are:

```ts
interface SafeAgentGrant {
  readonly version: 1;
  readonly operator: string;
  readonly taskDigest: string;
  readonly command: {
    readonly executableDigest: string;
    readonly argumentsDigest: string;
  };
  readonly preset: 'claude' | 'codex' | null;
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly deny: readonly string[];
  readonly network: 'unrestricted';
  readonly repository: {
    readonly head: string;
    readonly dirtySnapshotDigest: string | null;
  };
  readonly issuedAt: string;
  readonly runId: string;
  readonly signature: string;
}
```

Task text and the exact argument vector remain in the local run manifest. The
signed grant binds their domain-separated digests so the proof can establish
which approved inputs were used without publishing them. The interactive
approval still shows the task and exact executable to the developer.

Paths are canonical repository-relative POSIX paths and patterns regardless of
host separator. Empty segments, absolute paths, traversal, NULs, invalid
Unicode, and ambiguous normalization are rejected. Case-collision checks use the
actual filesystem's semantics.

Rules are evaluated in this order:

1. unconditional system denies such as the real `.git` directory and signing key
   material;
2. explicit deny patterns;
3. write patterns;
4. read patterns;
5. deny by default.

Write implies read for the same resolved path. A write pattern cannot override
an explicit or unconditional deny.

The grant describes repository authority. A separately versioned runtime profile
describes the system files, preset credentials, terminal devices, and disposable
writable scratch needed to launch the command. Its human-readable summary
appears in the expanded approval view. Its identifier and manifest digest appear
in the proof so the security claim does not hide implicit host access or scratch
authority.

## Components

### Permission planner

The planner owns task-based suggestions, pattern normalization, sensitive-path
defaults, editing, and canonical grant construction. It has no authority to
launch a process.

Suggestion logic must be deterministic for a given task, repository snapshot,
preset, and planner version. The proof records that planner version.

### Snapshot builder

The snapshot builder captures a stable view of the Git working tree without
copying Git control data. It preserves ordinary files, executable bits, safe
repository-relative symlinks, and the selected uncommitted content.

It does not follow repository symlinks into host paths. Submodules are included
only as their checked-out working-tree content; their nested Git metadata is
excluded. Unavailable large-file content is reported before execution rather
than silently replaced.

### Permission projection

The projection converts the snapshot and canonical grant into a manifest of:

- visible read-only repository paths;
- visible read-write repository paths;
- absent paths;
- synthetic-home entries;
- preset runtime entries;
- required system runtime entries.

The projection is constructed in a private run directory with restrictive host
permissions. It exposes no user-home root and no original checkout path to the
child.

### Sandbox-driver contract

```ts
interface SandboxDriver {
  inspectSupport(): Promise<SupportReport>;
  run(request: SandboxRequest): Promise<ExecutionResult>;
}
```

`inspectSupport` performs an active harmless self-test, not merely an operating
system name check. `run` accepts a fully resolved projection and exact argument
vector. Drivers cannot add repository authority.

Each driver must:

- prevent reads of ungranted repository and user paths;
- prevent writes outside projected write locations;
- protect the real checkout and `.git`;
- apply the boundary to descendants;
- terminate the process tree on cancellation;
- return enough environment metadata to identify the enforcement mechanism in
  the proof;
- fail closed when it cannot establish the boundary.

The Linux and macOS drivers may differ internally, but they must pass the same
adversarial conformance suite.

### Result importer

The result importer treats sandbox output as untrusted. It:

- computes the patch from immutable snapshot and result;
- re-evaluates every changed path against the signed grant;
- rejects path traversal, unsafe links, special objects, and metadata-only
  escapes;
- verifies destination fingerprints;
- applies only non-conflicting authorized changes;
- retains a recoverable patch when application cannot proceed.

The importer is the only Safe Agent component allowed to mutate the real working
tree.

### Proof builder and verifier

The proof builder produces a versioned, signed, source-content-free record:

```ts
interface SafeAgentProof {
  readonly version: 1;
  readonly runId: string;
  readonly grantDigest: string;
  readonly grant: SafeAgentGrant;
  readonly command: {
    readonly executableDigest: string;
    readonly preset: 'claude' | 'codex' | null;
    readonly reportedVersion: string | null;
  };
  readonly environment: {
    readonly platform: 'linux' | 'macos';
    readonly driver: string;
    readonly driverVersion: string;
    readonly plannerVersion: string;
    readonly runtimeInputsDigest: string;
    readonly network: 'unrestricted';
  };
  readonly source: {
    readonly gitHead: string;
    readonly dirtySnapshotDigest: string | null;
  };
  readonly result: {
    readonly exit: 'success' | 'failed' | 'cancelled';
    readonly exitCode: number | null;
    readonly changedPaths: readonly ChangedPathProof[];
    readonly disposition: 'kept' | 'published' | 'discarded' | 'preserved';
  };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly signature: string;
}
```

Changed-path proof entries contain repository-relative path, kind, and before
and after digests, not source bytes. Raw stdout, stderr, prompts, credentials,
tool logs, task text, and command arguments are excluded.

The verifier checks:

- grant and proof signatures;
- canonical encoding and domain separation;
- grant digest binding;
- changed paths against write authority;
- source and result field consistency;
- supported proof, planner, and driver versions.

The proof attests to the approved and enforced filesystem boundary and the
authorized resulting patch at the trust level of its issuer. Its signatures and
commit bindings establish integrity, not the truth of an untrusted issuer's
execution claim. It does not establish that an agent never attempted a denied
operation or that unrestricted network access was benign.

### Preset registry

The preset registry supplies the generic engine with:

- executable discovery;
- supported-version diagnostics;
- exact default argument vectors;
- environment variables safe to pass;
- minimal credential and configuration inputs;
- human-readable agent identity.

Claude Code and Codex are the only first-party presets in the first version.
Preset code cannot expand repository permissions after the developer approves
the grant.

## GitHub publishing

### Trusted publication boundary

The sandboxed agent never receives Git or GitHub authority. After the developer
chooses publication, the trusted parent:

1. creates a collision-free `thad/<task-slug>` branch;
2. applies the authorized patch;
3. creates a Git commit;
4. pushes with the developer's existing Git credentials;
5. publishes or stages the signed proof;
6. opens a pull request;
7. attaches the proof summary or verified check.

If any step fails, the command reports the exact durable local state and a retry
command. It never deletes a successfully created local branch, commit, or remote
branch. With the App installed, a proof-ingestion failure may leave a pushed
branch but does not open a pull request.

### Without the GitHub App

`--pr` embeds a compact proof summary in the pull-request body:

- agent and command identity;
- read, write, and deny grant summary;
- changed-path result;
- explicit unrestricted-network warning;
- proof digest and signature;
- App-install link for first-class verification.

The body must distinguish self-contained cryptographic integrity from GitHub App
attestation. It must not label an unverified body as a verified GitHub check.

### With the GitHub App

The App verifies the proof and creates a `Thaddeus / Safe Agent` check on the
exact commit. The summary emphasizes the permission aha:

```text
SAFE AGENT PROOF: VALID

Claude Code was restricted before execution.

Read       src/**, test/**, package.json, bun.lock
Write      src/auth/**, test/auth/**
Denied     .env*, secrets/**, .git/**, .github/**
Changed    3 files, all within authority
Network    unrestricted
Execution  local, operator-attested
Proof      signature and commit binding verified
```

The detail page shows the canonical grant, proof metadata, signatures, changed
path digests, and conversion call to action. It does not expose source content
or raw local logs.

The App must bind the proof to repository identity, source commit, result
commit, and installation before marking the check verified.

### Proof trust levels

A local developer controls the machine, operating system, CLI binary, and
signing identity. The App can verify that the local proof is canonical, signed,
unchanged, internally consistent, and bound to the displayed commits. It cannot
independently prove that the developer ran an official unmodified CLI or that
the local operating system enforced the claimed sandbox. Local checks therefore
say `local, operator-attested`; they do not claim independent remote
attestation.

A hosted run adds a Thaddeus host signature from the configured hosted
attestation key over the operator-approved grant, execution environment, and
result proof. Its check may say `host-attested` and identify the trusted host.
This distinction is part of the proof schema and visible check, not hidden in a
detail page.

## Native-Thaddeus conversion

Safe Agent Mode is useful without migration. After a successful run, it offers:

```text
Safe Agent protected one run.

Make permissions, identity, provenance, and semantic history persistent:
thad migrate
```

`thad migrate` is a separate design and implementation. Safe Agent Mode only
links to it. It must not:

- initialize native repository metadata silently;
- change the Git remote;
- upload source code;
- claim Git history has native signed Thaddeus provenance;
- require ThadHub account creation before a local run.

The local identity created for signed trial grants may be reused after explicit
migration.

## Hosted execution

Hosted Safe Agent Mode is the third delivery project and reuses the local core.
The GitHub App accepts an issue assignment or a command such as:

```text
/thad fix this
```

### Private rollout

Initially, only allowlisted GitHub users and installations may start hosted
runs. Other users receive a waitlist response rather than a degraded execution.

The hosted flow:

1. receives the GitHub issue event;
2. resolves an eligible installation and repository;
3. generates a permission proposal using the shared planner;
4. links to a ThadHub approval page;
5. requires explicit grant approval;
6. runs the task through the shared sandbox contract;
7. adds a Thaddeus host attestation to the execution proof;
8. publishes a PR and host-attested proof through the GitHub App.

Approval occurs on a dedicated page because a GitHub comment is not a safe
interface for reviewing and signing a detailed permission grant. The page signs
the canonical grant with a browser-held Thaddeus device identity bound to the
authenticated GitHub user and installation. Hosted infrastructure does not
approve its own grants on the user's behalf.

Hosted-only layers own runner scheduling, encrypted ephemeral credentials,
quotas, cancellation, billing, log retention, abuse prevention, and operational
telemetry. They cannot redefine the grant or proof schemas.

### General availability

The target is a general hosted launch approximately one month after private
access begins. The date does not override the following gates:

- no confirmed sandbox escape;
- no unauthorized patch application;
- at least 99% of runs leave source state recoverable;
- proof verification consistently binds the intended commits and installation;
- cancellation terminates descendant processes;
- quotas and abuse controls operate correctly;
- users see and understand the unrestricted-network disclosure;
- completed-run cost and support load are commercially acceptable.

## Error handling

### Unsupported or unavailable enforcement

Safe Agent Mode stops before command execution and reports the failed capability
test. It never falls back to ordinary subprocess execution.

Windows reports that Safe Agent Mode is not supported in the first version.

### Command and preset errors

Missing executables, unsupported preset configuration, unreadable required
credentials, or invalid argument vectors fail during preflight. Secrets are not
printed in diagnostics.

### Failed or interrupted execution

On nonzero exit or interruption, the trusted parent:

- terminates the child process tree;
- seals the isolated result against further modification;
- constructs an incomplete proof;
- preserves the result temporarily;
- offers inspect, keep, or discard;
- suppresses automatic publication.

### Concurrent checkout changes

Immediately before application, destination fingerprints are compared with the
starting snapshot. Overlapping changes are not overwritten. The authorized agent
patch is preserved and conflicting paths are reported. Non-overlapping
authorized changes may still be applied.

### Publishing failures

A proof-upload failure does not destroy local work. A failed `--pr` operation
leaves any created local branch and commit intact, does not open an unverifiable
PR automatically, and prints a deterministic retry command.

### Cleanup failures

Run directories are restrictive and uniquely named. Normal completion removes
discarded projections. Preserved or cleanup-failed runs are listed by an
inspection/cleanup surface with their size, age, and disposition. Cleanup never
follows links outside the run directory.

## Security invariants

1. No command executes before a canonical grant is explicitly approved and
   signed.
2. The command and all descendants receive no more repository authority than the
   signed grant.
3. Deny wins over read and write.
4. The real checkout and `.git` are not exposed to the sandboxed process.
5. Git and GitHub credentials remain with the trusted parent.
6. Result import revalidates every changed path against the signed grant.
7. Concurrent developer edits are never overwritten silently.
8. Proofs contain no source content, prompt content, credentials, or raw logs.
9. Network access is labeled unrestricted wherever the filesystem guarantee is
   summarized.
10. Driver or verifier uncertainty fails closed.
11. Local operator-attested and hosted host-attested proofs are visibly
    distinct.

## Adversarial cases

The conformance suite covers at least:

- `..` traversal and absolute paths;
- alternate path separators and Unicode normalization;
- symlinks resolving outside the projection;
- hard links crossing authority boundaries;
- case-folding collisions on macOS;
- child, grandchild, daemonized, and orphaned processes;
- shell invocation and executable replacement;
- rename-based writes across boundaries;
- writes to `.git` through aliases or links;
- Unix sockets, named pipes, device files, and unsupported metadata;
- signals, cancellation, and process-tree termination;
- access through preset configuration paths;
- changes to the real checkout during execution;
- proof/result substitution between runs or commits.

Repository symlinks are never followed into host paths during snapshot creation.
Unsafe output links and unsupported special objects are rejected during import.

## Privacy

- Local stdout and stderr remain local by default.
- Proofs contain metadata and digests, not repository content.
- Published proofs contain task and command-argument digests, not their
  plaintext.
- The developer previews the proof data before GitHub or ThadHub publication.
- Safe Agent Mode does not upload source code during a local-only run.
- Hosted source handling and retention are disclosed before hosted grant
  approval.
- Telemetry is not required to enforce or verify a local grant.

## Testing strategy

### Unit tests

- canonical path and pattern validation;
- deny/write/read precedence;
- write-implies-read behavior;
- deterministic permission suggestions;
- grant signing and verification;
- proof construction and verification;
- proof trust-level and host-attestation verification;
- preset resolution and environment filtering;
- patch authorization and concurrent-change detection.

### Shared sandbox conformance

The same black-box suite runs against Linux and macOS drivers. A fake agent
attempts allowed and denied reads and writes through direct I/O, shells,
descendants, traversal, links, renames, and special files.

Each platform driver must demonstrate:

- allowed reads succeed;
- allowed writes succeed;
- denied reads fail;
- denied writes fail;
- the real checkout stays unchanged during execution;
- descendants remain contained;
- cancellation removes descendant processes.

### Integration tests

- generic command creates an authorized patch and proof;
- Claude Code and Codex preset contracts use fake executables;
- dirty starting state is included or excluded as selected;
- overlapping developer edits preserve a recoverable patch;
- keep and discard have the documented effects;
- `--pr` creates the expected branch, commit, and proof summary against a fake
  remote;
- App verification binds repository and commits before creating a successful
  check;
- local proofs are labeled operator-attested and hosted proofs require a valid
  configured host signature;
- interrupted publication produces a usable retry state.

### Hosted tests

- allowlist rejection and waitlist response;
- grant confirmation before scheduling;
- cancellation and quota enforcement;
- proof parity between local and hosted execution;
- issue-to-PR end-to-end flow against a test installation;
- launch-gate reporting.

## Delivery decomposition

### Project 1: Local Safe Agent Core

Deliver:

- generic command wrapper;
- Claude Code and Codex presets;
- interactive task and permission proposal;
- canonical grant and local signature;
- Git working-tree snapshot and permission projection;
- Linux and macOS drivers;
- keep and discard dispositions;
- proof builder, verifier, and local proof display;
- shared adversarial conformance suite.

Exit criterion: both supported platforms enforce the same read/write contract
against the adversarial fake agent, and local results can be applied without
risking existing checkout changes.

### Project 2: GitHub Aha

Deliver:

- `--pr` disposition;
- trusted branch, commit, push, and pull-request publisher;
- compact proof fallback without the App;
- GitHub App installation and proof-ingestion flow;
- verified `Thaddeus / Safe Agent` check;
- proof detail page and native-Thaddeus call to action.

Exit criterion: an ordinary GitHub repository can receive a PR whose exact
commit carries a verified permission proof without exposing GitHub authority to
the agent.

### Project 3: Hosted Safe Agent

Deliver:

- issue assignment and `/thad` triggers;
- private installation/user allowlist;
- ThadHub permission-approval page;
- hosted runner scheduling, cancellation, quotas, and retention;
- shared-engine execution and App publication;
- guarded general-availability controls.

Exit criterion: selected users can move from a GitHub issue to a protected PR
through the same grant and proof contracts as local execution, and all launch
gates are measurable.

## Success measures

### Local and GitHub

- time from CLI installation to first completed protected run;
- percentage of permission proposals approved without broadening to `**`;
- percentage of runs that produce a kept change or PR;
- percentage of PRs with a verified App check;
- repeat Safe Agent use per repository and developer;
- conversion from a successful proof to native-Thaddeus exploration.

### Hosted

- issue trigger to approved grant;
- approved grant to completed PR;
- cancellation success;
- unauthorized-application and sandbox-escape incidents;
- recoverable-run rate;
- completed-run cost and support load;
- hosted-to-native conversion.

The primary product validation is not raw installation count. It is whether
developers repeatedly choose constrained execution and then explore native
Thaddeus because the permission model was valuable.
