// The durable cold tier: a namespaced key → bytes store. Implementations live
// in @thaddeus.run/persist (MemoryBackend, FileBackend). Keys are strings like
// `obj/<id>`, `op/<id>`, `view/<name>`. Async — used only behind already-async
// store/log mutations and the static loaders; synchronous reads never touch it.
export interface Backend {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  list(prefix: string): Promise<readonly string[]>;
  delete(key: string): Promise<void>;
}

// A versioned JSON record codec. Records carry Uint8Array fields (nonce,
// ciphertext, sig), so a plain Uint8Array is encoded as {"$u8": base64} and
// decoded back. Deterministic; a leading version field lets a future binary
// encoding supersede it behind the unchanged Backend.
export function encodeRecord(value: unknown): Uint8Array {
  const json = JSON.stringify({ v: 'tplv1', d: value }, (_k, v) =>
    v instanceof Uint8Array ? { $u8: Buffer.from(v).toString('base64') } : v
  );
  return new TextEncoder().encode(json);
}

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
