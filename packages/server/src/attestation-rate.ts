import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { type Backend, decodeRecord, encodeRecord } from '@thaddeus.run/store';

const WINDOW_MS = 60 * 60 * 1_000;

interface RateRecord {
  readonly issuedAt: number;
}

export type RateReservation =
  | {
      readonly status: 'reserved';
      readonly key: string;
      readonly cleaned: number;
    }
  | { readonly status: 'rate_limited'; readonly cleaned: number };

const hash = (value: string): string =>
  bytesToHex(blake3(new TextEncoder().encode(value)));

// Durable sliding-window reservations are deliberately opaque. The per-subject
// lock covers the supported single-process deployment while putIfAbsent keeps
// creation atomic on backends that provide it.
export class AttestationRateLimiter {
  readonly #backend: Backend;
  readonly #limit: number;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(backend: Backend, limit: number) {
    this.#backend = backend;
    this.#limit = limit;
  }

  reserve(
    subject: string,
    event: string,
    now: number
  ): Promise<RateReservation> {
    const subjectHash = hash(subject);
    return this.#withSubjectLock(subjectHash, async () => {
      const prefix = `attestation-rate/v1/${subjectHash}/`;
      let cleaned = 0;
      let active = 0;
      for (const key of await this.#backend.list(prefix)) {
        const bytes = await this.#backend.get(key);
        if (bytes === undefined) continue;
        const record = decodeRecord(bytes) as RateRecord;
        if (
          record === null ||
          typeof record !== 'object' ||
          !Number.isSafeInteger(record.issuedAt) ||
          record.issuedAt < 0
        ) {
          throw new Error('stored attestation rate record is invalid');
        }
        if (record.issuedAt <= now - WINDOW_MS) {
          await this.#backend.delete(key);
          cleaned += 1;
        } else {
          active += 1;
        }
      }
      if (active >= this.#limit) {
        return { status: 'rate_limited', cleaned };
      }

      const key = `${prefix}${String(now).padStart(13, '0')}/${hash(event)}`;
      const bytes = encodeRecord({ issuedAt: now } satisfies RateRecord);
      let created: boolean;
      if (this.#backend.putIfAbsent !== undefined) {
        created = await this.#backend.putIfAbsent(key, bytes);
      } else if ((await this.#backend.get(key)) === undefined) {
        await this.#backend.put(key, bytes);
        created = true;
      } else {
        created = false;
      }
      return created
        ? { status: 'reserved', key, cleaned }
        : { status: 'rate_limited', cleaned };
    });
  }

  async release(key: string): Promise<void> {
    await this.#backend.delete(key);
  }

  #withSubjectLock<T>(subjectHash: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(subjectHash) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined
    );
    this.#locks.set(subjectHash, settled);
    void settled.then(() => {
      if (this.#locks.get(subjectHash) === settled) {
        this.#locks.delete(subjectHash);
      }
    });
    return next;
  }
}
