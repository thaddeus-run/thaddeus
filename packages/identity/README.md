# @thaddeus.run/identity

Self-owned cryptographic identity (`did:key`) for the Thaddeus substrate. One
key signs, verifies, and receives sealed messages.

```bash
bun add @thaddeus.run/identity
```

```ts
import { Identity, ready } from '@thaddeus.run/identity';

await ready();
const me = Identity.create();
const sig = me.sign(new TextEncoder().encode('hello'));
me.toPublic().verify(new TextEncoder().encode('hello'), sig); // true
```

Apache-2.0.
