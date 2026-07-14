// The durable cold tier: a namespaced key → bytes store. Implementations live
// in @thaddeus.run/persist (MemoryBackend, FileBackend). Keys are strings like
// `obj/<id>`, `op/<id>`, `view/<name>`. Async — used only behind already-async
// store/log mutations and the static loaders; synchronous reads never touch it.
export interface Backend {
  put(key: string, bytes: Uint8Array): Promise<void>;
  // Atomically creates a key and returns false when it already exists. Durable
  // monotonic records use this to prevent concurrent writers from overwriting.
  putIfAbsent?(key: string, bytes: Uint8Array): Promise<boolean>;
  get(key: string): Promise<Uint8Array | undefined>;
  list(prefix: string): Promise<readonly string[]>;
  delete(key: string): Promise<void>;
}

// Atomic replay protection is a separate backend capability because generic
// key/value operations cannot express consume-once plus bounded cleanup without
// a race. Implementations define their coordination domain (process-local for
// MemoryBackend and one FileBackend process for the filesystem implementation).
export interface ReplayNonceBackend {
  /** Atomically consumes one opaque nonce key within the backend's domain. */
  consumeNonce(input: ConsumeNonceInput): Promise<ConsumeNonceResult>;
}

export interface ConsumeNonceInput {
  // Lowercase hexadecimal BLAKE3 output. The backend never receives the signer
  // DID or signed nonce that produced this opaque key.
  readonly key: string;
  readonly expiresAt: number;
  readonly now: number;
  readonly capacity: number;
}

export type ConsumeNonceResult =
  | {
      readonly status: 'consumed' | 'replayed';
      readonly activeCount: number;
      readonly cleanedCount: number;
    }
  | {
      readonly status: 'capacity';
      readonly activeCount: number;
      readonly cleanedCount: number;
      // First millisecond at which the oldest live record may be cleaned.
      readonly retryAt: number;
    };

export const DEFAULT_REPLAY_NONCE_CAPACITY: number = 100_000;
export const MAX_REPLAY_NONCE_CAPACITY: number = 1_000_000;

/**
 * Encodes a value as a versioned JSON record while preserving byte arrays.
 * The leading version lets a future codec replace this format transparently.
 */
export function encodeRecord(value: unknown): Uint8Array {
  const json = JSON.stringify({ v: 'tplv1', d: value }, (_k, v) =>
    v instanceof Uint8Array ? { $u8: Buffer.from(v).toString('base64') } : v
  );
  return new TextEncoder().encode(json);
}

/** Decodes a versioned backend record and restores encoded byte arrays. */
export function decodeRecord(bytes: Uint8Array): unknown {
  const parsed = JSON.parse(new TextDecoder().decode(bytes), (_k, v) =>
    v !== null &&
    typeof v === 'object' &&
    typeof (v as { $u8?: unknown }).$u8 === 'string'
      ? new Uint8Array(Buffer.from((v as { $u8: string }).$u8, 'base64'))
      : v
  ) as { v: string; d: unknown };
  if (parsed.v !== 'tplv1') {
    throw new TypeError(`unknown record version: ${parsed.v}`);
  }
  return parsed.d;
}
