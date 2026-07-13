# Signed, monotonic view heads

**Issue:** THA-20

**Date:** 2026-07-13

## Threat and solution

Operations in Thaddeus were already signed, but the server's statement that a
shared view pointed at particular operations was not. A malicious or broken
server could therefore return an older view, give two clients conflicting views,
or advertise a head while withholding one of its required operations. Valid
operation signatures alone could not detect those attacks.

Every shared view now has an append-only sequence of repository-owner-signed
head records. A record binds the repository, view, monotonically increasing
version, previous record, accumulated operation heads, and owner. Clients retain
every accepted record and require a remote history to extend that exact prefix.
They also require a pull bundle to contain exactly the current signed heads'
reachable operation closure.

Local/private workspace and inspection views remain ordinary pointers. The
signed sequence is authority for public shared views; it is not a promise that a
local working view has no unpublished operations.

## Record and canonical form

The portable types live in `@thaddeus.run/log`:

```ts
interface HeadFields {
  readonly repo: string;
  readonly view: string;
  readonly version: number;
  readonly previous: string | null;
  readonly heads: readonly string[];
}

interface HeadRecord extends HeadFields {
  readonly id: string;
  readonly owner: string;
  readonly sig: Uint8Array;
}

interface HeadRecordWire extends Omit<HeadRecord, 'sig'> {
  readonly sig: string;
}
```

The signed bytes are UTF-8 JSON for exactly this tuple:

```text
[
  "thaddeus.log.head.v1",
  repo,
  view,
  version,
  previous,
  sortedHeads,
  owner
]
```

There are no optional fields or alternate canonical encodings. `repo`, `view`,
and `owner` are non-empty. Operation and previous-record IDs are lowercase
64-character hexadecimal BLAKE3 IDs. `heads` is sorted and unique. Version 0 has
`previous: null`; every later version increments by one and names the exact
preceding record ID. Later head sets retain every previously signed head ID.

The record `id` is BLAKE3 of the canonical bytes. `sig` is the owner's Ed25519
signature over the same bytes and is verified through `owner`'s `did:key`. HTTP
uses a plain JSON object with the 64-byte signature encoded as 128 lowercase
hexadecimal characters. Durable storage uses the backend record codec.

`canonicalHead`, `headId`, `signHead`, `verifyHead`, `encodeHeadRecord`,
`decodeHeadRecord`, `verifyHeadChain`, and `verifyHeadSnapshot` implement this
format. Verification reports stable codes for malformed records, bad IDs or
signatures, wrong repository/view/owner, rollback, fork, gap, broken previous
links, dropped heads, and invalid, duplicate, missing, or extra operations.

## Durable history

`HeadStore` writes each version as one backend record:

```text
head/<percent-encoded-view>/<16-digit-zero-padded-version>
```

There is no mutable `current` pointer. Current means the final record in a
completely valid contiguous stored chain. `load` fails closed on corrupt keys or
records, missing versions, broken links, scope changes, owner changes, or
conflicts instead of returning an older prefix. `bootstrap` accepts only a
version-0 record, `advance` accepts a direct successor, and `import` verifies a
complete remote chain against the locally pinned prefix before writing unseen
records. Exact imports are idempotent.

This sequence records owner-authored updates. It is not the served-head
transparency, witness, or gossip log assigned to THA-56.

## Clone, pull, and exact snapshots

Clone and pull treat every response as hostile:

1. Decode and cryptographically verify the complete head chain.
2. Check repository and remote-view bindings and the expected or pinned owner.
3. Require the locally retained chain to be an exact prefix.
4. Decode the bundle and verify that its operations are exactly the current
   signed head's reachable closure.
5. Persist the verified chain.
6. Persist objects, capabilities, operations, and metadata.
7. Move the requested local projection using only `head.heads`.

This rejects a missing signed head, missing ancestor, forged or duplicate
operation, and unrelated injected operation. A verification failure cannot move
the local view. The signed pin is deliberately stored before bundle content: if
later persistence fails, a retry still cannot accept a rollback.

A remote view may be cached under an internal local inspection name, but trust
is pinned under the remote view's signed name.

## First contact and owner trust

`clone --owner <did>` checks an owner DID obtained through another trusted
channel. Without it, clone uses trust on first use: it verifies the first chain
cryptographically and durably pins that valid chain's owner. Every later pull
rejects an owner change.

TOFU does not identify the correct owner on first contact. A malicious server
that controls a client's first response can substitute a different valid owner
and history. Supplying `--owner` closes that first-contact substitution for a
caller who has an authentic owner DID.

## Owner-only shared authority

Delegates retain their scoped ability to sign and upload operations. They cannot
create a shared branch or sign a landing. A successful shared landing has two
independent requirements:

- all existing conflict, delegation, provenance, veto, reputation, and other
  repository policies allow the proposed operations; and
- the repository owner supplies the exact next signed head record for the sorted
  union of the current signed heads and uploaded source heads.

The server persists the signed record before updating its in-memory projection.
A policy denial returns `landed: false` and persists no candidate record. A
stale successor is not retried automatically because only the owner can review
and sign the new current state.

For a delegate, ordinary `push` uploads operations and prints their head IDs,
then reports that an owner signature is required. It never says the operations
were published. The owner reviews those IDs and signs the landing from a local
copy containing the operations or through the SDK. Delegation scope and budget
policy still evaluates the delegate-authored operations when the owner lands
them.

## Legacy bootstrap

An old raw shared view has no trustworthy remote head. Public view, list, and
pull requests therefore return HTTP 428 until its owner chooses a genesis.

From a clean legacy working copy with no unpublished commits, the owner runs:

```sh
thaddeus pull --bootstrap-head
```

The CLI refuses an existing local signed chain and signs the working copy's
saved `base` for its current view as version 0. It does not trust the server's
raw pointer or substitute unpublished local heads. The owner-only bootstrap
endpoint checks that every selected operation and ancestor exists, persists the
record, and makes it authoritative. Repeated bootstrap is a conflict. If the
bootstrap succeeds but the following pull fails, the CLI tells the user to rerun
an ordinary `thaddeus pull`.

## Server wire behavior

Repository creation requires an owner-signed empty `main` genesis. View reads
return `{ view, head, chain }`; view lists return current signed records; pulls
return `{ view, head, chain, ...bundle }` and no unsigned `heads` authority.
Creating a view accepts an owner-signed version-0 record. Landing accepts
`fromHeads`, `into`, contributions, and the exact owner-signed successor.

Malformed, forged, wrong-scope, incomplete, or unknown-operation records return
400; a non-owner request or head signer returns 403; an unknown repository or
view returns 404; rollback, fork, gap, stale successor, duplicate creation, and
repeated bootstrap return 409; and an unsigned legacy view returns 428. Public
shared-view handlers never derive authority from raw `view/*` records.

## Residual limits and THA-56

This design detects rollback and forks relative to history a client has already
pinned. It does not let two isolated first-time clients discover that a server
showed them different valid owner-signed histories, and it does not prove when a
server served a head or omitted a newer one it already possessed.

Cross-client gossip, witnessing, served-head timestamps, Merkle inclusion and
consistency proofs, and CT-style transparency are exclusively THA-56. They are
not partially implemented here.
