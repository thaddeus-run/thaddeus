import {
  type ConsumeNonceInput,
  type ConsumeNonceResult,
  MAX_REPLAY_NONCE_CAPACITY,
} from '@thaddeus.run/store';

export interface NonceExpiration {
  readonly key: string;
  readonly expiresAt: number;
}

export interface ReplayNonceState {
  readonly byKey: Map<string, number>;
  readonly expirations: NonceExpiration[];
}

export interface ReplayNonceDecision {
  readonly cleaned: readonly NonceExpiration[];
  readonly record?: NonceExpiration;
  readonly result: ConsumeNonceResult;
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

/** Applies the backend-neutral replay state machine and describes durable work. */
export function consumeNonceState(
  state: ReplayNonceState,
  input: ConsumeNonceInput
): ReplayNonceDecision {
  validateConsumeNonceInput(input);
  const cleaned: NonceExpiration[] = [];
  for (;;) {
    const first = state.expirations[0];
    // A nonce remains live at its exact expiry boundary.
    if (first === undefined || first.expiresAt >= input.now) break;
    const expired = popExpiration(state.expirations);
    if (
      expired !== undefined &&
      state.byKey.get(expired.key) === expired.expiresAt
    ) {
      state.byKey.delete(expired.key);
      cleaned.push(expired);
    }
  }

  if (state.byKey.has(input.key)) {
    return {
      cleaned,
      result: {
        status: 'replayed',
        activeCount: state.byKey.size,
        cleanedCount: cleaned.length,
      },
    };
  }
  if (state.byKey.size >= input.capacity) {
    const first = state.expirations[0];
    if (first === undefined) {
      throw new Error('replay nonce index is inconsistent');
    }
    return {
      cleaned,
      result: {
        status: 'capacity',
        activeCount: state.byKey.size,
        cleanedCount: cleaned.length,
        retryAt: first.expiresAt + 1,
      },
    };
  }

  const record = { key: input.key, expiresAt: input.expiresAt };
  state.byKey.set(record.key, record.expiresAt);
  pushExpiration(state.expirations, record);
  return {
    cleaned,
    record,
    result: {
      status: 'consumed',
      activeCount: state.byKey.size,
      cleanedCount: cleaned.length,
    },
  };
}

/** Inserts one expiry into the min-heap used for bounded cleanup. */
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

/** Removes and returns the earliest expiry from the cleanup heap. */
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

/** Orders expiries deterministically for the cleanup min-heap. */
function compareExpiration(
  left: NonceExpiration,
  right: NonceExpiration
): number {
  if (left.expiresAt !== right.expiresAt) {
    return left.expiresAt - right.expiresAt;
  }
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}
