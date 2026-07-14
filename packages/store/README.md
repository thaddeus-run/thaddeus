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

## Replay nonce backend capability

`ReplayNonceBackend.consumeNonce()` is the backend-neutral atomic contract used
by signed HTTP mutations. It accepts only an opaque 64-character lowercase
BLAKE3 key, an absolute expiry, the current time, and a bounded capacity. Its
result distinguishes `consumed`, `replayed`, and `capacity`, and reports active
and cleaned counts plus the earliest safe retry time when full.

The default capacity is 100,000 live records and the hard maximum is 1,000,000.
Capacities must be positive safe integers. Within an implementation's
coordination domain, concurrent calls for one live key produce exactly one
`consumed` result. Records remain live at the exact expiry millisecond and are
released only when `now > expiresAt`.

Apache-2.0.
