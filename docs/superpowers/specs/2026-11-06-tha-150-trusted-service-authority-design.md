# THA-150 trusted-service authority and scoped agent sessions

**Date:** 2026-11-06 **Status:** Implemented in `@thaddeus.run/authority`
**Issue:** [THA-150](https://linear.app/thaddeus-run/issue/THA-150) (GitHub
#219)

## Intent

[ADR 0003](../../adr/0003-trusted-code-processing-service.md) lets a trusted
service read repository plaintext for authorized requests. Browsers, external
agents and integration workers all need the same answer to "may this caller do
this, right now". THA-150 defines that answer as a contract in public core and
ships a reference implementation with tests. The hosted product, its HTTP routes
and its sign-in flow are separate work.

The acceptance criteria and where each is met:

| Criterion                                                                                       | Where                                                                      |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Short-lived credentials with separate scopes, repository and path restrictions, and revocation  | `Authority.issue`, `authorize`, `revoke`; sections 2 to 5                  |
| Authorized server-side plaintext processing that protects service-managed keys                  | `KeyCustody`, `LocalRootKey`, `RootKeyProvider`; section 6                 |
| Service-authorized history advancement, with actor attribution kept apart from agent signatures | `Authority.advance`, `ServiceHeadRecord`, `describeAttribution`; section 7 |
| Tests for tenants, revoked and expired credentials, replay, queued work and policy changes      | `packages/authority/test/`; section 10                                     |

## Non-goals

- HTTP routes. The shipped server stays keyless. THA-152 (remote workspaces),
  THA-148 (query API), THA-89 (browser mutation boundary) and THA-67
  (shared-head advancement) put this contract behind routes.
- Sign-in. THA-54 decides how a human proves who they are before a session is
  issued.
- A KMS root key provider. The contract is `RootKeyProvider`; the hosted
  deployment supplies one.
- Revocation that is consistent across nodes. THA-83 owns it. This
  implementation is single-node, like the shipped server.
- Migrating existing encrypted repositories. THA-151 owns it.

## 1. Parties

- **Trusted service.** Holds a signing identity (`ServiceSigner`) and a root key
  provider. It signs credentials, queued-work tickets and head records.
- **Tenant.** An isolation unit with its own versioned policy. Every credential,
  revocation, audit record, data key and head chain belongs to one tenant.
- **Member.** A `did:key` listed in a tenant's policy with a kind (`human`,
  `agent` or `worker`) and grants.
- **Holder.** The key a credential is bound to. It signs every use.

## 2. Scopes, grants and paths

The five scopes are `read`, `edit`, `execute`, `review` and `integrate`. None
implies another. An `edit` credential cannot read, and a `read` credential
cannot integrate.

A grant names one repository, a set of scopes and a set of path patterns. A
pattern is `**` (the whole repository), `dir/**` (everything under `dir/`) or
one exact path. `src/**` covers `src/a.ts` and `src/lib/**` but not `src`
itself, matching the delegated path scopes the server already enforces. Paths
are relative and POSIX. A `.`, `..` or empty segment, a leading `/`, a backslash
or a control character is refused as malformed.

## 3. Credentials

A member signs an issue request naming the tenant, itself as principal, the
holder key as subject, a kind, grants and an optional lifetime. The service
issues a credential when:

1. The principal's signature verifies, the proof is fresh and its nonce is
   unused.
2. The principal is a member of the tenant's current policy.
3. The subject is the principal with the member's own kind, or a different key
   as an `agent` session. A human runs agents this way without an admin adding
   every agent key to the policy.
4. Every requested grant fits inside the principal's policy grants.
5. The lifetime fits the subject kind's ceiling.

| Kind     | Default    | Ceiling  |
| -------- | ---------- | -------- |
| `human`  | 8 hours    | 12 hours |
| `agent`  | 15 minutes | 1 hour   |
| `worker` | 15 minutes | 1 hour   |

A host may lower these, never raise them.

The token is `thc1.<base64url JSON claims>.<base64url signature>`. The service
signs the domain tag `thaddeus.authority.credential.v1` and the exact payload
text, so verification never depends on re-serializing JSON. Claims are the id,
issuer, tenant, principal, subject, kind, canonical grants, issue and expiry
times, and the policy version issuance checked against. Another service, even
one over the same storage, refuses the token.

