# @thaddeus.run/review

Signed reviewer grants and veto history for Thaddeus.

An owner-signed `ReviewerCapability` permits vetoes within repository path
scopes. It grants no write, land, or decryption rights. Write delegations do not
grant review rights. An identity may hold either role or both, with independent
scopes and revocation.

`signReviewerCapability` signs the repository, reviewer, issuer, paths, issuance
time, unique nonce, hourly veto limit, and active veto limit. Its content ID
identifies one grant. `signScopedVeto` signs the repository and grant ID along
with the target op, reviewer, reason, and timestamp. The owner uses the explicit
`owner` grant marker. Domain-separated signatures prevent one record type from
being reused as another.

`ReviewLog` persists signed grant, revocation, veto acceptance, and withdrawal
events before updating memory. Grant revocation is terminal for that grant ID. A
new grant never revives vetoes under the old one. Reviewers may withdraw their
own vetoes; owners may dismiss vetoes, including legacy vetoes. Audit evidence
remains after either action. Re-uploading a withdrawn veto does not revive it.

`status(veto, op)` separates current authority from cryptographic integrity. A
veto may be `active`, `revoked`, `withdrawn`, `unauthorized`, `legacy`, or
`unverified`. `VetoLog.status` continues to report signature validity only.
Offline status reflects the signed evidence fetched so far; it is not a promise
about the next server land decision.

`blockOnVeto(vetoes, reviewers, authorized)` in `@thaddeus.run/platform`
requires an explicit reviewer allowlist and lifecycle authorization predicate.
Empty means nobody is trusted; omitting either argument throws. The server also
checks the exact grant, repository, target path, revocation, and withdrawal for
each veto at landing.

## Upgrade behavior

Old v1 owner vetoes remain active. Old non-owner v1 vetoes remain readable but
cannot block a land, even after that identity receives review rights. Those
reviewers must receive a new grant and submit a fresh scoped veto. Existing v1
signatures and content IDs remain readable. Write delegates are never promoted
to reviewers automatically.

## Limits and persistence

Default server ceilings are 60 newly accepted vetoes per reviewer and repository
per trailing hour, 256 active vetoes, and 256 veto entries per request. Signed
grant limits may tighten the hourly and active ceilings. Usage is shared across
that reviewer's grants. Identical retries consume no additional budget. Receipt
time comes from the server, not the signed veto timestamp. Withdrawal and
revocation remain available when submission budgets are exhausted.

The acceptance event stores the veto and receipt time together. Reload restores
rate usage and lifecycle state. Recent timestamp indexes discard expired entries
after each acceptance. If the server clock moves behind the last accepted
receipt, new vetoes fail closed until it catches up. Revocation and withdrawal
remain available. Audit storage is not subject to a lifetime retention limit in
this release.

Mutations require the caller to serialize access per repository. The server uses
the same lock for review writes, revocation, and landing. Malformed durable
authority records fail closed. Offline imports may retain signed records before
their referenced grants arrive; such vetoes remain unauthorized until the grant
is present. Imported evidence is never accepted through server write routes.

Approval-required policies and a pending-review queue remain in THA-97 and
THA-98.
