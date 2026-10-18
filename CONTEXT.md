# Thaddeus

Thaddeus governs how signed changes enter shared source history. These terms
distinguish proposed changes from accepted history and define what delegation
limits count.

## Language

**Operation**: A signed file-change record attributed to an author. One
publication attempt can contain several operations. _Avoid_: Commit or push when
counting individual changes.

**Upload**: Transfer of proposed operations and their associated content to a
remote. Uploading does not establish that the proposal belongs to accepted
history. _Avoid_: Landing, acceptance.

**Landing**: Acceptance of proposed operations into a shared branch under its
authorization and policy rules. _Avoid_: Upload.

**Operation budget**: A lifetime ceiling on how many of a delegated author's
operations may be accepted through landing within a repository. Uploaded
operations that have not landed and rejected landing attempts do not consume
this budget. _Avoid_: Push budget, monetary budget.

**Actor**: The identity signing an explanation of a change. Its signature binds
the explanation to that identity. _Avoid_: Operator when referring to the
signer.

**Operation author**: The identity that signed a file-change operation. An
explanation of that operation can have a different signer. _Avoid_: Actor when
the distinction between change authorship and explanation authorship matters.

**Provenance claim**: A signed explanation referring to an operation. Several
claims can refer to the same operation, and valid signatures do not establish
agreement between their explanations. _Avoid_: Definitive reason, superseding
explanation without an explicit supersession relationship.

**Actor kind**: The actor's signed declaration of what kind of participant it
is. The declaration alone establishes neither agent behavior nor permission to
write, land, or review. _Avoid_: Verified agent identity, authorization role.

**Reviewer authority**: Permission to submit a veto over changes within a
defined review scope. It is separate from access to the proposed content and
permission to upload changes. _Avoid_: Write delegation, read access.

**Release version**: The shared version identifying the first-party packages and
binaries shipped together as one Thaddeus release. The release tag names that
same version. _Avoid_: Independent package version for members of the shared
release.

**Workspace**: An isolated view over a shared repository that points at an
immutable base revision and holds only its own changes. Workspaces are separate
unless explicitly shared. _Avoid_: Branch, for the place an agent edits; clone,
which implies a second object store.

**Checkpoint**: A named, durable binding of a workspace's exact revision to the
change journal entry that produced it, used for review, execution and
integration. _Avoid_: Commit, before the record is proposed for landing;
autosave, which is unnamed.

**Revision**: The exact content of every path in a workspace at one point,
identified by that content alone. _Avoid_: Snapshot, commit, version.

**Change journal**: A workspace's append-only record of committed transactions.
Each entry names the revision it started from and the revision it produced.
_Avoid_: Operation log, which names the shipped signed operation history.

**Transaction**: One all-or-nothing change to a workspace that may mix file
edits and structured edits. It commits as one change journal entry together with
the content it produced. _Avoid_: Commit, operation.

**File edit**: A change that writes, deletes or moves a path using exact bytes
the caller supplies. _Avoid_: Text operation.

**Structured edit**: A change that targets a symbol rather than a path, such as
a rename or a function edit. The content it produced, not its intent, is what
the workspace holds. _Avoid_: SymbolOp, which names the shipped rename record;
refactor.

**Symbol graph**: The symbols, references and imports that one analyzer version
derives from one revision, with symbol ids taken from the change journal. It can
always be rebuilt and never decides what the content is. _Avoid_: Semantic index
or semantic model, when either suggests a separate authority.

**Analyzer**: The versioned parser and name resolver for one language family
that builds the symbol graph. _Avoid_: Extractor, which names the shipped
regular-expression spike.

**Symbol id**: The identifier that stays with a symbol across renames and moves
that edits declare. It is minted once and never derived from the symbol's
current name. _Avoid_: Symbol name, locator.

**Locator**: A symbol's address at one revision: its file, enclosing
declarations, name and kind. _Avoid_: Symbol id, which survives renames.

**Trusted service**: A Thaddeus-hosted or customer-hosted service authorized to
read repository plaintext for scoped requests while keeping storage encrypted
and access audited. _Avoid_: Untrusted remote or mirror, which name the shipped
keyless server; host-blind, which no longer describes the hosted path.

**Performance target**: A number a build is held to, as distinct from a
measurement, which names the environment and the run that observed it. _Avoid_:
Capability, result or benchmark when no run is linked.
