# A trusted service processes code

Thaddeus will let a Thaddeus-hosted or customer-hosted service read repository
plaintext to answer authorized requests: browsing, diffs, search, semantic
queries and execution. Storage stays encrypted with service-managed keys. The
trusted-service path drops the promise that the host cannot read code, because
every one of those requests needs plaintext and a host that cannot decrypt can
serve none of them. Encrypted storage with separately trusted compute was the
alternative, and its key distribution cost more than the separation protected.

The other safeguards stay. Read, edit, execute, review and integrate remain
separate scopes, each limited by repository and path and each revocable.
Authorization covers reads, queries, logs, caches and subscriptions, not only
writes. Every plaintext access leaves an audit record. Untrusted execution runs
isolated from other tenants and from service credentials. Attribution stays a
signed declaration by the actor, as in
[ADR 0001](0001-actor-attribution-is-a-declaration.md), so a record the service
creates is never presented as an agent's signature.

This supersedes mandatory extension key custody in
[THA-77](https://linear.app/thaddeus-run/issue/THA-77) and browser decryption in
[THA-75](https://linear.app/thaddeus-run/issue/THA-75). The shipped open-source
server keeps its keyless behaviour until
[THA-150](https://linear.app/thaddeus-run/issue/THA-150) delivers the authority
contract and [THA-151](https://linear.app/thaddeus-run/issue/THA-151) the
migration path for existing encrypted repositories. The
[architecture contract](../agent-first-architecture.md) holds the full trust
model and the migration obligations.
