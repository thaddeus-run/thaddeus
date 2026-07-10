# @thaddeus.run/store

Encrypted, content-addressed objects with per-object capabilities. A value is
ciphertext at rest; access is a key sealed to an identity; offboarding is a
single key rotation.

```bash
bun add @thaddeus.run/store @thaddeus.run/identity
```

```ts
import { Identity, ready } from '@thaddeus.run/identity';
import { MemoryStore } from '@thaddeus.run/store';

await ready();
const store = new MemoryStore();
const alice = Identity.create();
const bob = Identity.create();

const ref = await store.put(new TextEncoder().encode('DATABASE_URL=…'), alice);
await store.grant(ref, bob.toPublic(), alice); // bob can now read
await store.revoke(ref, bob.toPublic(), alice); // key rotation — bob cannot

const reveal = await store.scheduleReveal(
  ref,
  '2030-01-01T00:00:00.000Z',
  alice
); // withheld capability; transport it through an owner-authorized channel
await store.revealDue('2030-01-01T00:00:00.000Z'); // now any reader can decrypt
```

A pending reveal must be withheld by a trusted custodian: the public identity is
well-known, so its holder can unwrap or publish the capability early. This
store-honest membrane supports unattended release; trustless release requires
time-lock crypto.

Apache-2.0.
