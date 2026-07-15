# @thaddeus.run/client

The **Thaddeus** client SDK. A `Client` holds a self-owned `Identity` and speaks
the untrusted HTTP remote (`@thaddeus.run/server`): `createRepo`, `clone`,
`push`, `land`, `scheduleReveal`, and `reveal`. It signs every write, ingests
pulled ciphertext into a local durable repo, and never sends plaintext keys; all
wrapping and encryption is client-side. A scheduled reveal deliberately sends a
capability wrapped to the well-known public identity, making the chosen host the
trusted embargo custodian for that file until its start time.

Clone and pull verify a shared view's complete owner-signed `HeadRecord` chain
before accepting content. An existing local chain must be an exact prefix, and
the operation bundle must be exactly the signed head's reachable closure. The
verified chain is persisted before objects and operations, and the local view is
moved only from `head.heads`. Rollback, a conflicting history, wrong scope or
owner, withheld ancestry, forged operations, and injected extras fail closed.

`clone(..., { expectedOwner })` checks an owner DID learned out of band. Without
it, the first valid chain's owner is pinned on first use. `listViews` verifies
listed signed records without changing local trust; a pull imports and pins the
complete chain.

Shared view creation and landing require the pinned repository owner's
signature. Delegates may still `push` operations. An owner landing first
refreshes the current signed chain, signs its exact successor, and never retries
a stale conflict automatically. Policy denial retains only the verified current
chain.

Portable reputation uses `exportReputation(did)` to fetch a public, versioned
archive and `importReputation(archive)` to submit it in a request signed by the
archive subject. The destination verifies every contribution independently and
returns imported/duplicate/total counts.

Collection helpers drain bounded pages and retain complete-result behavior.
`listReposPage`, `listViewsPage`, `listReleasesPage`, `listGrantsPage`, and
`exportReputationPage` expose individual pages through `PageOptions`. Clone and
pull reassemble and verify all pages before writing any local state.

Every signed mutation carries a fresh random nonce covered by its signature, so
the server can reject an otherwise-valid request replayed during the timestamp
window.

> **Status: spike.** Online, full-set sync. Delegates can upload operations;
> shared-head authority is owner-only.
