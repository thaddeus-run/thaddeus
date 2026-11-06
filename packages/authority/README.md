# @thaddeus.run/authority

The authorization contract for a trusted Thaddeus service, as decided in
[ADR 0003](../../docs/adr/0003-trusted-code-processing-service.md) and
[ADR 0006](../../docs/adr/0006-the-service-records-actors-may-sign.md).
Browsers, external agents and integration workers all go through it.

- `Authority` keeps each tenant's versioned policy, issues short-lived
  credentials with separate `read`, `edit`, `execute`, `review` and `integrate`
  scopes limited by repository and path, and revokes them. Every use is signed
  by the credential's holder key with a single-use nonce and checked against the
  policy current at that moment.
- `KeyCustody` encrypts repository content with a data key per repository,
  stored only wrapped by a root key provider. Plaintext goes in under an `edit`
  authorization and out under a `read` authorization, and every access is
  audited before plaintext is returned.
- `Authority.advance` moves a view's shared history under an `integrate`
  authorization that covers every changed path, and signs a record that keeps
  who asked (`requestedBy`, recorded by the service) apart from who signed
  (`actorClaims`).
- `Authority.queue` and `redeem` carry an authorization through a work queue and
  re-check it when the work starts.

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { FileBackend } from '@thaddeus.run/persist';
import {
  Authority,
  KeyCustody,
  LocalRootKey,
  proveAction,
  proveIssue,
} from '@thaddeus.run/authority';

await ready();
const backend = new FileBackend('./state');
const authority = await Authority.open({ backend, signer: serviceIdentity });
const custody = new KeyCustody({
  authority,
  backend,
  root: LocalRootKey.fromBytes(rootKeyBytes),
});

// An agent that is a member of tenant `acme` asks for a 15-minute credential.
const request = {
  service: authority.did,
  tenant: 'acme',
  principal: agent.did,
  subject: agent.did,
  kind: 'agent' as const,
  grants: [{ repo: 'app', scopes: ['read' as const], paths: ['src/**'] }],
};
const { token } = await authority.issue(request, proveIssue(agent, request));

// Each use is signed by the agent's key.
const action = {
  scope: 'read' as const,
  tenant: 'acme',
  repo: 'app',
  paths: ['src/a.ts'],
};
const auth = await authority.authorize(
  token,
  action,
  proveAction(agent, token, action)
);
const plaintext = await custody.open(auth, 'src/a.ts', sealed);
```

The shipped `@thaddeus.run/server` does not use this package yet. Remote
workspaces (THA-152), the query API (THA-148), the browser boundary (THA-89) and
shared-head advancement (THA-67) put it behind routes. The
[design](../../docs/superpowers/specs/2026-11-06-tha-150-trusted-service-authority-design.md)
holds the full contract and its limits: revocation is single-node until THA-83,
and `LocalRootKey` is for development only.
