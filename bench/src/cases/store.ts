import { type Identity, ready } from '@thaddeus.run/identity';
import type { Repo } from '@thaddeus.run/platform';
import {
  type Capability,
  decrypt,
  encrypt,
  type EncryptedObject,
  issueCapability,
  newContentKey,
  type Ref,
} from '@thaddeus.run/store';

import type { BenchCase } from '../case';
import { authorsOf } from '../fixtures/materialize';
import { createPrng } from '../prng';
import {
  LIBRARY_FIXTURES,
  newFileContent,
  openCached,
  openWritable,
  OPS_PER_SAMPLE,
  treeBytes,
} from './common';

// Object-store cases: raw encrypt/decrypt bandwidth by object size, and
// MemoryStore put/ingest/get on a FileBackend holding the fixture.

const KiB = 1024;

// Object sizes for the encrypt/decrypt cases, by id suffix.
const OBJECT_SIZES = [
  ['1k', KiB],
  ['64k', 64 * KiB],
  ['1m', 1024 * KiB],
] as const;

// Bytes each timed repeat pushes through encrypt or decrypt, so every size
// gets a sample long enough to time (4,096 objects of 1 KiB, 4 of 1 MiB).
const BYTES_PER_SAMPLE = 4 * 1024 * KiB;

// Objects prepared in setup for `store.ingest`: enough for the record's 2
// warm-ups and 10 repeats twice over. A longer run cycles through them again,
// which repeats the same three backend writes per object.
const INGEST_POOL = OPS_PER_SAMPLE * 24;

// `size` bytes from the seeded PRNG, so every run encrypts the same plaintext.
function deterministicBytes(size: number, seed: number): Uint8Array {
  const prng = createPrng(seed);
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = prng.int(256);
  return bytes;
}

interface CryptoState {
  plaintext: Uint8Array;
  contentKey: Uint8Array;
  object: EncryptedObject;
  iterations: number;
}

// Plaintext, key and one ciphertext for an encrypt or decrypt case. The key
// and nonce are random, as in the store; only the plaintext is fixed.
async function cryptoSetup(size: number): Promise<CryptoState> {
  await ready();
  const plaintext = deterministicBytes(size, size);
  const contentKey = newContentKey();
  return {
    plaintext,
    contentKey,
    object: encrypt(plaintext, contentKey),
    iterations: Math.max(1, BYTES_PER_SAMPLE / size),
  };
}

const encryptCases: BenchCase<CryptoState>[] = OBJECT_SIZES.map(
  ([label, size]) => ({
    id: `store.encrypt.${label}`,
    version: 1,
    suite: 'library',
    fixtures: LIBRARY_FIXTURES,
    isolation: 'per-case',
    setup: () => cryptoSetup(size),
    run: (s) => {
      for (let i = 0; i < s.iterations; i++) encrypt(s.plaintext, s.contentKey);
      return Promise.resolve({ bytes: s.iterations * size });
    },
  })
);

const decryptCases: BenchCase<CryptoState>[] = OBJECT_SIZES.map(
  ([label, size]) => ({
    id: `store.decrypt.${label}`,
    version: 1,
    suite: 'library',
    fixtures: LIBRARY_FIXTURES,
    isolation: 'per-case',
    setup: () => cryptoSetup(size),
    run: (s) => {
      for (let i = 0; i < s.iterations; i++) decrypt(s.object, s.contentKey);
      return Promise.resolve({ bytes: s.iterations * size });
    },
  })
);

interface PutState {
  cached: string;
  repo: Repo;
  owner: Identity;
  next: number;
}

const storePut: BenchCase<PutState> = {
  id: 'store.put',
  version: 1,
  suite: 'library',
  fixtures: LIBRARY_FIXTURES,
  isolation: 'per-case',
  writes: true,
  setup: async (ctx) => {
    const { cached, repo } = await openWritable(ctx);
    return { cached, repo, owner: authorsOf(ctx.plan)[0], next: 0 };
  },
  run: async (s) => {
    for (let i = 0; i < OPS_PER_SAMPLE; i++) {
      await s.repo.store.put(newFileContent(s.next++), s.owner);
    }
    return { ops: OPS_PER_SAMPLE };
  },
  measure: (s) => Promise.resolve({ diskBytes: treeBytes(s.cached) }),
};

interface IngestState {
  cached: string;
  repo: Repo;
  pool: { object: EncryptedObject; caps: Capability[] }[];
  next: number;
}

// Times `MemoryStore.ingest`, the server's path for a client-encrypted
// object. The objects and their owner capabilities are built in setup, so
// the timed part is verification and the write-through only.
const storeIngest: BenchCase<IngestState> = {
  id: 'store.ingest',
  version: 1,
  suite: 'library',
  fixtures: LIBRARY_FIXTURES,
  isolation: 'per-case',
  writes: true,
  setup: async (ctx) => {
    const { cached, repo } = await openWritable(ctx);
    const owner = authorsOf(ctx.plan)[0];
    const pool = Array.from({ length: INGEST_POOL }, (_, k) => {
      const contentKey = newContentKey();
      const object = encrypt(newFileContent(k), contentKey);
      const cap = issueCapability({
        object: object.plaintext_id,
        contentKey,
        grantee: owner.toPublic(),
        grantedBy: owner,
      });
      return { object, caps: [cap] };
    });
    return { cached, repo, pool, next: 0 };
  },
  run: async (s) => {
    for (let i = 0; i < OPS_PER_SAMPLE; i++) {
      const { object, caps } = s.pool[s.next++ % s.pool.length];
      await s.repo.store.ingest(object, caps);
    }
    return { ops: OPS_PER_SAMPLE };
  },
  measure: (s) => Promise.resolve({ diskBytes: treeBytes(s.cached) }),
};

interface GetState {
  root: string;
  repo: Repo;
  owner: Identity;
  refs: Ref[];
  next: number;
}

// Times `MemoryStore.get` with its capability check: find the reader's
// capability, verify its signature, unwrap the key, decrypt and check the
// plaintext address. Reads cycle over main's files that the owner wrote,
// because `put` grants a capability to the writing author only.
const storeGet: BenchCase<GetState> = {
  id: 'store.get',
  version: 1,
  suite: 'library',
  fixtures: LIBRARY_FIXTURES,
  isolation: 'per-case',
  setup: async (ctx) => {
    const { root, repo } = await openCached(ctx);
    const owner = authorsOf(ctx.plan)[0];
    const refs: Ref[] = [];
    for (const { ref } of repo.log.materialize('main').values()) {
      const held =
        ref !== null &&
        repo.store
          .caps(ref.plaintext_id)
          .some((cap) => cap.grantee === owner.did);
      if (held) refs.push(ref);
    }
    if (refs.length === 0) {
      throw new Error(`no file on main of ${ctx.fixture} is readable by owner`);
    }
    return { root, repo, owner, refs, next: 0 };
  },
  run: async (s) => {
    for (let i = 0; i < OPS_PER_SAMPLE; i++) {
      await s.repo.store.get(s.refs[s.next++ % s.refs.length], s.owner);
    }
    return { ops: OPS_PER_SAMPLE };
  },
  measure: (s) => Promise.resolve({ diskBytes: treeBytes(s.root) }),
};

const storeCases: readonly BenchCase[] = [
  ...encryptCases,
  ...decryptCases,
  storePut,
  storeIngest,
  storeGet,
] as BenchCase[];

export default storeCases;
