import {
  type ConsumeNonceInput,
  MAX_REPLAY_NONCE_CAPACITY,
} from '@thaddeus.run/store';

export interface NonceExpiration {
  readonly key: string;
  readonly expiresAt: number;
}

const OPAQUE_NONCE_KEY = /^[0-9a-f]{64}$/;

/** Validates the bounded backend contract before any state is read or changed. */
export function validateConsumeNonceInput(input: ConsumeNonceInput): void {
  if (!OPAQUE_NONCE_KEY.test(input.key)) {
    throw new TypeError(
      'replay nonce key must be 64 lowercase hexadecimal characters'
    );
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new RangeError(
      'replay nonce current time must be a non-negative safe integer'
    );
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < input.now) {
    throw new RangeError(
      'replay nonce expiry must be a safe integer at or after current time'
    );
  }
  if (
    !Number.isSafeInteger(input.capacity) ||
    input.capacity <= 0 ||
    input.capacity > MAX_REPLAY_NONCE_CAPACITY
  ) {
    throw new RangeError(
      `replay nonce capacity must be a positive safe integer no greater than ${MAX_REPLAY_NONCE_CAPACITY}`
    );
  }
}

export function pushExpiration(
  heap: NonceExpiration[],
  value: NonceExpiration
): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    const parentValue = heap[parent];
    if (
      parentValue === undefined ||
      compareExpiration(parentValue, value) <= 0
    ) {
      break;
    }
    heap[index] = parentValue;
    index = parent;
  }
  heap[index] = value;
}

export function popExpiration(
  heap: NonceExpiration[]
): NonceExpiration | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (first === undefined || last === undefined || heap.length === 0) {
    return first;
  }
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const leftValue = heap[left];
    if (leftValue === undefined) break;
    const rightValue = heap[right];
    const child =
      rightValue !== undefined && compareExpiration(rightValue, leftValue) < 0
        ? right
        : left;
    const childValue = heap[child];
    if (childValue === undefined || compareExpiration(childValue, last) >= 0) {
      break;
    }
    heap[index] = childValue;
    index = child;
  }
  heap[index] = last;
  return first;
}

function compareExpiration(
  left: NonceExpiration,
  right: NonceExpiration
): number {
  if (left.expiresAt !== right.expiresAt) {
    return left.expiresAt - right.expiresAt;
  }
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}
