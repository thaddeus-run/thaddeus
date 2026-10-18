# Semantic authority and mixed-edit transactions

Status: decided by [THA-113](https://linear.app/thaddeus-run/issue/THA-113),
mirrored on GitHub as
[#169](https://github.com/thaddeus-run/thaddeus/issues/169), on 2026-10-18.
[ADR 0005](../adr/0005-content-journal-is-the-semantic-authority.md) is the
short form. Shipped behaviour is described in the present tense. Everything else
is direction, and none of it is implemented.

Section 4 of the
[architecture contract](../agent-first-architecture.md#4-semantic-editing-is-an-early-delivery-requirement)
puts structured editing in the first useful release and leaves this issue to
decide what is authoritative. This document makes that call. It then sets the
rules that THA-36, THA-145 and THA-115 build on: how one transaction mixes file
edits and structured edits, how content survives without loss, how a symbol
keeps its identity, which preconditions stop a stale graph from authorizing an
edit, what a checkpoint binds, and how a transaction rolls back.

## 1. The decision in brief

- Immutable file content plus an append-only change journal per workspace is the
  authority. The symbol graph is a projection that the service can rebuild from
  the journal.
- A transaction is all or nothing and commits as one journal entry. The entry
  records the base revision, every file edit and structured edit in order, the
  byte edits each structured edit produced, and the resulting content. Intent
  and content are never recorded apart.
- Bytes nobody asked to change stay byte-identical. The service checks this on
  every structured edit.
- A symbol keeps its identity across a rename or move only when an edit declares
  it. Identity never follows a guess.
- A structured edit runs only against a graph built for the exact state it
  commits on, and fails closed when that graph is missing, partial or ambiguous.
- TypeScript and JavaScript are the proposed first language family. Nothing
  implements them yet.

## 2. What ships today

`@thaddeus.run/graph` is the pillar 08 spike described in the
[semantic graph design](2026-07-07-thaddeus-pillar-08-semantic-graph-design.md).
Its `HeuristicExtractor` finds `fn <name>(` definitions and `<name>(` calls with
regular expressions. `SymbolGraph.rename` rewrites whole-word matches in every
file that holds the definition or a resolved reference, commits them through
`Workspace.write` and `Workspace.commit`, and only afterwards signs a
`SymbolOp { symbol, from, to, base, author }`. That record names no revision,
operation or content, so nothing ties the rename to the text it describes.
`Workspace.commit` signs one operation per path and keeps the paths that
succeeded when a later one throws. A symbol id is `blake3(path, name, kind)` at
first sight, held in an in-process `SymbolLedger`. A reader keeps ids stable
across renames only if it replays the `SymbolOp` records first, and not every
reader does.

On 2026-10-18 the compiled 0.1.11-alpha CLI, built from `8724400`, ran against a
local server with an owner and a second identity in separate home directories.
The repository held one file:

```rust
// refresh() rotates the session token; keep refresh cheap.
fn refresh() {
    log("refresh called");
}

fn login() {
    refresh();
}
```

| Step | Action                                                                  | Observed                                                                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Owner runs `thaddeus rename refresh refreshToken -m "clearer name"`.    | Exit 0 with `renamed refresh → refreshToken (symbol 703415ab16, 1 edit(s), 1 symbol op)`. Both mentions in the comment and the string literal `"refresh called"` were rewritten as well.                                                                                 |
| 2    | Owner grants the guest. Guest clones and runs `history refreshToken`.   | `refresh → refreshToken [verified]`, signed by the owner's DID.                                                                                                                                                                                                          |
| 3    | Server stopped. Owner runs `rename login signIn`.                       | Exit 1 with `could not read the repo's members (Unable to connect. …) … nothing was uploaded, please retry`. The file on disk already said `signIn`, the owner's `history signIn` showed a verified rename, and `status` reported one unpublished commit.                |
| 4    | Server restarted. Owner retries the rename, then runs `push`.           | The retry fails with `no symbol named login`. `push` publishes the renamed text. After `pull`, the guest has `signIn`, but `history signIn` prints `no rename history for signIn` for the guest and for a fresh clone. Only the owner's machine holds the rename record. |
| 5    | Owner runs `query references refreshToken --json` in the same checkout. | Symbol `e92bd1a604…`, where `rename` had reported `703415ab16`. `query` builds its graph without replaying `SymbolOp` records (`packages/cli/src/query.ts`), so two commands give one symbol two ids.                                                                    |
| 6    | Owner changes `refreshToken` to `rotateToken` with `sed`, then pushes.  | `query references rotateToken` reports a new id, `39d0e1466f…`, and `history rotateToken` is empty. The old identity ended and nothing records that it did.                                                                                                              |
| 7    | Server restarted again. Guest clones.                                   | Same text and the same missing histories. Durable state survived the restart, including the gap from step 4.                                                                                                                                                             |

Step 4 is the failure this decision has to rule out. One attempt left the intent
and the content in different places, and no command could bring them back
together. Step 6 is ordinary external editing that the model must represent
honestly. Step 1 shows a rename changing comments and strings that are not
references.

## 3. The candidates

### 3.1 Graph-authoritative

The symbol graph, or a syntax tree under it, is the stored state, and files are
printed from it. Unison works this way. It stores definitions as
content-addressed syntax trees and keeps names as metadata, so a rename never
touches a definition. That works because Unison owns the language and the
codebase format. For Thaddeus it would mean:

- Lossless storage needs a concrete syntax tree that keeps every comment, blank
  line and byte of whitespace, plus a printer that reproduces the original bytes
  exactly. A printer bug then changes code nobody edited.
- Files outside the supported languages still need byte storage. That covers
  Markdown, JSON, lockfiles, images and every other language, so the repository
  ends up with two authorities.
- A file that does not parse cannot be stored as a graph. Agents save
  half-written files constantly, so autosave would either wait for the parser or
  store error nodes.
- A parser upgrade or a parser bug changes the stored state of every repository.
- External agents write text. Every save would be parsed into graph changes
  before it became durable, which puts a full parser in front of every save
  under the 1,000-agent design target.
- Shipped operations sign content references (`Op.payload`). A graph authority
  gives those signatures a new meaning, which rule 2 of the
  [migration contract](../agent-first-architecture.md#8-migration-contract-for-existing-encrypted-repositories)
  forbids.

In return, identity comes for free because a node is the symbol, and no separate
index can fall behind the state.

### 3.2 Content journal

File bytes are the state. Each workspace has an append-only journal, and each
entry records the structured intent behind a change in the same atomic record as
the exact content that resulted. The symbol graph is derived from the journal,
and the service can discard and rebuild it. Jujutsu's operation log is the
nearest precedent. It records every operation with the repository view that
resulted, and undo adds an operation instead of rewriting one.

The cost is that identity has to be defined by rules rather than inherited from
storage. A derived graph can also lag behind the content, so every structured
edit needs preconditions that keep a lagging graph from acting.

### 3.3 Comparison

| Concern                             | Graph-authoritative                             | Content journal                                                                   |
| ----------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| Comments, formatting, exact bytes   | Needs a lossless tree and a byte-exact printer. | Bytes are the state. Edits declare byte ranges and the rest is checked unchanged. |
| Arbitrary files and other languages | Needs a second store for bytes.                 | Ordinary files.                                                                   |
| Files that do not parse             | Cannot be saved as a graph.                     | Saved as bytes and marked unanalyzed.                                             |
| Parser upgrades and parser bugs     | Change stored state.                            | Change a projection that can be rebuilt.                                          |
| External agents, local folders, Git | Every save is parsed into graph changes.        | Native.                                                                           |
| Shipped signatures                  | Change meaning.                                 | Keep their meaning.                                                               |
| Stable identity                     | Built in.                                       | Needs the rules in section 6.                                                     |
| Stale index                         | Nothing to fall behind.                         | Needs the preconditions in section 7.                                             |
| Structural merge                    | Natural over trees.                             | Text merge plus replay of declared intent, owned by THA-12 and THA-155.           |
| Parser and saves                    | Runs before a save is durable.                  | Analyzes every entry after it is acknowledged. Only structured edits wait for it. |

The graph model wins on identity and merging and loses everywhere bytes matter
that no parser owns. Thaddeus serves external agents that write text, in
repositories that mix languages, with files that are broken half the time. The
bytes have to be the authority.

## 4. Transactions and the journal

### 4.1 Revisions and content

A revision is the exact state of every path in a workspace: its kind (file or
symbolic link), its executable bit and its content, where a symbolic link's
content is its target. A revision is named by a hash of those sorted entries, so
two workspaces holding the same files have the same revision, whatever produced
them.

The journal names content by a hash of its plaintext. Stored objects today are
named by their ciphertext, and every encryption uses a fresh nonce, so the same
bytes stored twice get two object ids. The shipped `Ref` already carries a
`plaintext_id` for this reason.

### 4.2 Journal entries

Every change to a workspace is a transaction, and each committed transaction is
exactly one journal entry. An autosave batch from THA-153 is a transaction like
any other. The shape below is a proposal that THA-153 and THA-145 may refine
without changing the rules in this document.

```text
JournalEntry {
  workspace   workspace id
  seq         1, 2, 3, … with no gaps
  previous    id of entry seq - 1, or null
  observed    entry whose state the caller's expectations were computed against
  base        revision the steps applied to, the result of entry seq - 1
  result      revision after the transaction
  changes     [{ path, before: file state | null, after: file state | null }]
  steps       [FileEdit | StructuredEdit], in the order they applied
  reverts     entry id, when this entry reverts another
  restores    checkpoint, when this entry resets the workspace to one
  analyzer    { family, version } when any step is structured, otherwise null
  retry       the client's retry id
  actor       the submitting session and its declared actor kind (ADR 0001)
  signature   the actor's signature over the canonical entry, when the actor signs
  id          hash of the canonical entry
}

FileEdit =
  | { kind: 'write',  path, file state, expect?: content hash | null }
  | { kind: 'delete', path, expect?: content hash }
  | { kind: 'move',   from, to, expect?: content hash }   fails if `to` exists

StructuredEdit {
  kind       'rename-symbol' | 'edit-function'   (first release)
  target     symbol id, or a locator for a symbol born earlier in this transaction
  expect     { locator, declaration?: hash of the whole declaration, body included }
  args       rename:   { to: name, generated?: [{ path, content hash }] }
             function: { part: 'body' | 'declaration', text }
  edits      [{ path, start, end, text }]        byte edits this step produced
  identity   [{ symbol, from: locator, to: locator }]   changes it declares
}
```

One record binds intent to content. `steps` say what the actor asked for,
`edits` say which bytes each structured step changed, and `changes` and `result`
say what the workspace holds afterwards. A verifier with no parser can apply the
file edits and byte edits to `base` in order and check that the outcome hashes
to `result`. The parser is needed only to judge whether those byte edits were
the right ones, and `analyzer` names the version that made that judgement.

Edit offsets are byte offsets into the stored file. The TypeScript language
service reports UTF-16 offsets, and the language adapter converts them.

The service records who submitted each entry. Whether an agent signs entries
itself, or the service records them for a session, is for
[THA-150](https://linear.app/thaddeus-run/issue/THA-150) to decide. Either way,
a service-recorded entry is never presented as the agent's signature, as
[ADR 0003](../adr/0003-trusted-code-processing-service.md) requires.

An entry carries content for every path it changes, so reading an entry needs
read authority over those paths. A reader whose authority covers only some paths
sees only the parts of an entry that concern them.

### 4.3 Mixed edits

A transaction may hold any mix of file edits and structured edits. Steps apply
in order, and each step sees the content that earlier steps produced. Before a
structured step runs, the service brings the graph up to date with that content.
For a type-aware analyzer that can mean re-checking files that depend on the
changed ones, not only the changed files. A transaction that writes
`src/session.ts`, renames `refresh` everywhere including in that new file, and
replaces the body of `login` is one entry. Readers see all of it or none of it.

A structured step targets a symbol that exists before the transaction by its
symbol id, and earlier steps that declare identity changes keep that id pointing
at the right locator. A symbol born earlier in the same transaction has no id
until the entry exists, so a step targets it by locator. A step's expectations
describe the state immediately before that step. When any step cannot apply, the
whole transaction fails.

### 4.4 Commit, failure and rollback

One service instance owns a workspace at a time through a lease, and it appends
that workspace's entries one at a time, in arrival order. A structured edit is
prepared outside that order: the service analyzes and computes it against the
head it started from, then takes its turn only to re-check its preconditions at
the current head and append. Autosaves therefore do not wait while a rename is
computed. If the head moved during preparation, the service re-checks, and after
a bounded number of failed attempts it holds the workspace's turn for one final
attempt, so a rename cannot be starved. Each transaction commits in this order:

1. Look up the retry id. If an entry already carries it, return that entry. The
   transaction committed earlier, whether or not the client heard back.
2. Read the workspace's current journal head.
3. Check every step's preconditions (section 7) and compute the resulting
   content.
4. Write the new content objects. Nothing refers to them before step 5.
5. Append the entry with a conditional write that succeeds only if the head is
   unchanged and no entry carries the retry id. This is the only commit point.
6. Acknowledge the client once the append is durable.

There is no partial write. A failure or crash before step 5 leaves the workspace
as it was, plus objects nothing refers to. Collection
([THA-157](https://linear.app/thaddeus-run/issue/THA-157)) removes those, but
never an object younger than a fixed bound, and a transaction still short of
step 5 when that bound runs out aborts instead of appending. The conditional
write in step 5 protects against an instance that lost its lease without
noticing. If it fails, the service starts again from step 1. Because the retry
id is part of that condition, a retry sent while the original is still in flight
cannot commit twice either. After a restart the workspace is at its last durable
entry, and any in-flight transaction either has an entry or never happened.

Step 5 needs conditional writes from the storage backend, which
[THA-15](https://linear.app/thaddeus-run/issue/THA-15) defines. Until that
lands, a journal would be correct only on a single node, like the rest of the
shipped server.

Rollback never rewrites the journal. Both kinds of rollback below are entries
whose identity changes count as declared (section 6, rule 2).

- Reverting entry N appends an entry that names N in `reverts`. Its file edits
  are a three-way revert of N's file edits against the head, which may conflict.
  Its structured steps are fresh inverses, computed and checked at the head like
  any other structured edit. Reverting the rename `refresh → refreshToken`
  renames the same symbol id back to `refresh`, so a call to `refreshToken`
  added after N is renamed back as well. A revert also declares that symbols N
  ended continue under their old ids wherever it restores their locators. A
  rename that carried generated content (section 5) can be reverted only when
  the revert supplies the regenerated content again, otherwise it fails with
  `GeneratedReference`.
- Resetting a workspace to a checkpoint appends an entry whose result is the
  checkpoint's revision and that names the checkpoint in `restores`. It declares
  the checkpoint's identity map as the new map. Ids that ended after the
  checkpoint come back, and symbols born after it end.

Positions in the journal never change meaning, so the journal stays a complete
audit trail and retries stay safe. Retention (THA-157) may drop old entries only
while everything the rules here read stays available:

- the revision and full identity state at the oldest entry it keeps, including
  the last analyzed state and unverified flags of rule 7 in section 6;
- retry ids for as long as clients may retry, after which a retry is refused
  rather than committed;
- every entry a live checkpoint names, and every entry between such a checkpoint
  and its workspace base;
- on a shared branch, the declared identity changes back to the oldest base of
  any live workspace, which integration and base updates carry identity through.

An entry that retention dropped cannot be reverted. Resetting to a checkpoint
still works.

## 5. Lossless handling

Bytes the caller did not ask to change stay byte-identical. For every structured
edit the service compares everything outside the declared byte edits with the
base content, so a bug in a language adapter fails the transaction instead of
changing code nobody edited.

**Comments and formatting.** A structured edit changes the smallest byte ranges
it needs and never runs a formatter. Line endings, a byte-order mark, tabs,
trailing whitespace and comments outside those ranges stay as they were. A
rename changes the identifier tokens the analyzer resolves to the symbol, plus
any syntax the rename needs, such as turning the shorthand property
`{ refresh }` into `{ refresh: refreshToken }`. It does not rewrite comments or
strings that mention the old name, unlike step 1 in section 2. The graph reports
those mentions, and the caller can change them with a file edit. A formatter run
is a separate file edit, which may be a step in the same transaction.

**Arbitrary files.** Markdown, JSON, YAML, lockfiles, images and other binary
files are content like any other. They take file edits only, and the first
release does not analyze them. A file that is not valid UTF-8 is never analyzed.
Revisions keep symbolic links and the executable bit, so files imported from Git
keep both.

**Unsupported syntax.** Each of these cases is reported, never guessed:

1. A file in a language outside the supported family is plain content. The graph
   lists it as unsupported.
2. A file in the supported family is unanalyzed at a revision when the analyzer
   reports any syntax error for it. That covers a half-written file, syntax
   newer than the analyzer, and dialects such as Flow. The TypeScript parser
   recovers from every syntax error, so "does not parse" would mean nothing;
   "has a syntax diagnostic" is the test. Type errors do not make a file
   unanalyzed. The graph keeps the diagnostics, the file's symbols keep their
   ids (section 6, rule 7), and a structured edit that needs to read or write
   the file fails with `IncompleteGraph`. Saving the file always works for a
   caller with path authority over it. A caller whose only authority there is
   symbol-scoped cannot save it while it is unanalyzed, because nothing can show
   which symbols the save touched.
3. Code that parses but cannot be resolved statically produces ambiguous
   references. Examples are `obj[name]`, `eval`, `with` and a `require` with a
   computed path. A rename whose target has an ambiguous reference fails with
   `AmbiguousReference`.

**Generated code.** A file counts as generated when a checked-in repository rule
matches its path, when its header carries a generated marker such as
`@generated` or Go's `Code generated … DO NOT EDIT.`, or when `.gitattributes`
marks it `linguist-generated`. Generated files are content, and file edits may
write them, which is how regenerated output is saved. The graph indexes them, so
references from generated code count, but the service never computes edits
inside them. A rename that reaches a generated file must carry that file's new
content in `generated`, normally the generator's output after the caller renamed
the generator's input. The service writes those bytes unchanged, renames
everything else, and accepts the step only if every former reference, generated
or not, then resolves to the renamed symbol. Those bytes are a file write in all
but name. The byte-preservation check does not cover them, and the caller needs
path authority to write each of those files, as for any file edit. Without that
content the rename fails with `GeneratedReference` and names the files. Running
a generator inside the service needs execution workers and is out of scope here.

**External file edits.** Agents writing through the remote workspace API, local
folders folded in by the CLI, Git imports, and formatters or generators run by
execution workers all produce file edits without structured intent. They are
transactions like any other, and identity follows section 6. A symbol whose
locator survives keeps its id, a new locator starts a new identity, and a symbol
that disappears ends. A hand rename like step 6 in section 2 therefore ends one
identity and starts another, and the journal says exactly that instead of
inventing a rename nobody declared. The graph may point out a likely
continuation, for example one function ending and another with an identical body
starting in the same entry. That hint never carries identity, authority, review
state or subscriptions.

## 6. Stable symbol identity

A symbol has two names.

- A locator addresses it at one revision: the file path, the enclosing
  declarations, the name and the kind. `src/auth.ts#AuthService.refresh` as a
  method is one example. Renames and moves change it.
- A symbol id stays with it across declared renames and moves. It is minted once
  and never derived from the current name.

In the first release, identity covers declarations reachable by a qualified name
from module scope: top-level declarations, class and interface members, enum
members and namespace members. When the analyzer merges declarations into one
symbol, for example overloads, a `const` and a `type` sharing a name, or an
interface declared in two files, the symbol has one id and one locator per
declaration. Local variables and parameters have no id, so renaming one is a
file edit for now. When two declarations produce the same locator without
merging, such as a duplicated `function a() {}` in a script, the locator is
ambiguous. It gets no id, and structured edits refuse it.

Identity belongs to a position in a journal, not to a revision. Two workspaces
can hold the same revision with different ids, and one workspace can return to
an earlier revision after a symbol ended. The structural part of the graph
(locators, references, imports) is keyed by revision and analyzer version and
can be shared between workspaces. The identity map is keyed by journal entry.

For each entry, the service derives the identity map with these rules, in this
order:

1. Start from the identity map after the previous entry.
2. Apply the identity changes the entry declares, in step order. Structured
   steps declare them, a file `move` carries every symbol in the moved file, and
   revert and reset entries declare theirs as section 4.4 describes. A rename of
   a container carries its members. A locator or id involved in a declared
   change is settled by it, and rules 3 to 6 leave it alone for this entry.
   Swapping two names is two declared renames and works.
3. A locator present both before and after the entry keeps its id. When a merged
   symbol splits into separate symbols, for example because one of two interface
   declarations gains an `export`, the merged id ends and each part gets a new
   id, because nothing says which part continues it.
4. A symbol whose declarations all disappear without a declared change ends.
   Cutting a function in one save and pasting it back in a later one therefore
   ends its identity and starts another. Doing both in one transaction keeps it.
5. An ended id is never given to a different symbol. Only a revert or a reset
   that restores an earlier state brings one back (section 4.4).
6. Any other new locator gets a new id, `hash(domain tag, entry id, locator)`.
   Because the entry id is part of it, a symbol that ended and was later written
   again under the same name is a new symbol. The shipped
   `blake3(path, name, kind)` cannot make that distinction.
7. While a file is unanalyzed, its symbols keep their last known locators and
   ids, flagged as unverified. When the file analyzes again, rules 3 to 6 run
   against its last analyzed state. Autosaving a half-typed file therefore does
   not end and restart every symbol in it.

Locators come from the syntax of the repository's own files, so identity depends
only on journal entries and the analyzer version. Any service instance that
rebuilds after a restart computes the same ids. References and rename locations
also depend on what the analyzer reads from outside the revision, such as
installed dependency type declarations. Those inputs belong to the revision,
derived for example from its lockfile, and not to the analyzer version, so
editing a lockfile is an ordinary entry rather than an analyzer migration.
THA-36 decides how they are installed reproducibly.

A repository uses one analyzer version at a time. Changing it is an explicit
migration that recomputes identity from the journal and records a mapping from
each old id to a new id or to "ended". Declared identity changes name the symbol
id as well as its locators, so a declared rename survives the migration even if
the new analyzer writes locators differently. A declared change whose locators
the new analyzer cannot find is listed in the mapping as unresolved. Grants,
review artifacts and subscriptions keyed by an old id either carry over or end
visibly.

Workspaces keep separate journals, so a symbol born in workspace A is unknown to
workspace B until A's checkpoint is integrated. An integrated revision has two
parents, the shared head and the checkpoint, and a common base. Integration
carries each parent's identity map through the identity changes that the other
parent declared since the common base, then merges the two maps. Carrying
applies the part of the locator a change declared, the name, the enclosing
declarations or the path, to wherever the symbol sits on the other side. Suppose
workspace A renamed class `Auth` to `Session`, and workspace C added
`Auth.logout`. Carrying C's map through A's rename gives `Session.logout` the id
C minted. If A instead renamed `foo` to `bar` in `a.ts` while C moved `a.ts` to
`c.ts`, the result is `c.ts#bar` under `foo`'s id. Symbols born inside the
checkpoint keep the ids they had there, so grants, reviews and subscriptions
that refer to them still apply. When one locator ends up with two ids, for
example because both sides added the same function, integration reports an
identity conflict. The integrator resolves it with a declared choice that the
integration record keeps. A base update at a safe boundary
([THA-11](https://linear.app/thaddeus-run/issue/THA-11)) uses the same carrying
step. A declared change that no longer applies, such as renaming a symbol the
new base deleted, is a base-update conflict. THA-12 and THA-155 own the
mechanics.

## 7. Stale-graph preconditions

Every graph answer carries the revision and journal entry it describes, the
analyzer version, and its coverage: the files that were unsupported, unanalyzed,
excluded or generated. A caller always knows how old and how complete its view
is.

Every structured edit counts as destructive here, because the graph decides
which bytes it overwrites. The caller sends what it saw: the observed entry, the
target, the expected locator and, for `edit-function`, a hash of the whole
declaration, body included. The service then:

1. Brings the graph up to date with the workspace's current head under the
   repository's analyzer version, or fails with `GraphUnavailable`. It never
   computes an edit from a graph that lags the head.
2. Checks the caller's expectations at the head, or for a later step of a mixed
   transaction, at the state just before that step. When the observed entry is
   older than the head but the locator and declaration hash are unchanged, the
   edit proceeds at the head, and a rename picks up references added since. The
   entry records both `observed` and `base`. When either expectation changed,
   the edit fails with `StalePrecondition`, which names what the caller expected
   and what the head holds. A concurrent edit to a function's body changes the
   declaration hash, so an `edit-function` never silently overwrites it.
3. Checks coverage. A supported file is a file in the supported family that
   belongs to a discovered project, minus paths that a checked-in repository
   rule excludes from analysis, such as fixtures that are invalid on purpose. A
   rename needs every supported file that could import the symbol to be
   analyzed. Until THA-36 can prove which files those are, that means every
   supported file in the workspace, so one unanalyzed file blocks a rename with
   `IncompleteGraph`. The caller can repair it in an earlier step of the same
   transaction. An `edit-function` needs the declaring file to analyze before
   and after the edit.
4. Rejects a rename that reaches a generated file without its content
   (`GeneratedReference`), a rename whose target has an ambiguous reference
   (`AmbiguousReference`), and a new name that collides with an existing name in
   scope (`NameConflict`).
5. Re-analyzes the result. After a rename, every former reference must resolve
   to the renamed symbol and nothing else may newly resolve to it, otherwise a
   reference was captured or shadowed and the step fails with `NameConflict`.
   After an `edit-function`, the symbol's locator must be unchanged, otherwise
   the step fails with `LocatorChanged`, because a rename has to be declared as
   one. Neither step may add a syntax error.
6. Commits through the conditional append in section 4.4. If the head moved
   first, these checks run again against the new head.

The caller's graph never authorizes anything. It only states expectations, and
the service checks them against a graph built for the exact state the entry
commits on. File edits may carry an expectation too, the content hash the caller
last read. Shared workspaces require one on every file edit, so the last writer
never silently wins, as section 3 of the contract asks.

References from outside the repository stay invisible. A consumer of a published
package is one example. Renaming an exported symbol remains the caller's
judgement.

## 8. Checkpoint binding

A checkpoint names one journal entry:
`{ name, workspace, entry id, seq, revision, workspace base, analyzer version, creator }`.
Its `revision` must equal that entry's `result`, and its identity map is the map
after that entry. Symbols in files that are unanalyzed at that entry appear in
the checkpoint marked unverified (section 6, rule 7), and review shows them that
way. Creating a checkpoint first flushes pending autosave batches
([THA-153](https://linear.app/thaddeus-run/issue/THA-153)), so it covers every
acknowledged save. A checkpoint is immutable. Later entries never change what it
names.

Review, execution and integration take a checkpoint, never "the workspace as it
is now". The semantic diff for a checkpoint
([THA-37](https://linear.app/thaddeus-run/issue/THA-37)) is computed from the
workspace base, the checkpoint's entry and revision, and the analyzer version,
and it carries all of them. Review shows it next to the structured steps
declared in the entries between base and checkpoint, so a reviewer sees intent
and concrete diff together. A reader with read authority over every path a
checkpoint changed can verify it by replaying the recorded edits from the base
and comparing the revision hash.

## 9. First language family: TypeScript and JavaScript (proposed)

This decision recommends TypeScript and JavaScript as the first language family.
That covers `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` and
hand-written `.d.ts` files, with projects found through `tsconfig.json` and
`jsconfig.json`. Nothing implements it. The shipped extractor is the
regular-expression spike for Rust-like `fn` fixtures. The recommendation is
approved only as part of this decision, and
[THA-36](https://linear.app/thaddeus-run/issue/THA-36) may overturn it with
measurements.

Two reasons support it. Thaddeus is itself a TypeScript monorepo, so the first
adapter is tested on code the team reads every day. And the TypeScript language
service already computes cross-file, type-aware rename locations, the same ones
editors use, which gives the adapter a reference to test against.

THA-36 decides what this leaves open:

- Which analyzer runs in production. The TypeScript language service resolves
  names through types but holds a whole program in memory. Parsers that resolve
  names only within one file are lighter, but cannot rename a property reached
  through a type.
- How the analyzer's inputs from outside the revision are pinned, such as
  installed dependency type declarations.
- How workspaces over the same base share analysis, so that the 1,000-agent
  design target does not mean 1,000 full programs in memory. Structural results
  keyed by revision and analyzer version fit the versioned derived caches of
  [THA-70](https://linear.app/thaddeus-run/issue/THA-70).
- Memory and latency targets, which THA-117 sets.

## 10. Relation to shipped records

Shipped `Op`, `Provenance` and `SymbolOp` records keep their meaning, as the
migration contract requires. A `SymbolOp` remains valid evidence that its signer
asked for a rename, and it never turns into a journal entry by reinterpretation.

Of the pillar 08 decisions, decision 2 stands: the graph is a projection of
text, now bound to a revision, a journal entry and an analyzer version. Section
4 replaces decision 4, a separately signed `SymbolOp` that the text operations
render. Section 6 replaces decision 3, the ledger keyed by birth path and name.
Decision 5's extractor seam becomes the per-family analyzer adapter. Section 7
replaces decision 6's `from` check. These replacements apply to new work. The
spike keeps running as it does until its replacement ships.

The CLI keeps today's behaviour until
[THA-145](https://linear.app/thaddeus-run/issue/THA-145) moves `rename` onto
transactions. THA-145 decides whether the local-folder path writes journal
entries itself or submits each transaction to the remote as one unit. Either
way, step 4 in section 2 must become impossible.

## 11. Consequences for the build queue

| Order    | Issue           | What this decision gives it                                                                                                                      |
| -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 007      | THA-150         | The question of who signs journal entries.                                                                                                       |
| 018      | THA-15          | The conditional write the journal append depends on.                                                                                             |
| 026      | THA-153         | Autosave batches are transactions. Retry ids and sequence numbers live in journal entries, and a checkpoint names an entry.                      |
| 029      | THA-36          | The proposed TypeScript and JavaScript adapter, the identity rules in section 6 and coverage reporting.                                          |
| 030      | THA-42          | Every query and subscription result carries its revision, journal entry, analyzer version and coverage.                                          |
| 031      | THA-145         | `rename-symbol` and `edit-function` as structured steps with the preconditions in section 7. The CLI rename moves onto transactions.             |
| 032      | THA-37          | A semantic diff between checkpoint revisions, shown with the declared intent.                                                                    |
| 033      | THA-115         | Grants name symbol ids. Enforcement uses the graph at the entry's base, fails closed for unanalyzed files and never follows a continuation hint. |
| 047, 051 | THA-12, THA-155 | Integration carries identity through each side's declared changes, and identity conflicts are explicit.                                          |
| 057      | THA-157         | Collection that spares in-flight objects, and retention that keeps what identity rebuilding and live checkpoints need.                           |

## 12. Open questions

None of these blocks the decision, and each has an owner.

1. Whether a rename may proceed when an unanalyzed file provably cannot import
   the symbol's module. The rule in section 7 blocks it today. THA-145.
2. Whether an actor may declare after a hand rename that a new symbol continues
   an ended one. Such a step would need edit authority over both symbols.
   THA-145 and THA-115.
3. How integration records and identity conflicts are encoded on shared
   branches. THA-67 and THA-155.

## 13. Verification

The baseline in section 2 exercised the shipped path: the real CLI and server, a
failure with the server down and recovery after a restart, and a second identity
reading the result. Those steps, plus scenarios the rules above were checked
against on paper, become acceptance checks for the issues that build this
decision:

- A transaction interrupted by an unreachable service or a crash leaves no
  visible change, and its retry commits exactly one entry, including when the
  first attempt committed but its response was lost. THA-153 and THA-145.
- A second identity reading a renamed symbol sees the same id and the same
  declared rename as its author. THA-36 and THA-145.
- Every read command reports the same id for the same symbol at the same journal
  entry. THA-36 and THA-42.
- A rename leaves comments and strings unchanged and reports them as mentions.
  THA-145.
- A hand rename ends one identity and starts another, and the journal shows
  both. A half-typed file saved by autosave keeps its symbols' ids. THA-36.
- Reverting a rename after a later entry added a call to the new name renames
  that call back too. THA-145.
- Integrating a class rename with a concurrent member addition keeps the
  member's id. THA-155.

The new model is not implemented, so nothing in sections 4 to 9 has been
observed running.
