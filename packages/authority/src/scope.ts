import { byCodeUnit } from './codec';
import { AuthorityError } from './errors';

// The five separate authorities a credential can carry. None implies another:
// an `edit` credential cannot read, and an `integrate` credential cannot edit.
export const SCOPES = [
  'read',
  'edit',
  'execute',
  'review',
  'integrate',
] as const;
export type Scope = (typeof SCOPES)[number];

// Who a credential is for. Humans hold revocable sessions; agents and the
// service's own workers hold short-lived credentials.
export const PRINCIPAL_KINDS = ['human', 'agent', 'worker'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

// What a policy entry or a credential allows inside one repository.
export interface Grant {
  readonly repo: string;
  readonly scopes: readonly Scope[];
  // Path patterns: `**` (the whole repository), `dir/**` (everything under
  // dir/) or one exact path.
  readonly paths: readonly string[];
}

const TENANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Control characters have no place in a repository, view or path name, and
// newlines would blur the boundaries of anything printed or logged.
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Throws unless `tenant` is a lowercase slug, the only form used in keys. */
export function assertTenant(tenant: unknown): asserts tenant is string {
  if (typeof tenant !== 'string' || !TENANT_PATTERN.test(tenant)) {
    throw new AuthorityError(
      'malformed',
      'tenant must be 1-63 lowercase letters, digits or dashes'
    );
  }
}

/** Throws unless `value` is a usable repository or view name. */
export function assertName(
  what: string,
  value: unknown
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    CONTROL.test(value)
  ) {
    throw new AuthorityError(
      'malformed',
      `${what} must be 1-256 characters with no control characters`
    );
  }
}

/** True when `path` is a normalized, relative, POSIX repository path. */
function isPath(path: string): boolean {
  if (path.length === 0 || path.length > 4096 || CONTROL.test(path)) {
    return false;
  }
  if (path.startsWith('/') || path.includes('\\')) return false;
  return path
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes('*')
    );
}

/** Throws unless `pattern` is `**`, `dir/**` or an exact repository path. */
export function assertPattern(pattern: unknown): asserts pattern is string {
  if (typeof pattern !== 'string') {
    throw new AuthorityError('malformed', 'a path pattern must be a string');
  }
  if (pattern === '**') return;
  const exact = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
  if (!isPath(exact)) {
    throw new AuthorityError(
      'malformed',
      `path pattern ${JSON.stringify(pattern)} must be **, dir/** or a relative path without . or .. segments`
    );
  }
}

/** Throws unless `path` is an exact repository path (no wildcard). */
export function assertPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isPath(path)) {
    throw new AuthorityError(
      'malformed',
      `path ${JSON.stringify(path)} must be a relative path without . or .. segments`
    );
  }
}

/**
 * Says whether every path `inner` can name is also named by `outer`. Both are
 * validated patterns. `src/**` covers `src/a.ts` and `src/lib/**`, never `src`
 * itself, matching the delegated path scopes the server already enforces.
 */
export function patternCovers(outer: string, inner: string): boolean {
  if (outer === '**') return true;
  if (inner === '**') return false;
  if (outer.endsWith('/**')) {
    const prefix = outer.slice(0, -2);
    const innerBase = inner.endsWith('/**') ? inner.slice(0, -2) : inner;
    return innerBase.startsWith(prefix);
  }
  return outer === inner;
}

/** Throws unless `scope` is one of the five scopes. */
export function assertScope(scope: unknown): asserts scope is Scope {
  if (!SCOPES.includes(scope as Scope)) {
    throw new AuthorityError(
      'malformed',
      `scope must be one of ${SCOPES.join(', ')}`
    );
  }
}

/** Throws unless `kind` is human, agent or worker. */
export function assertKind(kind: unknown): asserts kind is PrincipalKind {
  if (!PRINCIPAL_KINDS.includes(kind as PrincipalKind)) {
    throw new AuthorityError(
      'malformed',
      `kind must be one of ${PRINCIPAL_KINDS.join(', ')}`
    );
  }
}

/**
 * Validates grants and returns them in one canonical order, so the same
 * authority always encodes to the same bytes when it is signed.
 */
export function canonicalGrants(grants: unknown): Grant[] {
  if (!Array.isArray(grants)) {
    throw new AuthorityError('malformed', 'grants must be an array');
  }
  const canonical = grants.map((grant: unknown): Grant => {
    if (grant === null || typeof grant !== 'object') {
      throw new AuthorityError('malformed', 'each grant must be an object');
    }
    const { repo, scopes, paths } = grant as Record<string, unknown>;
    assertName('grant repo', repo);
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new AuthorityError('malformed', 'a grant needs at least one scope');
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new AuthorityError(
        'malformed',
        'a grant needs at least one path pattern'
      );
    }
    for (const scope of scopes) assertScope(scope);
    for (const pattern of paths) assertPattern(pattern);
    return {
      repo,
      scopes: [...new Set(scopes as Scope[])].sort(byCodeUnit),
      paths: [...new Set(paths as string[])].sort(byCodeUnit),
    };
  });
  return canonical.sort((a, b) =>
    byCodeUnit(JSON.stringify(a), JSON.stringify(b))
  );
}

/** True when some grant allows `scope` in `repo` over all of `pattern`. */
export function grantsCover(
  grants: readonly Grant[],
  repo: string,
  scope: Scope,
  pattern: string
): boolean {
  return grants.some(
    (grant) =>
      grant.repo === repo &&
      grant.scopes.includes(scope) &&
      grant.paths.some((outer) => patternCovers(outer, pattern))
  );
}

/** True when everything `inner` grants is also granted by `outer`. */
export function grantsSubsume(
  outer: readonly Grant[],
  inner: readonly Grant[]
): boolean {
  return inner.every((grant) =>
    grant.scopes.every((scope) =>
      grant.paths.every((pattern) =>
        grantsCover(outer, grant.repo, scope, pattern)
      )
    )
  );
}
