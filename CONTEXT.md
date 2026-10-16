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