## 4. Using a credential

Every use carries an action (scope, tenant, repository, path patterns and an
optional transport digest) and a proof. The holder signs, under
`thaddeus.authority.action.v1`, a digest of the token, the canonical action, a
millisecond timestamp and a nonce. The service authorizes when:

1. The token is its own and well formed.
2. The action names the credential's tenant.
3. The holder's signature verifies. A stolen token without the holder key is
   useless.
4. The credential is live: issued no later than now plus the skew window, and
   now is before its expiry.
5. It is not revoked: not by id, and not by a DID revocation of its subject or
   principal dated at or after its issue time.
6. The credential's grants cover every requested pattern.
7. The current policy still gives the principal those grants.
8. The timestamp is within five minutes of the service clock, and the nonce has
   not been used by this holder. The nonce is consumed durably through the
   backend's replay store, so it stays used after a restart.

Steps 4 to 7 run again after the nonce is consumed, because the policy can
change while that write is in flight. The result is an `Authorization` object.
Only the authority creates them, and gates refuse a look-alike object with the
same fields.

Effective authority is always the credential's grants intersected with the
current policy. Narrowing a member's policy narrows its live credentials at the
next check, with no revocation step.

`Authorization.allows(path)` lets a host filter listings, search hits, logs,
caches and subscription events. `Authority.check(authorization)` repeats steps 4
to 7, so a long-lived subscription checks it before every event.

Browsers hold a non-extractable Ed25519 key in WebCrypto and sign proofs with
it, so a browser session is holder-bound like an agent credential. A proof's
`digest` field lets the browser's transport bind a proof to one HTTP request.

## 5. Revocation

- **One credential.** Revoked by token. An admin, the principal or the holder
  may do it.
- **A DID.** Revokes every credential issued so far to or through that DID.
  Revoking a human revokes the agent sessions they issued. An admin or the DID
  itself may do it. Credentials issued afterwards work, so to stop new ones too,
  remove the member from the policy.
- **A member.** Removing a member, or narrowing their grants, refuses their live
  credentials at the next check.

Revocations are written through to the backend and loaded when the authority
opens. A revocation resolves only after every earlier change for that tenant has
finished, so once `revoke` returns, no advancement that started before it is
still in flight.

## 6. Key custody and plaintext

Storage is encrypted with service-managed keys:

- Each repository has a 256-bit data key, created on first use.
- The data key is stored only wrapped by a `RootKeyProvider`. A hosted
  deployment backs the provider with a KMS. `LocalRootKey` wraps with
  XChaCha20-Poly1305 for development and tests.
- The wrap binds the tenant, repository and key version, so a wrapped key copied
  to another repository or tenant does not unwrap there.
- Content is encrypted with XChaCha20-Poly1305. The associated data binds the
  tenant, repository, path and key version, so content cannot be replayed under
  another path or tenant.
- No public method returns a key. The data key lives in a private field of the
  custody object.

Plaintext enters through `seal`, which needs an `edit` authorization for the
path, and leaves through `open`, which needs a `read` authorization for it. Both
re-check the authorization when they act and write an audit record. `open`
decrypts, writes the audit record, checks the authorization again and only then
returns plaintext. If the audit write fails, or a revocation lands during it,
the caller gets no plaintext.

Server-side processing such as indexing or search runs under a worker credential
with `read` scope and goes through the same gate.

## 7. History advancement and attribution

A shared view's history advances only under an `integrate` authorization whose
patterns cover the changed paths. The caller names the version it saw, or null
for a new view. Inside the tenant's serialized section the service:

1. Checks the authorization against the current policy.
2. Checks the view is at the expected version.
3. Verifies every actor claim against the exact new content.
4. Signs a `ServiceHeadRecord` and creates it at the next version with an atomic
   create, so a second writer, even another authority over the same backend,
   gets `stale_head` instead of a fork.

The record holds the content (tenant, repository, view, version, previous record
id, revision and changed paths), the policy version it was authorized under,
`requestedBy` and `actorClaims`:

