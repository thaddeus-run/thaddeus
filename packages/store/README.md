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
```

Apache-2.0.
