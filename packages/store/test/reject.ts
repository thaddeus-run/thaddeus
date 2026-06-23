// Assert that a promise rejects — explicitly and lint-cleanly.
//
// bun:test's `expect(p).rejects.toThrow()` returns a thenable that oxlint's
// type-aware `await-thenable` rule rejects, so `await expect(...).rejects...`
// fails lint. Leaving it unawaited works (Bun fails the test if the promise
// resolves) but reads as a floating assertion. This helper awaits the real
// promise and asserts rejection (optionally of a given error type), so the
// check is unambiguous and lint-clean.
export async function expectRejects(
  promise: Promise<unknown>,
  errorType?: new (...args: never[]) => Error
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if (errorType !== undefined && !(err instanceof errorType)) {
      throw new Error(
        `expected rejection with ${errorType.name}, got: ${String(err)}`
      );
    }
    return;
  }
  throw new Error('expected promise to reject, but it resolved');
}