- `requestedBy` is the principal, subject, kind and credential id the service
  took from the authorization. The service recorded it. It is not anyone's
  signature.
- `actorClaims` are signatures actors made themselves over the exact content
  under `thaddeus.authority.actor-claim.v1`. A claim over any other content is
  refused, not stored.

`describeAttribution` returns `recordedBy` (the service), `requestedBy` and
`signedBy`, where `signedBy` lists only actors whose claims verify. A service
record is therefore never presented as an agent signature, which ADR 0001 and
ADR 0003 require. ADR 0006 applies the same rule to change journal entries.

The service signature covers `requestedBy`, so relabelling who asked breaks
`verifyHeadRecord`. An owner no longer has to be online to sign each landing.

## 8. Queued work

`queue(authorization)` returns a ticket the service signs. It holds the
credential, the action and the queue time. `redeem(ticket)` runs when the work
starts and repeats the checks from section 4 against the state at that moment.
Work whose credential expired or was revoked while it waited, or that the policy
no longer grants, is refused and audited. A ticket redeems once: the redemption
is an atomic create, so a second redemption fails with `ticket_used`, also after
a restart.

The holder's proof is not needed at redemption. The proof was checked when the
work was queued, and redemption happens inside the service.

## 9. Policy changes and concurrency

A tenant's policy is a chain of versions starting at 0. An admin signs a change
naming the version it read. The change applies only if that is still the current
version, and the next version is created atomically, so of two concurrent
changes exactly one wins and the other gets `conflict`. This holds across two
authorities over one backend.

Policy changes, revocations, advancements and ticket redemptions for a tenant
run one at a time, in call order. An advancement called before a policy change
commits under the old version and names it. One called after is checked against
the new version. Reads through `KeyCustody` do not take the tenant lock; they
check before and after their audit write instead.

## 10. Audit

The service writes an audit record for tenant creation, policy changes,
issuance, revocation, refused authorizations, every plaintext read and write,
queued and redeemed tickets and every advancement. Refusals carry their error
code. Records are the service's own account; they never stand in for a signature
by the people they name.

## 11. Durability and limits

State lives in the backend under `authority/`: policy versions, revocations,
redeemed tickets, head records, wrapped data keys and audit records.
`Authority.open` loads policies and revocations. Head chains load on first use.

- One process owns a backend, as with the shipped server. A second process sees
  another one's revocations only after it reopens. Atomic creates still stop two
  processes from forking a policy or a head chain.
- `FileBackend` renames atomically but never calls fsync, so the restart test
  covers a killed process, not a machine crash.
- `FileBackend.list` walks every shard, so opening the authority and reading an
  audit log cost time proportional to all stored keys.

## 12. Errors

Every refusal is an `AuthorityError` with a stable `code`: `malformed`,
`unknown_tenant`, `tenant_exists`, `not_a_member`, `not_an_admin`,
`bad_credential`, `wrong_tenant`, `not_yet_valid`, `expired`, `revoked`,
`bad_proof`, `stale_proof`, `replayed`, `replay_capacity`, `scope_denied`,
`policy_denied`, `conflict`, `stale_head`, `ticket_used`, `bad_ticket`,
`invalid_claim` or `decrypt_failed`.

## Decisions taken without a grill round

The issue was worked end to end without a planning conversation. These are the
choices a reviewer should check first:

1. One new package, `@thaddeus.run/authority`, and no server routes.
2. Every credential is bound to a holder key, browsers included.
3. Effective authority is credential grants intersected with the current policy,
   checked at every use.
4. A member may issue agent sessions to other keys from its own grants.
5. The lifetime ceilings in section 3.
6. The service records history advancements and journal entries; actor
   signatures are optional extra claims (ADR 0006).
7. Queued work re-checks at redemption and fails rather than running on expired
   authority.
8. One data key per repository, wrapped by a root key provider.

## Verification

`moonx authority:test` runs 61 tests. One of them starts a real process that
does the work and dies by SIGKILL, then a second process that opens the same
`FileBackend` directory. Breaking each guard in turn (nonce consumption,
revocation, the current-policy check, expiry, tenant binding of keys, the tenant
lock around advancement, the re-check after the read audit and the holder
signature) makes at least one test fail.
