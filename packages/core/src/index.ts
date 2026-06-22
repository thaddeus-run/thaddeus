// @thaddeus/core — placeholder for the first substrate primitive.
//
// This is a buildable stub so the workspace graph (build, typecheck,
// type-aware lint) has something real to resolve. Replace the API below as
// the actual primitive — content-addressed objects, the operation log, the
// visibility membrane, and so on, per the Strata architecture brief — takes
// shape. The package will likely be renamed to its real primitive name then.

/** A capability-scoped handle onto the substrate. Stub. */
export interface Substrate {
  /** Human-facing label for this substrate instance. */
  readonly name: string;
  /** Returns the substrate's reported version. Stub. */
  version(): string;
}

/** Options for {@link createSubstrate}. */
export interface CreateSubstrateOptions {
  /** Optional name; defaults to "strata". */
  name?: string;
}

/**
 * Create a stub substrate handle. Does no real work yet — it exists so
 * consumers can import and the build/typecheck graph stays honest.
 */
export function createSubstrate(
  options: CreateSubstrateOptions = {}
): Substrate {
  const name = options.name ?? 'strata';
  return {
    name,
    version(): string {
      return '0.0.0';
    },
  };
}
